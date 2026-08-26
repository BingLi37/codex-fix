'use strict';

const el = (id) => document.getElementById(id);
const MAX_ROWS = 600;
let filter = 'all';
let startedAt = null;

// ---------- helpers ----------
function timeOf(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '--:--:--' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function durationSince(iso) {
  if (!iso) return '–';
  let s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0 || !isFinite(s)) return '–';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

function banner(kind, text) {
  const b = el('banner');
  if (!text) { b.hidden = true; return; }
  b.hidden = false;
  b.className = 'banner banner-' + kind;
  b.textContent = text;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- status ----------
async function refreshStatus() {
  let s;
  try {
    s = await (await fetch('/api/status')).json();
  } catch {
    setRunning(false, '面板已断开');
    return;
  }
  setRunning(s.running, s.running ? '正在运行' : (s.listening ? '端口被占用但无响应' : '已停止'));
  el('stateMeta').textContent = s.running
    ? `127.0.0.1:${s.proxyPort} → ${s.health?.upstream ?? ''}  PID ${s.pid ?? '?'}`
    : `127.0.0.1:${s.proxyPort} 未监听`;

  if (s.health) {
    startedAt = s.health.started;
    el('mRequests').textContent = s.health.requests ?? 0;
    el('mIds').textContent = s.health.idsFixed ?? 0;
    el('mRefs').textContent = s.health.refsFixed ?? 0;
    el('mLast').textContent = s.health.lastFix ? timeOf(s.health.lastFix) : '尚未发生';
  }
  el('mUptime').textContent = s.running ? durationSince(startedAt) : '–';

  const card = el('wiringCard');
  const c = s.codex || {};
  card.classList.toggle('card-bad', c.wired === false);
  card.classList.toggle('card-good', c.wired === true);
  el('mWiring').textContent = c.wired ? '已接入' : (c.baseUrl ? '未接入' : '读不到配置');
  el('mWiring').title = c.baseUrl ? `config.toml 中 base_url = ${c.baseUrl}` : (c.error || '');

  if (c.wired === false) {
    banner('warn', `Codex 没有走这个代理：config.toml 里 base_url 目前是 ${c.baseUrl}，应为 ${c.expected}`);
  } else if (!s.running) {
    banner('error', '代理未运行。Codex 现在无法连接模型，点上面的"启动"。');
  } else {
    banner(null);
  }
}

function setRunning(running, text) {
  el('lamp').className = 'lamp ' + (running ? 'lamp-on' : 'lamp-off');
  el('stateText').textContent = text;
  el('btnStart').disabled = running;
  el('btnStop').disabled = !running;
}

// ---------- event rendering ----------
const KIND_LABEL = {
  request: '请求', response: '响应', repair: '已修正', error: '错误', retry: '降级重试',
  listening: '已启动', stopped: '已停止', done: '完成', control: '操作', connected: '已连接',
};

function describe(e) {
  switch (e.kind) {
    case 'request': return `#${e.reqId} ${e.method} ${e.url} (${e.bytes} 字节)`;
    case 'response': return `#${e.reqId} HTTP ${e.status}${e.stream ? ' 流式' : ''}${e.viaProxy ? ' 经系统代理' : ' 直连'}`;
    case 'repair': {
      const where = { request: '发出前', stream: '流式响应中', response: '响应中' }[e.phase] || e.phase;
      let html = `#${e.reqId} 在${where}修正 ${e.ids} 个 id`;
      if (e.refs) html += `，同步 ${e.refs} 处引用`;
      for (const p of e.pairs || []) {
        html += `<span class="pair"><span class="from">${esc(p.from)}</span><span class="arrow">→</span><span class="to">${esc(p.to)}</span>${p.name ? ' · ' + esc(p.name) : ''}</span>`;
      }
      return html;
    }
    case 'error': {
      const bits = [e.where, e.code, e.status && ('HTTP ' + e.status)].filter(Boolean).join(' ');
      return `${e.reqId ? '#' + e.reqId + ' ' : ''}${esc(bits)} ${esc(e.message || (e.body || '').slice(0, 200))}`;
    }
    case 'retry': return `#${e.reqId} ${esc(e.reason)}，改为直连重试`;
    case 'listening': return `监听 127.0.0.1:${e.port} → ${esc(e.upstream)}${e.systemProxy ? '，经 ' + esc(e.systemProxy) : '，直连'}  PID ${e.pid}`;
    case 'stopped': return `进程退出 (${esc(e.reason)})  PID ${e.pid}`;
    case 'done': return `#${e.reqId} 完成${e.streamIds ? `，本次流中修正 ${e.streamIds} 个 id` : ''}`;
    case 'control': return esc(e.message || e.action || '');
    case 'connected': return '已连接到面板事件流';
    default: return esc(JSON.stringify(e));
  }
}

function matchesFilter(e) {
  if (filter === 'all') return true;
  if (filter === 'fix') return e.kind === 'repair';
  if (filter === 'error') return e.kind === 'error';
  if (filter === 'traffic') return ['request', 'response', 'done', 'retry'].includes(e.kind);
  return true;
}

function addEvent(e, atTop = false) {
  if (e.kind === 'repair' || e.kind === 'error' || e.kind === 'listening' || e.kind === 'stopped') refreshStatus();
  if (e.kind === 'error') addError(e);

  const li = document.createElement('li');
  li.className = 'k-' + e.kind;
  li.dataset.kind = e.kind;
  li.hidden = !matchesFilter(e);
  li.innerHTML = `<span class="ev-time">${timeOf(e.at)}</span>`
    + `<span class="ev-kind">${KIND_LABEL[e.kind] || esc(e.kind)}</span>`
    + `<span class="ev-body">${describe(e)}</span>`;

  const stream = el('stream');
  if (atTop) stream.appendChild(li);
  else stream.appendChild(li);
  el('streamEmpty').hidden = true;

  while (stream.children.length > MAX_ROWS) stream.removeChild(stream.firstChild);
  if (el('autoscroll').checked) stream.scrollTop = stream.scrollHeight;
}

function addError(e) {
  const box = el('errors');
  const div = document.createElement('div');
  div.className = 'err-item';
  const title = [e.where, e.code, e.status && ('HTTP ' + e.status)].filter(Boolean).join(' · ') || '错误';
  div.innerHTML = `<div class="err-when">${timeOf(e.at)}${e.reqId ? ' · 请求 #' + e.reqId : ''}</div>`
    + `<div class="err-title">${esc(title)}</div>`
    + `<pre class="err-body">${esc(e.message || '')}${e.body ? '\n\n' + esc(e.body) : ''}</pre>`;
  box.insertBefore(div, box.firstChild);
  el('errorsEmpty').hidden = true;
  while (box.children.length > 60) box.removeChild(box.lastChild);
}

function applyFilter() {
  for (const li of el('stream').children) {
    li.hidden = !matchesFilter({ kind: li.dataset.kind });
  }
}

// ---------- actions ----------
function showModal(title, body) {
  el('modalTitle').textContent = title;
  el('modalBody').textContent = body || '(无输出)';
  el('modal').showModal();
}

async function post(path, label) {
  const buttons = document.querySelectorAll('.controls .btn');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch(path, { method: 'POST' });
    const data = await r.json();
    if (data.output !== undefined) showModal(label, data.output);
    else if (!data.ok) banner('error', `${label}失败：${data.error || '未知错误'}`);
    return data;
  } catch (err) {
    banner('error', `${label}失败：${err.message}`);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    refreshStatus();
  }
}

el('btnStart').onclick = () => post('/api/start', '启动');
el('btnStop').onclick = () => post('/api/stop', '停止');
el('btnRestart').onclick = () => post('/api/restart', '重启');
el('btnSelftest').onclick = () => post('/api/selftest', '自检结果');
el('btnScan').onclick = () => post('/api/scan', '扫描结果（未改动任何文件）');
el('btnRepair').onclick = () => {
  if (confirm('将修复所有会话文件里前缀错误的 custom_tool_call id。\n原文件会先备份到 .codex\\backups。是否继续？')) {
    post('/api/scan?apply=1', '修复结果');
  }
};
el('btnClear').onclick = () => { el('stream').innerHTML = ''; el('streamEmpty').hidden = false; };
el('btnClearErrors').onclick = () => { el('errors').innerHTML = ''; el('errorsEmpty').hidden = false; };

for (const chip of document.querySelectorAll('.chip[data-filter]')) {
  chip.onclick = () => {
    document.querySelectorAll('.chip[data-filter]').forEach((c) => c.classList.remove('chip-on'));
    chip.classList.add('chip-on');
    filter = chip.dataset.filter;
    applyFilter();
  };
}

// ---------- boot ----------
(async function boot() {
  await refreshStatus();
  try {
    const { events } = await (await fetch('/api/history?limit=200')).json();
    for (const e of events) addEvent(e);
  } catch {}

  const es = new EventSource('/api/events');
  es.onmessage = (m) => { try { addEvent(JSON.parse(m.data)); } catch {} };
  es.onerror = () => { el('stateText').textContent = '面板连接中断，正在重连…'; };
  es.onopen = () => refreshStatus();

  setInterval(refreshStatus, 5000);
  setInterval(() => { if (startedAt) el('mUptime').textContent = durationSince(startedAt); }, 1000);
})();
