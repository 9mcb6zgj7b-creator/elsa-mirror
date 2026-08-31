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
    this.model = opts.model || 'gpt-realtime';
    // 打断阈值：越高越不容易被环境噪音打断（碰桌子/关门声等）
    this.vadThreshold = opts.vadThreshold || 0.7;
    this._legacySession = false; // GA session 格式被拒时降级为 beta 格式
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

  _vadConfig() {
    return {
      type: 'server_vad',
      threshold: this.vadThreshold,      // 默认 0.5 太灵敏，碰桌子都会打断艾莎
      prefix_padding_ms: 300,
      silence_duration_ms: 800
    };
  }

  _sendSessionUpdate() {
    const session = this._legacySession
      ? { // beta 格式
          modalities: ['audio', 'text'],
          voice: this.voice,
          instructions: this.instructions,
          tools: this.tools,
          turn_detection: this._vadConfig()
        }
      : { // GA 格式
          type: 'realtime',
          instructions: this.instructions,
          tools: this.tools,
          audio: {
            input: { turn_detection: this._vadConfig() },
            output: { voice: this.voice }
          }
        };
    this._send({ type: 'session.update', session });
  }

  _send(obj) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  // 开/关麦克风（关闭时向服务器送静音，"看"的流程期间用它保证不被打断）
  setMicEnabled(on) {
    if (this.mic) this.mic.getAudioTracks().forEach(t => { t.enabled = !!on; });
    this.onDebug(on ? '恢复听麦克风' : '暂停听麦克风');
  }

  // 直发回应请求（v14 行为：不排队、不重发；撞上进行中的回复就让服务器拒绝，只记日志）
  _createResponse(resp) {
    this._send(resp ? { type: 'response.create', response: resp } : { type: 'response.create' });
    this.onDebug('发出回应请求' + (resp && resp.instructions ? '（带指令）' : ''));
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
          // v14 行为：忽略撞车（通常是服务器自动回复与我们的请求相遇），不重发不干预
          this.onDebug('回应请求撞车（已忽略）');
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
        if (ev.type === 'response.created') this.onDebug('回复开始');
        this.onSpeakingChange(true);
        this.onActivity();
        break;
      case 'output_audio_buffer.stopped':
      case 'response.done':
        this.onSpeakingChange(false);
        this.onActivity();
        if (ev.type === 'response.done') {
          this.onDebug(`回复结束（${(ev.response && ev.response.status) || '?'}）`);
          this._handleToolCalls(ev).catch(e => this.onApiError(String(e)));
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

// Gemini Live API 封装（WebSocket + PCM 音频流），与 ElsaRealtime 同接口
class GeminiRealtime {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.instructions = opts.instructions;
    this.tools = opts.tools || [];
    this.onToolCall = opts.onToolCall || (() => ({}));
    this.onSpeakingChange = opts.onSpeakingChange || (() => {});
    this.onActivity = opts.onActivity || (() => {});
    this.onError = opts.onError || console.error;
    this.onApiError = opts.onApiError || console.error;
    this.onDebug = opts.onDebug || (() => {});
    this.ws = null;
    this.mic = null;
    this._ready = false;
    this._nextT = 0;
    this._activeSources = [];
    this._lastActivityPing = 0;
    // 模型候选：新款原生语音优先，握手失败自动降级
    this._models = [
      'models/gemini-2.5-flash-native-audio-preview-09-2025',
      'models/gemini-live-2.5-flash-preview',
      'models/gemini-2.0-flash-live-001'
    ];
  }

  async connect() {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this._playCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this._playCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this._playCtx.destination);

    let lastErr;
    for (const model of this._models) {
      try {
        await this._openWs(model);
        this.onDebug(`Gemini 连接成功（${model.split('/')[1]}）`);
        this._startMicPump();
        return;
      } catch (e) {
        lastErr = e;
        this.onDebug(`Gemini 模型 ${model.split('/')[1]} 握手失败，换下一个`);
      }
    }
    throw lastErr || new Error('Gemini 所有候选模型握手失败');
  }

  _openWs(model) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`
      );
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} reject(e); } };
      const timer = setTimeout(() => fail(new Error('握手超时')), 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          setup: {
            model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
            },
            systemInstruction: { parts: [{ text: this.instructions }] },
            tools: [{
              functionDeclarations: this.tools.map(t => {
                const d = { name: t.name, description: t.description };
                // Gemini 对空 properties 的 parameters 挑剔，无参数时整个省略
                if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length) {
                  d.parameters = t.parameters;
                }
                return d;
              })
            }]
          }
        }));
      };
      ws.onmessage = async (e) => {
        const text = typeof e.data === 'string' ? e.data : await e.data.text();
        let msg;
        try { msg = JSON.parse(text); } catch (_) { return; }
        if (msg.setupComplete && !settled) {
          settled = true;
          clearTimeout(timer);
          this.ws = ws;
          this._ready = true;
          ws.onclose = () => { this._ready = false; this.onDebug('Gemini 连接关闭'); };
          resolve();
          return;
        }
        this._handleMsg(msg);
      };
      ws.onerror = () => fail(new Error('WebSocket 错误'));
      ws.onclose = (e) => fail(new Error('连接被关闭 ' + (e.code || '')));
    });
  }

  _sendJson(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async _handleMsg(msg) {
    this.onActivity();
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this._activeSources.forEach(s => { try { s.stop(); } catch (_) {} });
        this._activeSources = [];
        this._nextT = 0;
        this.onSpeakingChange(false);
        return;
      }
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const p of parts) {
        if (p.inlineData && /audio/i.test(p.inlineData.mimeType || '')) this._playChunk(p.inlineData.data);
      }
    }
    if (msg.toolCall && msg.toolCall.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        const result = await this.onToolCall(fc.name, fc.args || {});
        this._sendJson({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: result || {} }] } });
      }
    }
  }

  _playChunk(b64) {
    try {
      const bin = atob(b64);
      const n = bin.length >> 1;
      const buf = this._playCtx.createBuffer(1, n, 24000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const lo = bin.charCodeAt(2 * i), hi = bin.charCodeAt(2 * i + 1);
        let v = (hi << 8) | lo;
        if (v >= 0x8000) v -= 0x10000;
        ch[i] = v / 0x8000;
      }
      const src = this._playCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser);
      const t = Math.max(this._playCtx.currentTime + 0.05, this._nextT);
      src.start(t);
      this._nextT = t + buf.duration;
      this._activeSources.push(src);
      this.onSpeakingChange(true);
      src.onended = () => {
        this._activeSources = this._activeSources.filter(s => s !== src);
        if (!this._activeSources.length) this.onSpeakingChange(false);
      };
    } catch (e) { this.onApiError('音频块解码失败: ' + e.message); }
  }

  _startMicPump() {
    this._micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this._micCtx.createMediaStreamSource(this.mic);
    const proc = this._micCtx.createScriptProcessor(4096, 1, 1);
    const mute = this._micCtx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(this._micCtx.destination);
    proc.onaudioprocess = (e) => {
      if (!this._ready) return;
      const input = e.inputBuffer.getChannelData(0);
      // 说话活动检测（驱动闲置计时），2 秒节流
      let sum = 0;
      for (let i = 0; i < input.length; i += 16) sum += Math.abs(input[i]);
      if (sum / (input.length / 16) > 0.02 && Date.now() - this._lastActivityPing > 2000) {
        this._lastActivityPing = Date.now();
        this.onActivity();
      }
      // 降采样到 16kHz PCM16
      const ratio = e.inputBuffer.sampleRate / 16000;
      const outLen = Math.floor(input.length / ratio);
      const bytes = new Uint8Array(outLen * 2);
      for (let i = 0; i < outLen; i++) {
        let v = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        v = (v * 0x7fff) | 0;
        bytes[2 * i] = v & 0xff;
        bytes[2 * i + 1] = (v >> 8) & 0xff;
      }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      this._sendJson({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: btoa(bin) }] } });
    };
    this._micProc = proc;
  }

  setMicEnabled(on) {
    if (this.mic) this.mic.getAudioTracks().forEach(t => { t.enabled = !!on; });
    this.onDebug(on ? '恢复听麦克风' : '暂停听麦克风');
  }

  // 让艾莎按指令主动说话（打招呼、提醒、道别）
  speak(instructionText) {
    this._sendJson({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: `[系统指令，请直接照做，不要复述] ${instructionText}` }] }],
        turnComplete: true
      }
    });
    this.onDebug('发出回应请求（Gemini 指令）');
  }

  sendImage(dataUrl) {
    const b64 = dataUrl.split(',')[1] || '';
    this._sendJson({ realtimeInput: { mediaChunks: [{ mimeType: 'image/jpeg', data: b64 }] } });
    this.onDebug(`照片已发进对话（Gemini，${Math.round(b64.length / 1024)}KB）`);
  }

  getLevel() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const v of data) sum += v;
    return Math.min(1, (sum / data.length) / 90);
  }

  close() {
    this._ready = false;
    try { this._micProc && this._micProc.disconnect(); } catch (_) {}
    try { this.ws && this.ws.close(); } catch (_) {}
    try { this.mic && this.mic.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this._micCtx && this._micCtx.close(); } catch (_) {}
    try { this._playCtx && this._playCtx.close(); } catch (_) {}
    this.ws = this.mic = this.analyser = null;
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
