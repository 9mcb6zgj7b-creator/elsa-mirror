// 艾莎魔镜 —— 主逻辑
(() => {
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

// 人设升级：家长没改过 v1 默认人设的话，自动换成带点赞规则的新版
if (cfg.persona === DEFAULT_PERSONA_V1) { cfg.persona = DEFAULT_PERSONA; saveCfg(); }

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
  return `${cfg.persona}\n\n[系统信息] 今天的读书目标是 ${cfg.booksGoal} 本，目前已读 ${todayLog().books} 本。`;
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
  name: 'mark_good_behavior',
  description: '当 Kiwi 说她做了读书之外的好事（自己刷牙、收拾玩具、帮忙家务、对人友善等）时调用，给她记一个赞',
  parameters: {
    type: 'object',
    properties: { behavior: { type: 'string', description: '她做的好事，简短中文描述' } },
    required: ['behavior']
  }
}];

function handleToolCall(name, args) {
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
    log.praises.push(String(args.behavior || '做了一件好事').slice(0, 50));
    saveCfg();
    celebrateSnow(['⭐', '✨', '💛']);
    return { praises_today: log.praises.length, behavior: args.behavior };
  }
  return {};
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

function animate() {
  const now = performance.now();
  const level = session ? session.getLevel() : 0;
  if (level > 0.05) audioLastLoudMs = now;
  const speaking = state === 'awake' && ((now - audioLastLoudMs) < 700 || eventSpeaking);
  if (speaking !== speakingShown) {
    speakingShown = speaking;
    setSpeakingVisual(speaking);
    if (state === 'awake') statusText.textContent = speaking ? '艾莎在说话…' : '艾莎在听 👂';
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
  if (!SR) return;   // 不支持则只保留拍雪花
  let rec = null, active = false, errCount = 0;
  const HOT = /艾莎|爱莎|哎莎|爱沙|艾沙|elsa|艾萨/i;

  function start() {
    if (active || state !== 'standby' || errCount > 5) return;
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
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
      errCount++;
      if (e.error === 'not-allowed') errCount = 99;   // 无麦克风权限，不再重试
    };
    // iOS 会隔一段时间自动停止识别，待机中就重新拉起
    rec.onend = () => { active = false; if (state === 'standby') setTimeout(start, 800); };
    try { rec.start(); active = true; } catch (_) { /* 已在运行等情况，忽略 */ }
  }
  function stop() {
    active = false;
    try { rec && rec.abort(); } catch (_) {}
  }
  wakeWordCtl = { start, stop };
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
  $('#cfg-persona').value = cfg.persona;
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
  $('#log-view').innerHTML = errHtml + (days.length
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
  const praises = days.flatMap(d => (d.log.praises || []).map(p => `${d.label} ${p}`));
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
  cfg.persona = $('#cfg-persona').value;
  cfg.schedule = cfg.schedule.filter(r => r.time && r.label);
  saveCfg();
  renderBookProgress();
  panel.close();
});
$('#cfg-close').addEventListener('click', () => panel.close());

// ---------- 启动 ----------
renderBookProgress();
// 演示模式提示
statusText.textContent = WAKE_HINT + (cfg.apiKey ? '' : '（演示模式）');
// iOS 上先触发一次语音列表加载
if ('speechSynthesis' in window) speechSynthesis.getVoices();
})();
