// OpenAI Realtime API（WebRTC）封装
// 连接 → session 配置 → 语音双向流 → 工具调用 → 主动说话
class ElsaRealtime {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.voice = opts.voice || 'marin';
    this.instructions = opts.instructions;
    this.tools = opts.tools || [];
    this.onToolCall = opts.onToolCall || (() => ({}));
    this.onSpeakingChange = opts.onSpeakingChange || (() => {});
    this.onActivity = opts.onActivity || (() => {});   // 任一方有语音活动时触发（用于闲置计时）
    this.onError = opts.onError || console.error;              // 连接级致命错误
    this.onApiError = opts.onApiError || console.error;        // 会话内非致命错误（记录但不挂断）
    this.onDebug = opts.onDebug || (() => {});                 // 事件流水（诊断用）
    this.audioEl = opts.audioEl;
    this.pc = null;
    this.dc = null;
    this.mic = null;
    this.analyser = null;
    this.model = 'gpt-realtime';
    this._legacySession = false; // GA session 格式被拒时降级为 beta 格式
    this._responseActive = false;   // 服务器是否有回复正在生成/播放
    this._pendingResponses = [];    // 排队等待的 response.create 载荷
  }

  async connect() {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    this.pc = new RTCPeerConnection();
    this.mic.getTracks().forEach(t => this.pc.addTrack(t, this.mic));

    this.pc.ontrack = (e) => {
      this.audioEl.srcObject = e.streams[0];
      this._setupAnalyser(e.streams[0]);
    };

    this.dc = this.pc.createDataChannel('oai-events');
    this.dc.onmessage = (e) => this._handleEvent(JSON.parse(e.data));
    const dcOpen = new Promise(res => { this.dc.onopen = res; });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const sdpAnswer = await this._postSdp(offer.sdp);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

    await dcOpen;
    this._sendSessionUpdate();
  }

  async _postSdp(sdp) {
    // GA 端点优先，旧端点兜底
    const urls = [
      `https://api.openai.com/v1/realtime/calls?model=${this.model}`,
      `https://api.openai.com/v1/realtime?model=${this.model}`
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/sdp' },
          body: sdp
        });
        if (resp.ok) return await resp.text();
        lastErr = new Error(`${url} → HTTP ${resp.status}: ${await resp.text()}`);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  _sendSessionUpdate() {
    const session = this._legacySession
      ? { // beta 格式
          modalities: ['audio', 'text'],
          voice: this.voice,
          instructions: this.instructions,
          tools: this.tools,
          turn_detection: { type: 'server_vad', silence_duration_ms: 700 }
        }
      : { // GA 格式
          type: 'realtime',
          instructions: this.instructions,
          tools: this.tools,
          audio: {
            input: { turn_detection: { type: 'server_vad', silence_duration_ms: 700 } },
            output: { voice: this.voice }
          }
        };
    this._send({ type: 'session.update', session });
  }

  _send(obj) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  // 请求一次回应；若已有回复在进行则排队，等它结束再发
  // （硬发会被服务器以 "already has an active response" 拒绝）
  // resp 为 null 时发不带 response 字段的裸 response.create（与 v14 工具回应格式一致）
  _createResponse(resp) {
    if (this._responseActive) {
      this._pendingResponses.push(resp);
      this.onDebug('排队回应请求（当前有回复进行中）');
      return;
    }
    this._lastResp = resp;
    this._send(resp ? { type: 'response.create', response: resp } : { type: 'response.create' });
    this.onDebug('直发回应请求' + (resp && resp.instructions ? '（带指令）' : ''));
  }

  _flushPending() {
    if (!this._responseActive && this._pendingResponses.length) {
      const resp = this._pendingResponses.shift();
      this._lastResp = resp;
      this._send(resp ? { type: 'response.create', response: resp } : { type: 'response.create' });
      this.onDebug(`重发排队的回应请求（剩余${this._pendingResponses.length}）`);
    }
  }

  // 让艾莎按指令主动说一段话（打招呼、定时提醒、道别）
  speak(instructionText) {
    this._createResponse({ instructions: instructionText });
  }

  // 把一张照片放进对话（魔镜的"眼睛"）
  sendImage(dataUrl) {
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: dataUrl }]
      }
    });
    this.onDebug(`照片已发进对话（${Math.round(dataUrl.length / 1024)}KB）`);
  }

  _handleEvent(ev) {
    switch (ev.type) {
      case 'error': {
        const msg = JSON.stringify(ev.error || {});
        // 撞上正在进行的回复：把刚才的请求重新排队，等 response.done 后自动重发
        if (/active response/i.test(msg)) {
          this._responseActive = true;
          if (this._lastResp !== undefined) { this._pendingResponses.unshift(this._lastResp); this._lastResp = undefined; }
          this.onDebug('回应请求撞车，已重新排队');
          return;
        }
        // 仅当明确是 session.update 格式问题时才降级重发一次
        if (!this._legacySession && /session/i.test(msg) && /param|invalid|unknown/i.test(msg)) {
          this._legacySession = true;
          this._sendSessionUpdate();
          return;
        }
        // 会话内错误（如某个 item 被拒）记录但不挂断对话
        this.onApiError(ev.error);
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.onActivity();
        break;
      case 'output_audio_buffer.started':
      case 'response.created':
        if (ev.type === 'response.created') { this._responseActive = true; this.onDebug('回复开始'); }
        this.onSpeakingChange(true);
        this.onActivity();
        break;
      case 'output_audio_buffer.stopped':
      case 'response.done':
        this.onSpeakingChange(false);
        this.onActivity();
        if (ev.type === 'response.done') {
          this._responseActive = false;
          this.onDebug(`回复结束（${(ev.response && ev.response.status) || '?'}）`);
          // finally：工具处理无论成败都要 flush，避免队列卡死
          this._handleToolCalls(ev).catch(e => this.onApiError(String(e))).then(() => this._flushPending());
        }
        break;
    }
  }

  async _handleToolCalls(ev) {
    const items = (ev.response && ev.response.output) || [];
    for (const item of items) {
      if (item.type !== 'function_call') continue;
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch (_) {}
      const result = await this.onToolCall(item.name, args);
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result || {})
        }
      });
      this._createResponse({});
    }
  }

  _setupAnalyser(stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser);
      this._audioCtx = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) { /* 分析器只驱动嘴型动画，失败不影响对话 */ }
  }

  // 0~1 的当前输出音量，用于驱动嘴型/光晕
  getLevel() {
    if (!this.analyser) return 0;
    if (this._audioCtx && this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const v of data) sum += v;
    return Math.min(1, (sum / data.length) / 90);
  }

  close() {
    try { this.dc && this.dc.close(); } catch (_) {}
    try { this.pc && this.pc.close(); } catch (_) {}
    try { this.mic && this.mic.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this._audioCtx && this._audioCtx.close(); } catch (_) {}
    this.pc = this.dc = this.mic = this.analyser = null;
  }
}

// 演示模式：无 API Key 时用系统语音念台词，跑通全部 UI 流程
class MockRealtime {
  constructor(opts) {
    this.onSpeakingChange = opts.onSpeakingChange || (() => {});
    this.onActivity = opts.onActivity || (() => {});
    this._lineIdx = 0;
  }
  async connect() {}
  speak(_instruction) {
    const line = MOCK_LINES[Math.min(this._lineIdx++, MOCK_LINES.length - 1)];
    this._say(line);
  }
  _say(text) {
    this.onSpeakingChange(true);
    this.onActivity();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.95;
    u.pitch = 1.15;
    const zhVoice = speechSynthesis.getVoices().find(v => v.lang.startsWith('zh'));
    if (zhVoice) u.voice = zhVoice;
    u.onend = () => { this.onSpeakingChange(false); this.onActivity(); };
    speechSynthesis.speak(u);
  }
  getLevel() { return speechSynthesis.speaking ? 0.4 + Math.random() * 0.4 : 0; }
  close() { speechSynthesis.cancel(); }
}
