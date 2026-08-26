// One-shot relay reachability check, run as a child process by the panel.
// Uses the same CONNECT-tunnel path as the proxy so the result is meaningful.
// Prints a single JSON line on stdout.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const target = new URL(process.env.PROBE_URL);
const key = process.env.PROBE_KEY || '';
const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const proxy = target.protocol === 'https:' && rawProxy ? new URL(rawProxy) : null;

function tunnelAgent(proxyUrl, host, port) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
        return;
      }
      const secure = tls.connect({ socket, servername: host }, () => callback(null, secure));
      secure.on('error', (err) => callback(err));
    });
    req.on('error', (err) => callback(err));
    req.end();
  };
  return agent;
}

function done(payload) {
  process.stdout.write(JSON.stringify({ viaProxy: Boolean(proxy), ...payload }) + '\n');
  process.exit(0);
}

const transport = target.protocol === 'http:' ? http : https;
const port = target.port || (target.protocol === 'http:' ? 80 : 443);
const headers = {
  // Match what Codex sends; some relays reject unknown clients outright.
  'user-agent': 'codex_cli_rs/0.58.0 (Windows 10.0.22635; x86_64)',
  originator: 'codex_cli_rs',
  accept: 'application/json',
};
if (key) headers.authorization = `Bearer ${key}`;

const req = transport.request({
  protocol: target.protocol,
  hostname: target.hostname,
  port,
  method: 'GET',
  path: target.pathname + target.search,
  headers,
  timeout: 25000,
  ...(proxy ? { agent: tunnelAgent(proxy, target.hostname, port) } : {}),
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (c) => { if (body.length < 600) body += c; });
  res.on('end', () => done({ status: res.statusCode, body: body.slice(0, 600) }));
});

req.on('timeout', () => { req.destroy(); done({ status: 0, error: '连接超时（25 秒）' }); });
req.on('error', (err) => done({ status: 0, error: `${err.code || ''} ${err.message}`.trim() }));
req.end();
