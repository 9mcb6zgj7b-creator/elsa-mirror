// 艾莎魔镜 —— 主逻辑
(() => {
const APP_VERSION = 'v14';   // 与 index.html 里的 ?v=N 同步升级
const STORE_KEY = 'elsa-mirror-v1';
const IDLE_TIMEOUT_MS = 90 * 1000;   // 90 秒无人说话则休眠

// ---------- 配置与记录 ----------
const DEFAULT_CFG = {
  apiKey: '',
  voice: 'marin',
  persona: DEFAULT_PERSONA,
  booksGoal: 3,
  dailyLimitMin: 60,
  schedule: [
    { time: '19:00', label: '读书时间', message: '晚饭吃完啦，我们一起读今天的三本书吧' },
    { time: '20:30', label: '刷牙时间', message: '该刷牙了，把牙齿刷得像冰晶一样亮晶晶' }
  ],
  log: {}   // { '2026-08-27': { books: 2, minutes: 13 } }
};

function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch (_) { return { ...DEFAULT_CFG }; }
}
function saveCfg() { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (_) {} }

let cfg = loadCfg();

// 人设升级：家长没改过历史默认人设的话，清空存储值，此后始终跟随最新默认版
// （personaText() 在 persona 为空时回退到 DEFAULT_PERSONA）
if (cfg.persona === DEFAULT_PERSONA_V1 || cfg.persona === DEFAULT_PERSONA_V2 || cfg.persona === DEFAULT_PERSONA) {
  cfg.persona = '';
  saveCfg();
}
function personaText() { return cfg.persona || DEFAULT_PERSONA; }

function todayKey() { return new Date().toISOString().slice(0, 10); }
function todayLog() {
  if (!cfg.log[todayKey()]) cfg.log[todayKey()] = { books: 0, minutes: 0 };
  return cfg.log[todayKey()];
}

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const mirror = $('#mirror');
const statusText = $('#status-text');
const mouthLine = $('#mouth');
const mouthOpen = $('#mouth-open');

// ---------- 视频形象 ----------
const frameEl = document.querySelector('.mirror-frame');
const vidIdle = $('#vid-idle');
const vidTalking = $('#vid-talking');
vidIdle.addEventListener('canplay', () => {
  frameEl.classList.add('has-video');
  mirror.classList.add('video-full');
  if (state === 'standby') vidIdle.pause();   // 待机画面静止省电
}, { once: true });
vidIdle.addEventListener('error', () => {
  frameEl.classList.remove('has-video');
  mirror.classList.remove('video-full');
});

function setSpeakingVisual(speaking) {
  frameEl.classList.toggle('speaking', speaking);
  if (!frameEl.classList.contains('has-video')) return;
  if (speaking) { vidTalking.currentTime = 0; vidTalking.play().catch(() => {}); }
  else vidTalking.pause();
}

// ---------- 状态机 ----------
// standby → waking → awake → (goodbye) → standby
let state = 'standby';
let session = null;
let idleTimer = null;
let sessionStartMs = 0;
let wakeWordCtl = null;   // 语音唤醒控制器（wakeWord 初始化后赋值）

const SR_OK = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const WAKE_HINT = SR_OK ? '喊"hello 艾莎"，或轻拍雪花 ❄️' : '轻拍雪花，叫醒艾莎 ❄️';

function setState(s, text) {
  state = s;
  mirror.classList.remove('standby', 'waking', 'awake');
  mirror.classList.add(s === 'awake' ? 'awake' : (s === 'waking' ? 'waking' : 'standby'));
  if (text !== undefined) statusText.textContent = text;
  // 待机时暂停视频省电，唤醒时恢复
  if (frameEl.classList.contains('has-video')) {
    if (s === 'standby') { vidIdle.pause(); vidTalking.pause(); }
    else vidIdle.play().catch(() => {});
  }
  if (s === 'standby') setSpeakingVisual(false);
  // 待机时开启语音唤醒监听，离开待机立即停止（避免和对话麦克风冲突）
  if (wakeWordCtl) {
    if (s === 'standby') setTimeout(() => wakeWordCtl.start(), 1000);
    else wakeWordCtl.stop();
  }
}

function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => sleep(true), IDLE_TIMEOUT_MS);
}

async function wake(reason) {   // reason: {type:'tap'} | {type:'reminder', label, message}
  if (state === 'awake' || state === 'waking') {
    if (reason.type === 'reminder' && session) {
      session.speak(reminderInstruction(reason.label, reason.message, progressState()));
    }
    return;
  }
  if (minutesUsedToday() >= cfg.dailyLimitMin) {
    setState('waking', '艾莎在冰雪城堡休息，明天再来玩哦 🌙');
    setTimeout(() => setState('standby', WAKE_HINT), 4000);
    return;
  }

  setState('waking', '艾莎正在赶来…');
  const Session = cfg.apiKey ? ElsaRealtime : MockRealtime;
  session = new Session({
    apiKey: cfg.apiKey,
    voice: cfg.voice,
    instructions: buildInstructions(),
    tools: TOOLS,
    audioEl: $('#remote-audio'),
    onToolCall: handleToolCall,
    onSpeakingChange: (speaking) => { eventSpeaking = speaking; },
    onActivity: bumpIdle,
    onApiError: (err) => { console.warn('realtime api error', err); recordError(err); },
    onError: (err) => {
      console.error('realtime error', err);
      recordError(err);
      setState('standby', '魔法断了一下，再拍一次雪花吧 ❄️');
      teardown();
    }
  });

  try {
    await session.connect();
  } catch (e) {
    console.error(e);
    recordError(e);
    setState('standby', cfg.apiKey ? '连不上魔法世界，请检查网络或 API Key' : WAKE_HINT);
    teardown();
    return;
  }

  sessionStartMs = Date.now();
  setState('awake', '艾莎在听 👂');
  bumpIdle();
  session.speak(reason.type === 'reminder'
    ? reminderInstruction(reason.label, reason.message, progressState())
    : greetingInstruction(progressState()));
}

function sleep(sayGoodbye) {
  if (state === 'standby') return;
  recordMinutes();
  if (sayGoodbye && session) {
    session.speak(goodbyeInstruction());
    setTimeout(() => { teardown(); setState('standby', WAKE_HINT); }, 6000);
  } else {
    teardown();
    setState('standby', WAKE_HINT);
  }
}

function teardown() {
  clearTimeout(idleTimer);
  if (session) { session.close(); session = null; }
  eventSpeaking = false;
  audioLastLoudMs = 0;
  stopCamera();
  // 对话过一次后麦克风权限大概率已授予，给语音唤醒一次重试机会
  if (wakeWordCtl) wakeWordCtl.reset();
}

// 记录最近一次连接错误，供家长面板"记录"页排查
function recordError(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || JSON.stringify(err);
  cfg.lastError = { time: new Date().toLocaleString('zh-CN'), msg: String(msg).slice(0, 300) };
  saveCfg();
}

function recordMinutes() {
  if (!sessionStartMs) return;
  todayLog().minutes += Math.round((Date.now() - sessionStartMs) / 60000);
  sessionStartMs = 0;
  saveCfg();
}
function minutesUsedToday() {
  const live = sessionStartMs ? (Date.now() - sessionStartMs) / 60000 : 0;
  return todayLog().minutes + live;
}

function buildInstructions() {
  return `${personaText()}\n\n[系统信息] 今天的读书目标是 ${cfg.booksGoal} 本，目前已读 ${todayLog().books} 本。`;
}
function progressState() {
  return { booksToday: todayLog().books, booksGoal: cfg.booksGoal };
}

// ---------- 工具（读书打卡 + 好行为点赞） ----------
const TOOLS = [{
  type: 'function',
  name: 'mark_book_read',
  description: '当 Kiwi 明确说她读完了一本书时调用，记录一次读书打卡',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string', description: '书名（如果 Kiwi 说了）' } },
    required: []
  }
}, {
  type: 'function',
  name: 'look_with_eyes',
  description: '用魔镜的眼睛（摄像头）看一眼 Kiwi 展示的东西：书页、画、玩具等。调用后照片会出现在对话里',
  parameters: { type: 'object', properties: {}, required: [] }
}, {
  type: 'function',
  name: 'print_for_kiwi',
  description: '为 Kiwi 打印内容：涂色画（coloring，她想画什么写进 subject，现场生成）、或你创作的小故事（story）/艾莎的信（letter，内容放 text）',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['coloring', 'story', 'letter'] },
      subject: { type: 'string', description: 'coloring 时必填：Kiwi 想要的画面内容，中文自由描述，如"一只独角兽在彩虹下"' },
      title: { type: 'string', description: '标题' },
      text: { type: 'string', description: 'story/letter 的完整内容' }
    },
    required: ['kind']
  }
}, {
  type: 'function',
  name: 'mark_good_behavior',
  description: '给 Kiwi 记一个赞：Kiwi 自己说她做了好事（刷牙、收拾玩具、帮忙等）时调用，家里大人让你给 Kiwi 点赞时也调用',
  parameters: {
    type: 'object',
    properties: {
      behavior: { type: 'string', description: '她做的好事，简短中文描述' },
      from: { type: 'string', description: '谁点的赞：爸爸/妈妈/爷爷/奶奶等家人称呼；Kiwi 自己说的就填"艾莎"' }
    },
    required: ['behavior']
  }
}];

async function handleToolCall(name, args) {
  const res = await doToolCall(name, args);
  cfg.lastTool = { time: new Date().toLocaleString('zh-CN'), name, info: JSON.stringify(res).slice(0, 150) };
  saveCfg();
  return res;
}

async function doToolCall(name, args) {
  if (name === 'look_with_eyes') {
    try {
      statusText.textContent = '艾莎在看… 👀';
      statusHoldUntil = performance.now() + 4000;   // 提示保持 4 秒，不被状态刷新覆盖
      const dataUrl = await captureCameraFrame();
      if (session && session.sendImage) session.sendImage(dataUrl);
      return { ok: true, note: '照片已放进对话，请根据看到的内容回应 Kiwi' };
    } catch (e) {
      return { ok: false, error: '魔镜的眼睛打不开（相机权限或设备问题）：' + (e.message || e.name) };
    } finally {
      stopCamera();   // 每拍完一张立即关闭摄像头（绿色指示灯熄灭），绝不常开
    }
  }
  if (name === 'print_for_kiwi') {
    if (args.kind === 'coloring' && cfg.apiKey) {
      // 现场绘制 Kiwi 想要的涂色画（约半分钟），画好自动弹打印窗口
      generateColoringImage(args.subject || '漂亮的大雪花')
        .then(img => {
          printForKiwi({ ...args, imageData: img });
          if (session) session.speak('涂色画画好啦，打印窗口已经弹出。告诉 Kiwi 按下屏幕上的"打印"按钮。');
        })
        .catch(e => {
          recordError(e);
          printForKiwi(args);   // 回退到内置线稿
          if (session) session.speak('刚才的魔法笔没画成，先给 Kiwi 打一张备用的涂色画，温柔地说明一下。');
        });
      return { ok: true, note: '正在绘制，约需半分钟。先告诉 Kiwi："魔法画笔正在画，等雪花转三圈就好啦"，画好后你会收到提示' };
    }
    try {
      printForKiwi(args);
      return { ok: true, note: '打印窗口已弹出，等 Kiwi 按下打印键' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  if (name === 'mark_book_read') {
    const log = todayLog();
    log.books += 1;
    saveCfg();
    renderBookProgress();
    celebrateSnow(['❄️', '✨', '💙']);
    return { books_today: log.books, goal: cfg.booksGoal, title: args.title || null };
  }
  if (name === 'mark_good_behavior') {
    const log = todayLog();
    if (!log.praises) log.praises = [];
    log.praises.push({
      by: String(args.from || '艾莎').slice(0, 12),
      what: String(args.behavior || '做了一件好事').slice(0, 50)
    });
    saveCfg();
    celebrateSnow(['⭐', '✨', '💛']);
    return { praises_today: log.praises.length, behavior: args.behavior, from: args.from || '艾莎' };
  }
  return {};
}

// ---------- 魔镜的眼睛（摄像头拍照） ----------
let camStream = null;
const camVideo = $('#cam');

async function captureCameraFrame() {
  if (!camStream) {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 } }
    });
    camVideo.srcObject = camStream;
    await camVideo.play();
    await new Promise(r => setTimeout(r, 700));   // 等曝光稳定
  }
  const w = camVideo.videoWidth, h = camVideo.videoHeight;
  if (!w || !h) throw new Error('相机画面为空');
  const scale = Math.min(1, 1024 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(camVideo, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
    camVideo.srcObject = null;
  }
}

// ---------- 打印（AirPrint） ----------
// 用画图模型现场生成涂色线稿
async function generateColoringImage(subject) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `Simple coloring book page for a young child: ${subject}. Thick clean black outlines only, no shading, no color fill, pure white background, cute friendly style, large simple shapes that are easy for a toddler to color.`,
      size: '1024x1536',
      quality: 'low'
    })
  });
  if (!r.ok) throw new Error(`涂色画生成失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return 'data:image/png;base64,' + j.data[0].b64_json;
}

const COLORING_SVGS = {
  snowflake: `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round">
    <g transform="translate(200,200)">
      <g id="arm"><path d="M0 0 V-160 M0 -50 L-28 -78 M0 -50 L28 -78 M0 -100 L-24 -124 M0 -100 L24 -124 M0 -140 L-14 -154 M0 -140 L14 -154"/></g>
      <use href="#arm" transform="rotate(60)"/><use href="#arm" transform="rotate(120)"/>
      <use href="#arm" transform="rotate(180)"/><use href="#arm" transform="rotate(240)"/><use href="#arm" transform="rotate(300)"/>
      <circle r="22"/><circle r="10"/>
    </g></svg>`,
  castle: `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#000" stroke-width="4" stroke-linejoin="round">
    <rect x="60" y="200" width="80" height="160"/><rect x="260" y="200" width="80" height="160"/>
    <rect x="140" y="240" width="120" height="120"/>
    <path d="M60 200 L100 130 L140 200 Z M260 200 L300 130 L340 200 Z"/>
    <rect x="170" y="140" width="60" height="100"/><path d="M170 140 L200 80 L230 140 Z"/>
    <path d="M200 80 L200 50 L230 60 L200 68"/>
    <rect x="185" y="300" width="30" height="60" rx="15"/>
    <circle cx="100" cy="230" r="10"/><circle cx="300" cy="230" r="10"/><circle cx="200" cy="180" r="10"/>
    <path d="M20 360 H380"/></svg>`,
  snowman: `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round">
    <circle cx="200" cy="120" r="55"/><circle cx="200" cy="240" r="80" />
    <path d="M148 100 H252 M160 66 h80 v-40 h-80 Z"/>
    <circle cx="182" cy="112" r="5" fill="#000"/><circle cx="218" cy="112" r="5" fill="#000"/>
    <path d="M200 126 l26 8 l-26 8 Z"/>
    <circle cx="200" cy="215" r="6" fill="#000"/><circle cx="200" cy="245" r="6" fill="#000"/><circle cx="200" cy="275" r="6" fill="#000"/>
    <path d="M130 200 L80 160 M80 160 l-16 -6 M80 160 l-4 -16 M270 200 L320 160 M320 160 l16 -6 M320 160 l4 -16"/>
    <path d="M40 350 H360"/></svg>`
};

function buildPrintHtml(args) {
  const title = args.title || (args.kind === 'coloring' ? '艾莎送你的涂色画' : args.kind === 'letter' ? '艾莎的信' : '艾莎的小故事');
  const body = args.kind === 'coloring'
    ? (args.imageData
        ? `<img src="${args.imageData}" style="width:100%">`
        : `<div style="width:100%">${COLORING_SVGS[args.theme] || COLORING_SVGS.snowflake}</div>`)
    : `<div style="font-size:22px;line-height:2;white-space:pre-wrap">${String(args.text || '').replace(/</g, '&lt;')}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:40px;color:#000">
    <div style="text-align:center;font-size:30px;margin-bottom:8px">❄️ ${title} ❄️</div>
    <div style="text-align:center;font-size:14px;color:#666;margin-bottom:24px">来自魔镜里的艾莎 · 送给 Kiwi</div>
    ${body}
  </body></html>`;
}

function printForKiwi(args) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  document.body.appendChild(f);
  f.onload = () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch (_) {}
    setTimeout(() => f.remove(), 60000);
  };
  f.srcdoc = buildPrintHtml(args);
}

// ---------- 读书进度与庆祝 ----------
function renderBookProgress() {
  const el = $('#book-progress');
  const n = todayLog().books;
  el.innerHTML = '';
  for (let i = 0; i < cfg.booksGoal; i++) {
    const flake = document.createElement('span');
    flake.className = 'flake' + (i < n ? ' earned' : '');
    flake.textContent = '❄️';
    el.appendChild(flake);
  }
}

function celebrateSnow(chars = ['❄️', '✨', '💙']) {
  const layer = $('#celebrate');
  for (let i = 0; i < 24; i++) {
    const b = document.createElement('span');
    b.className = 'burst';
    b.textContent = chars[i % chars.length];
    b.style.left = '50%';
    b.style.top = '55%';
    b.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}vw`);
    b.style.setProperty('--dy', `${(Math.random() - 0.8) * 70}vh`);
    layer.appendChild(b);
    setTimeout(() => b.remove(), 1700);
  }
}

// ---------- 定时提醒 ----------
const firedToday = new Set();
setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayKey = todayKey();
  for (const r of cfg.schedule) {
    const fireKey = `${dayKey}|${r.time}`;
    if (r.time === hhmm && !firedToday.has(fireKey)) {
      firedToday.add(fireKey);
      wake({ type: 'reminder', label: r.label, message: r.message });
    }
  }
  // 超时守卫：对话中达到每日上限则道别
  if (state === 'awake' && minutesUsedToday() >= cfg.dailyLimitMin) sleep(true);
}, 20 * 1000);

// ---------- 说话状态与嘴型/光晕动画 ----------
// 说话视频的切换以"实际播放音量"为准（事件信号只作辅助）：
// API 的 response.done 会在音频播完前提前到达，纯事件驱动会导致说话时画面提前切回聆听
let eventSpeaking = false;
let audioLastLoudMs = 0;
let speakingShown = false;
let statusHoldUntil = 0;   // 在此时间点前，animate 不覆盖状态文字（用于"艾莎在看"等提示）

function animate() {
  const now = performance.now();
  const level = session ? session.getLevel() : 0;
  if (level > 0.05) audioLastLoudMs = now;
  const speaking = state === 'awake' && ((now - audioLastLoudMs) < 700 || eventSpeaking);
  if (speaking !== speakingShown) {
    speakingShown = speaking;
    setSpeakingVisual(speaking);
    if (state === 'awake' && now >= statusHoldUntil) {
      statusText.textContent = speaking ? '艾莎在说话…' : '艾莎在听 👂';
    }
  }
  const open = Math.min(10, level * 14);
  mouthOpen.setAttribute('ry', String(open));
  mouthOpen.setAttribute('opacity', open > 1.5 ? '1' : '0');
  mouthLine.setAttribute('opacity', open > 1.5 ? '0' : '1');
  document.querySelector('.mirror-glow').style.setProperty('--glow-scale', String(1 + level * 0.12));
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ---------- 雪花背景 ----------
(function snow() {
  const canvas = $('#snow');
  const ctx = canvas.getContext('2d');
  let flakes = [];
  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    flakes = Array.from({ length: Math.floor(innerWidth / 14) }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: 1 + Math.random() * 2.4,
      vy: 0.3 + Math.random() * 0.8,
      vx: (Math.random() - 0.5) * 0.4,
      a: 0.25 + Math.random() * 0.55
    }));
  }
  addEventListener('resize', resize);
  resize();
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dim = state === 'standby' ? 0.4 : 1;
    for (const f of flakes) {
      f.y += f.vy; f.x += f.vx;
      if (f.y > canvas.height + 4) { f.y = -4; f.x = Math.random() * canvas.width; }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(210, 235, 255, ${f.a * dim})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
})();

// ---------- 语音唤醒（"hello 艾莎"） ----------
(function wakeWord() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const diagInfo = { sr: !!SR, standalone: !!navigator.standalone, errCount: 0, lastErr: '', listening: false };
  if (!SR) { wakeWordCtl = { start() {}, stop() {}, reset() {}, diag: () => diagInfo }; return; }
  let rec = null, active = false;
  const HOT = /艾莎|爱莎|哎莎|爱沙|艾沙|elsa|艾萨/i;

  function start() {
    if (active || state !== 'standby' || diagInfo.errCount > 5) return;
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      diagInfo.listening = true;
      if (state === 'standby') statusText.textContent = '👂 喊"hello 艾莎"，或轻拍雪花 ❄️';
    };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (HOT.test(e.results[i][0].transcript)) {
          stop();
          wake({ type: 'tap' });
          return;
        }
      }
    };
    rec.onerror = (e) => {
      diagInfo.errCount++;
      diagInfo.lastErr = e.error || 'unknown';
      // 无权限时先放弃；对话过一次（授权后）teardown 会 reset 再试
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') diagInfo.errCount = 99;
    };
    // iOS 会隔一段时间自动停止识别，待机中就重新拉起
    rec.onend = () => {
      active = false;
      diagInfo.listening = false;
      if (state === 'standby') setTimeout(start, 800);
    };
    try { rec.start(); active = true; } catch (_) { /* 已在运行等情况，忽略 */ }
  }
  function stop() {
    active = false;
    diagInfo.listening = false;
    try { rec && rec.abort(); } catch (_) {}
  }
  function reset() { diagInfo.errCount = 0; }
  wakeWordCtl = { start, stop, reset, diag: () => diagInfo };
  setTimeout(start, 1500);
})();

// ---------- 交互 ----------
$('#wake-btn').addEventListener('click', () => {
  if (state === 'standby') wake({ type: 'tap' });
  else sleep(false);   // 对话中再拍一次 = 直接休眠（家长快捷操作）
});

// 家长入口：左上角长按 3 秒
(function parentGate() {
  let timer = null;
  const corner = $('#parent-corner');
  const start = () => {
    corner.classList.add('holding');
    timer = setTimeout(() => { corner.classList.remove('holding'); openPanel(); }, 3000);
  };
  const cancel = () => { corner.classList.remove('holding'); clearTimeout(timer); };
  corner.addEventListener('touchstart', start);
  corner.addEventListener('mousedown', start);
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(e => corner.addEventListener(e, cancel));
  // 桌面快捷键：按 P 直接打开（iPad 无键盘，不影响防误触）
  addEventListener('keydown', (e) => {
    if ((e.key === 'p' || e.key === 'P') && !panel.open) openPanel();
  });
})();

// ---------- 家长面板 ----------
const panel = $('#parent-panel');

function openPanel() {
  sleep(false);
  $('#cfg-key').value = cfg.apiKey;
  $('#cfg-voice').value = cfg.voice;
  $('#cfg-books').value = cfg.booksGoal;
  $('#cfg-limit').value = cfg.dailyLimitMin;
  $('#cfg-persona').value = personaText();
  renderScheduleEditor();
  renderLog();
  renderReport();
  panel.showModal();
}

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#parent-panel section').forEach(s =>
      s.classList.toggle('active', s.dataset.panel === btn.dataset.tab));
  });
});

function renderScheduleEditor() {
  const list = $('#schedule-list');
  list.innerHTML = '';
  cfg.schedule.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'reminder-row';
    row.innerHTML = `
      <input type="time" value="${r.time}" data-i="${i}" data-f="time">
      <input type="text" value="${r.label}" placeholder="名称" data-i="${i}" data-f="label">
      <input type="text" value="${r.message}" placeholder="提醒内容" data-i="${i}" data-f="message">
      <button class="del" data-i="${i}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('input').forEach(inp =>
    inp.addEventListener('change', () => { cfg.schedule[+inp.dataset.i][inp.dataset.f] = inp.value; }));
  list.querySelectorAll('.del').forEach(btn =>
    btn.addEventListener('click', () => { cfg.schedule.splice(+btn.dataset.i, 1); renderScheduleEditor(); }));
}

$('#add-reminder').addEventListener('click', () => {
  cfg.schedule.push({ time: '19:00', label: '', message: '' });
  renderScheduleEditor();
});

function renderLog() {
  const days = Object.keys(cfg.log).sort().reverse().slice(0, 14);
  const errHtml = cfg.lastError
    ? `<div class="log-day">⚠️ 最近一次连接错误（${cfg.lastError.time}）：<br>${cfg.lastError.msg}</div>`
    : '';
  const d = wakeWordCtl ? wakeWordCtl.diag() : {};
  const wakeHtml = `<div class="log-day">🎙 语音唤醒诊断：识别接口${d.sr ? '✅支持' : '❌不支持'} · 主屏幕模式${d.standalone ? '是' : '否'} · 正在监听${d.listening ? '✅' : '❌'} · 错误${d.errCount || 0}次${d.lastErr ? '（最近：' + d.lastErr + '）' : ''}</div>`;
  const toolHtml = cfg.lastTool
    ? `<div class="log-day">🔧 最近一次工具调用（${cfg.lastTool.time}）：${cfg.lastTool.name}<br>${String(cfg.lastTool.info).replace(/</g, '&lt;')}</div>`
    : '';
  $('#log-view').innerHTML = wakeHtml + toolHtml + errHtml + (days.length
    ? days.map(d => {
        const l = cfg.log[d];
        return `<div class="log-day">${d} — 读书 ${l.books}/${cfg.booksGoal} 本 · 对话 ${l.minutes} 分钟</div>`;
      }).join('')
    : '<p class="hint">还没有对话记录，等 Kiwi 玩起来就有了。</p>');
}

// 测试 API Key：验证 Key 有效性和网络连通，不发起真实对话
$('#key-test').addEventListener('click', async () => {
  const key = $('#cfg-key').value.trim();
  const out = $('#key-test-result');
  if (!key) { out.textContent = '请先在上面填入 Key'; return; }
  out.textContent = '测试中…';
  try {
    const r = await fetch('https://api.openai.com/v1/models?limit=1', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (r.ok) out.textContent = '✅ Key 有效、网络通畅，保存后拍雪花即可对话';
    else if (r.status === 401) out.textContent = '❌ Key 无效：请检查是否复制完整、或已被删除';
    else if (r.status === 429) out.textContent = '❌ 账户额度不足：请到 platform.openai.com 充值';
    else out.textContent = `❌ 测试失败（HTTP ${r.status}），把这个数字告诉 Claude`;
  } catch (e) {
    out.textContent = '❌ 网络不通：' + e.message;
  }
});

// ---------- 每周报告 ----------
function weekData() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, log: cfg.log[key] || { books: 0, minutes: 0 } });
  }
  return days;
}

function buildReportText() {
  const days = weekData();
  const books = days.reduce((s, d) => s + (d.log.books || 0), 0);
  const minutes = days.reduce((s, d) => s + (d.log.minutes || 0), 0);
  const goalDays = days.filter(d => (d.log.books || 0) >= cfg.booksGoal).length;
  // 兼容旧格式（纯字符串）与新格式（{by, what}）
  const praises = days.flatMap(d => (d.log.praises || []).map(p =>
    typeof p === 'string' ? `${d.label} ${p}` : `${d.label} ${p.what}（${p.by} 点的赞）`));
  const range = `${days[0].label}–${days[6].label}`;

  let text = `❄️ Kiwi 的一周小报告（${range}）\n\n`;
  text += `📖 读书 ${books} 本，${goalDays} 天完成了每日 ${cfg.booksGoal} 本的目标\n`;
  text += `💬 和艾莎聊了 ${minutes} 分钟\n`;
  text += `⭐ 收到 ${praises.length} 个赞${praises.length ? '：' : ''}\n`;
  praises.forEach(p => { text += `   ⭐ ${p}\n`; });
  text += `\n艾莎说：${books >= cfg.booksGoal * 5
    ? 'Kiwi 这周像小雪花一样闪闪发光，冰雪城堡都为她亮灯啦！✨'
    : praises.length || books
      ? 'Kiwi 每天都在一点点进步，艾莎为她骄傲！💙'
      : '新的一周，艾莎在魔镜里等 Kiwi 来集雪花哦～'}`;
  return text;
}

function renderReport() {
  $('#report-view').innerHTML = buildReportText()
    .split('\n')
    .map(line => `<div class="log-day" style="border:none;padding:2px 0">${line || '&nbsp;'}</div>`)
    .join('');
}

$('#report-share').addEventListener('click', async () => {
  const text = buildReportText();
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); $('#report-share').textContent = '已复制，去粘贴给家人吧 ✅'; }
  } catch (_) { /* 用户取消分享 */ }
});

$('#persona-reset').addEventListener('click', () => { $('#cfg-persona').value = DEFAULT_PERSONA; });

$('#cfg-save').addEventListener('click', () => {
  cfg.apiKey = $('#cfg-key').value.trim();
  cfg.voice = $('#cfg-voice').value;
  cfg.booksGoal = Math.max(1, +$('#cfg-books').value || 3);
  cfg.dailyLimitMin = Math.max(5, +$('#cfg-limit').value || 60);
  // 与当前默认人设一致就存空值，这样以后升级默认人设能自动跟随
  cfg.persona = $('#cfg-persona').value === DEFAULT_PERSONA ? '' : $('#cfg-persona').value;
  cfg.schedule = cfg.schedule.filter(r => r.time && r.label);
  saveCfg();
  renderBookProgress();
  panel.close();
});
$('#cfg-close').addEventListener('click', () => panel.close());

// ---------- 启动 ----------
document.querySelector('#app-version').textContent = APP_VERSION;
renderBookProgress();
// 演示模式提示
statusText.textContent = WAKE_HINT + (cfg.apiKey ? '' : '（演示模式）');
// iOS 上先触发一次语音列表加载
if ('speechSynthesis' in window) speechSynthesis.getVoices();
})();
