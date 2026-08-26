// Control panel for the Codex id-sanitizing proxy.
// Serves the dashboard, starts/stops the proxy, and streams its event feed to
// the browser over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODEX_HOME, activeRelay, readRelayConfig, writeRelayConfig } from './relay-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PORT = Number(process.env.CODEX_PANEL_PORT || 7800);
const PROXY_PORT = Number(process.env.CODEX_ID_PROXY_PORT || 7801);
const PROXY_SCRIPT = path.join(HERE, 'id-sanitizing-proxy.mjs');
const LOG_DIR = path.join(HERE, 'logs');
const EVENT_LOG = path.join(LOG_DIR, 'events.jsonl');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
const SYSTEM_PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- panel's own event feed ----------
const clients = new Set();

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch {}
  }
}

function panelEvent(kind, level, data = {}) {
  const event = { at: new Date().toISOString(), kind, level, source: 'panel', ...data };
  // Only append. The tail poller picks it up and broadcasts it once, which also
  // keeps start/stop actions visible after a page reload.
  try { fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n'); } catch { broadcast(event); }
  return event;
}

// ---------- proxy process control ----------
function findProxyPid() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        if (!new RegExp(`[:.]${PROXY_PORT}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (/^\d+$/.test(pid)) return resolve(Number(pid));
      }
      resolve(null);
    });
  });
}

function health(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PROXY_PORT, path: '/__id_proxy_health', timeout: timeoutMs },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function startProxy() {
  const existing = await health();
  if (existing) return { ok: true, already: true, health: existing };

  const out = fs.openSync(path.join(LOG_DIR, 'proxy-stdout.log'), 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, HTTPS_PROXY: SYSTEM_PROXY, CODEX_ID_PROXY_PORT: String(PROXY_PORT) },
  });
  child.unref();
  panelEvent('control', 'info', { action: 'start', pid: child.pid, message: `正在启动代理（PID ${child.pid}）` });

  // Wait for it to actually answer, so the UI never claims a false success.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await health(1000);
    if (h) return { ok: true, health: h, pid: child.pid };
  }
  const tail = readEvents(30).filter((e) => e.level === 'error').slice(-1)[0];
  return { ok: false, error: tail?.message || '代理启动后没有响应健康检查，请查看事件流', pid: child.pid };
}

async function stopProxy() {
  const pid = await findProxyPid();
  if (!pid) return { ok: true, already: true };
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, async (err, stdout, stderr) => {
      if (err) {
        panelEvent('control', 'error', { action: 'stop', pid, message: stderr || err.message });
        return resolve({ ok: false, error: stderr || err.message });
      }
      panelEvent('control', 'warn', { action: 'stop', pid, message: `已停止代理（PID ${pid}）` });
      // taskkill returns before the port is released.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150));
        if (!(await findProxyPid())) break;
      }
      resolve({ ok: true, pid });
    });
  });
}

// ---------- reading state ----------
function readEvents(limit = 400) {
  try {
    const lines = fs.readFileSync(EVENT_LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Confirms Codex is actually pointed at the proxy; a stale base_url is the most
// likely reason the panel looks healthy while nothing flows through it.
function readCodexConfig() {
  try {
    const text = fs.readFileSync(CODEX_CONFIG, 'utf8');
    const match = text.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
    const baseUrl = match ? match[1] : null;
    const expected = `http://127.0.0.1:${PROXY_PORT}/v1`;
    return { baseUrl, expected, wired: baseUrl === expected, path: CODEX_CONFIG };
  } catch (e) {
    return { baseUrl: null, error: e.message, path: CODEX_CONFIG };
  }
}

// The key itself is never sent to the browser, only whether one is set.
function publicRelays() {
  const config = readRelayConfig();
  return {
    active: config.active,
    // A fallback means relays.json was absent, empty, or unparseable, so the
    // list below is a built-in default rather than what the user configured.
    relayFallback: config.fallback ?? null,
    relays: config.relays.map((r) => ({
      id: r.id, name: r.name || r.id, baseUrl: r.baseUrl, hasApiKey: Boolean(r.apiKey),
    })),
  };
}

async function status() {
  const [pid, h] = await Promise.all([findProxyPid(), health()]);
  return {
    running: Boolean(h),
    listening: Boolean(pid),
    pid,
    health: h,
    proxyPort: PROXY_PORT,
    panelPort: PANEL_PORT,
    systemProxy: SYSTEM_PROXY,
    codex: readCodexConfig(),
    ...publicRelays(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function validateRelay(relay, existing, { requireKeyField = true } = {}) {
  if (!relay || typeof relay !== 'object') return '请求内容无法解析';
  const name = String(relay.name ?? '').trim();
  const baseUrl = String(relay.baseUrl ?? '').trim();
  if (!name) return '请填写名称';
  if (!baseUrl) return '请填写 Base URL';
  let url;
  try { url = new URL(baseUrl); } catch { return 'Base URL 格式不对，需要以 http:// 或 https:// 开头'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Base URL 只支持 http 或 https';
  // Pointing a relay at the proxy or the panel would loop or hit the wrong server.
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (isLoopback && Number(url.port) === PROXY_PORT) {
    return 'Base URL 不能指向代理自己，会形成死循环';
  }
  if (isLoopback && Number(url.port) === PANEL_PORT) {
    return 'Base URL 不能指向控制面板自己';
  }
  // A non-ASCII name slugs to nothing, so number the fallback id instead of
  // letting every such relay collide on the same default.
  let id = relay.id;
  if (!id) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    id = slug || 'relay';
    if (existing.some((r) => r.id === id)) {
      let n = 2;
      while (existing.some((r) => r.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
  }
  if (existing.some((r) => r.id === id && r.id !== relay.id)) return `已存在同名中转站：${id}`;
  return { id, name, baseUrl, apiKey: requireKeyField ? (relay.apiKey ?? '') : undefined };
}

// ---------- tail the proxy's event log and push to browsers ----------
let tailOffset = 0;
let tailRemainder = '';

function primeTail() {
  try { tailOffset = fs.statSync(EVENT_LOG).size; } catch { tailOffset = 0; }
}

function pollEventLog() {
  let size;
  try { size = fs.statSync(EVENT_LOG).size; } catch { return; }
  if (size < tailOffset) { tailOffset = 0; tailRemainder = ''; } // file was trimmed
  if (size === tailOffset) return;
  const fd = fs.openSync(EVENT_LOG, 'r');
  try {
    const buf = Buffer.alloc(size - tailOffset);
    fs.readSync(fd, buf, 0, buf.length, tailOffset);
    tailOffset = size;
    tailRemainder += buf.toString('utf8');
    const lines = tailRemainder.split('\n');
    tailRemainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        broadcast({ source: 'proxy', ...parsed });
      } catch {}
    }
  } finally { fs.closeSync(fd); }
}

// ---------- running the bundled tools ----------
function runNode(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: HERE, timeout: timeoutMs, windowsHide: true, maxBuffer: 12 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout, stderr: stderr || (err ? err.message : '') }));
  });
}

// Runs the dashboard's own test suite via its local vitest install.
function runUi(timeoutMs = 180000) {
  const vitest = path.join(HERE, 'ui', 'node_modules', 'vitest', 'vitest.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [vitest, 'run'],
      { cwd: path.join(HERE, 'ui'), timeout: timeoutMs, windowsHide: true, maxBuffer: 12 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') }));
  });
}

// ---------- relay connectivity probe ----------
// Goes through the proxy's own upstream path so the result reflects how real
// traffic will travel, including the system-proxy tunnel.
function probeRelay(relay) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(relay.baseUrl.replace(/\/+$/, '') + '/models'); }
    catch { return resolve({ ok: false, summary: 'Base URL 格式不对', detail: 'Base URL 无法解析' }); }

    const child = spawn(process.execPath, [path.join(HERE, 'relay-probe.mjs')], {
      windowsHide: true,
      env: {
        ...process.env,
        HTTPS_PROXY: SYSTEM_PROXY,
        PROBE_URL: url.toString(),
        PROBE_KEY: relay.apiKey || '',
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', () => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { parsed = null; }
      if (!parsed) {
        return resolve({ ok: false, summary: '探测失败', detail: out || '没有输出' });
      }
      // 401 still proves the relay is reachable; it only means the key is wrong
      // or absent, which is expected when Codex supplies the key instead.
      const reachable = parsed.status > 0;
      const summary = reachable ? `HTTP ${parsed.status}` : (parsed.error || '连接失败');
      const lines = [
        `目标: ${url.toString()}`,
        `经系统代理: ${parsed.viaProxy ? '是' : '否'}`,
        `结果: ${summary}`,
        parsed.status === 401 ? '（401 表示能连通但这个 key 无效；如果这个中转站留空 key、由 Codex 提供，那是正常的）' : '',
        parsed.body ? `\n响应片段:\n${parsed.body}` : '',
        parsed.error ? `\n错误: ${parsed.error}` : '',
      ].filter(Boolean);
      resolve({ ok: reachable, summary, detail: lines.join('\n') });
    });
  });
}

// ---------- static assets ----------
// The HeroUI dashboard is a built Vite bundle in ui/dist. If that build is
// missing, fall back to the dependency-free dashboard so the proxy can still
// be controlled.
const UI_DIST = path.join(HERE, 'ui', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(route, res) {
  const builtIndex = path.join(UI_DIST, 'index.html');
  const hasBuild = fs.existsSync(builtIndex);

  let file;
  if (route === '/') {
    file = hasBuild ? builtIndex : path.join(HERE, 'dashboard-fallback.html');
  } else if (hasBuild && (route.startsWith('/assets/') || route.startsWith('/fonts/')
      || route.startsWith('/images/'))) {
    // Confine resolution to the build directory.
    const resolved = path.resolve(UI_DIST, '.' + route);
    if (!resolved.startsWith(path.resolve(UI_DIST))) return false;
    file = resolved;
  } else if (route === '/dashboard-fallback.js' || route === '/dashboard-fallback.css') {
    file = path.join(HERE, route.slice(1));
  } else {
    return false;
  }

  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const immutable = route.startsWith('/assets/') || route.startsWith('/fonts/');
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
  return true;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  if (route === '/' || route.startsWith('/assets/') || route.startsWith('/fonts/')
      || route.startsWith('/images/') || route.startsWith('/dashboard-fallback')) {
    if (serveStatic(route, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('界面文件缺失。请在 ui 目录运行 npm install && npx vite build');
    return;
  }

  if (route === '/api/status') return sendJson(res, 200, await status());
  if (route === '/api/relays') return sendJson(res, 200, publicRelays());

  // Switching relays takes effect on the next request; the proxy re-reads
  // relays.json each time, so no restart is needed.
  if (req.method === 'POST' && route === '/api/relays/activate') {
    const body = await readJsonBody(req);
    const config = readRelayConfig();
    const target = config.relays.find((r) => r.id === body?.id);
    if (!target) return sendJson(res, 400, { ok: false, error: '找不到这个中转站' });
    writeRelayConfig({ ...config, active: target.id });
    panelEvent('control', 'info', { action: 'relay', message: `已切换到中转站：${target.name}（${target.baseUrl}）` });
    return sendJson(res, 200, { ok: true, ...publicRelays() });
  }

  if (req.method === 'POST' && route === '/api/relays/save') {
    const body = await readJsonBody(req);
    const config = readRelayConfig();
    const checked = validateRelay(body, config.relays);
    if (typeof checked === 'string') return sendJson(res, 400, { ok: false, error: checked });

    const index = config.relays.findIndex((r) => r.id === body.id);
    const relays = [...config.relays];
    if (index === -1) {
      relays.push({ ...checked, apiKey: checked.apiKey || '' });
    } else {
      // An empty key field means "leave the stored key alone".
      const keptKey = body.apiKey === '' ? relays[index].apiKey : checked.apiKey;
      relays[index] = { ...checked, apiKey: keptKey || '' };
    }
    const active = body.activate ? checked.id : config.active;
    writeRelayConfig({ active, relays });
    panelEvent('control', 'info', {
      action: 'relay',
      message: index === -1 ? `已添加中转站：${checked.name}` : `已更新中转站：${checked.name}`,
    });
    return sendJson(res, 200, { ok: true, ...publicRelays() });
  }

  if (req.method === 'POST' && route === '/api/relays/delete') {
    const body = await readJsonBody(req);
    const config = readRelayConfig();
    if (config.relays.length <= 1) return sendJson(res, 400, { ok: false, error: '至少要保留一个中转站' });
    const target = config.relays.find((r) => r.id === body?.id);
    if (!target) return sendJson(res, 400, { ok: false, error: '找不到这个中转站' });
    const relays = config.relays.filter((r) => r.id !== target.id);
    const active = config.active === target.id ? relays[0].id : config.active;
    writeRelayConfig({ active, relays });
    panelEvent('control', 'warn', { action: 'relay', message: `已删除中转站：${target.name}` });
    return sendJson(res, 200, { ok: true, ...publicRelays() });
  }

  // Sends a real request to a relay so a bad URL or key surfaces before you
  // rely on it for actual work.
  if (req.method === 'POST' && route === '/api/relays/test') {
    const body = await readJsonBody(req);
    const config = readRelayConfig();
    const target = config.relays.find((r) => r.id === body?.id) ?? activeRelay(config);
    const result = await probeRelay(target);
    panelEvent('control', result.ok ? 'info' : 'error', {
      action: 'relay', message: `连通性测试 ${target.name}：${result.summary}`,
    });
    return sendJson(res, 200, { ok: result.ok, output: result.detail });
  }
  if (route === '/api/history') return sendJson(res, 200, { events: readEvents(Number(url.searchParams.get('limit') || 400)) });

  if (route === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), kind: 'connected', level: 'info', source: 'panel' })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && route === '/api/start') {
    const result = await startProxy();
    if (!result.ok) panelEvent('control', 'error', { action: 'start', message: result.error });
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  if (req.method === 'POST' && route === '/api/stop') {
    const result = await stopProxy();
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  if (req.method === 'POST' && route === '/api/restart') {
    await stopProxy();
    const result = await startProxy();
    panelEvent('control', result.ok ? 'info' : 'error', {
      action: 'restart',
      message: result.ok ? '代理已重启' : `重启失败：${result.error}`,
    });
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  if (req.method === 'POST' && route === '/api/selftest') {
    // Two suites take ~40s. Each stage is announced so the event feed shows
    // progress instead of going silent.
    panelEvent('control', 'info', { action: 'selftest', message: '开始运行自检（共 2 项）' });
    panelEvent('control', 'info', { action: 'selftest', message: '1/2 正在跑代理逻辑测试…' });
    const proxyRun = await runNode(['id-sanitizing-proxy.test.mjs']);
    const proxyPassed = /all tests passed/.test(proxyRun.stdout);
    panelEvent('control', proxyPassed ? 'info' : 'error', {
      action: 'selftest', message: proxyPassed ? '1/2 代理逻辑测试通过' : '1/2 代理逻辑测试失败',
    });

    // The UI suite needs its dev dependencies; skip it rather than fail when
    // ui/node_modules has not been installed.
    const uiInstalled = fs.existsSync(path.join(HERE, 'ui', 'node_modules', 'vitest'));
    let uiOutput = '（未安装 ui 依赖，跳过界面测试）';
    let uiPassed = true;
    if (uiInstalled) {
      panelEvent('control', 'info', { action: 'selftest', message: '2/2 正在跑界面测试…' });
      const uiRun = await runUi();
      uiOutput = uiRun.stdout + (uiRun.stderr ? '\n' + uiRun.stderr : '');
      uiPassed = uiRun.ok;
      panelEvent('control', uiPassed ? 'info' : 'error', {
        action: 'selftest', message: uiPassed ? '2/2 界面测试通过' : '2/2 界面测试失败',
      });
    }

    const passed = proxyPassed && uiPassed;
    panelEvent('control', passed ? 'info' : 'error', {
      action: 'selftest',
      message: passed ? '自检全部通过' : '自检失败',
    });
    const output = [
      '=== 代理逻辑测试 ===',
      proxyRun.stdout + (proxyRun.stderr ? '\n' + proxyRun.stderr : ''),
      '',
      '=== 界面测试 ===',
      uiOutput,
    ].join('\n');
    return sendJson(res, 200, { ok: passed, output });
  }

  if (req.method === 'POST' && route === '/api/scan') {
    const apply = url.searchParams.get('apply') === '1';
    panelEvent('control', 'info', { action: 'scan', message: apply ? '开始修复历史会话文件' : '开始扫描历史会话文件' });
    const r = await runNode(apply ? ['repair-ctc-ids.mjs', '--apply'] : ['repair-ctc-ids.mjs']);
    panelEvent('control', r.ok ? 'info' : 'error', { action: 'scan', message: (r.stdout.split('\n')[0] || '').trim() });
    return sendJson(res, 200, { ok: r.ok, apply, output: r.stdout + (r.stderr ? '\n' + r.stderr : '') });
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `控制面板端口 ${PANEL_PORT} 已被占用，可能面板已在运行`
    : `控制面板启动失败: ${err.message}`);
  process.exit(1);
});

primeTail();
setInterval(pollEventLog, 400);

server.listen(PANEL_PORT, '127.0.0.1', async () => {
  console.log(`控制面板: http://127.0.0.1:${PANEL_PORT}`);
  if (process.env.CODEX_PANEL_AUTOSTART_PROXY !== '0') {
    const r = await startProxy();
    console.log(r.ok ? (r.already ? '代理已在运行' : '代理已启动') : '代理启动失败: ' + r.error);
  }
});
