// Measures what the proxy costs, against a local fake upstream so the numbers
// reflect proxy overhead only and not relay latency.
//
//   node bench.mjs
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const UPSTREAM_PORT = 7861;
const PROXY_PORT = 7862;

// A realistic replayed history: large, with a few bad ids buried in it.
function buildBody(sizeKb) {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(sizeKb * 1024) }] },
    { type: 'custom_tool_call', id: 'fc_bench01', call_id: 'call_b1', name: 'exec', input: 'a' },
    { type: 'custom_tool_call_output', call_id: 'call_b1', output: 'a' },
  ];
  return JSON.stringify({ model: 'gpt-5.6-sol', stream: true, input });
}

// A realistic SSE stream: many small token deltas plus a final completed frame.
function buildStream(deltas) {
  const frames = ['event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x"}}\n\n'];
  for (let i = 0; i < deltas; i++) {
    frames.push(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"tok${i} "}\n\n`);
  }
  frames.push('data: {"type":"response.completed","response":{"output":[{"type":"custom_tool_call","id":"fc_bench02","call_id":"call_b2","name":"exec","input":"a"}]}}\n\n');
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const deltas = Number(req.headers['x-deltas'] || 400);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Write in realistic small chunks rather than one blob.
    const text = buildStream(deltas);
    let i = 0;
    const step = 512;
    const tick = () => {
      if (i >= text.length) return res.end();
      res.write(text.slice(i, i + step));
      i += step;
      setImmediate(tick);
    };
    tick();
  });
});

function post(port, body, deltas) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let firstByte = null;
    let bytes = 0;
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/responses', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-deltas': String(deltas),
      },
    }, (res) => {
      res.on('data', (c) => { if (firstByte === null) firstByte = performance.now(); bytes += c.length; });
      res.on('end', () => resolve({
        ttfb: (firstByte ?? performance.now()) - started,
        total: performance.now() - started,
        bytes,
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function bench(label, port, body, deltas, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await post(port, body, deltas));
  // Median, not mean: other processes on the box produce large outliers.
  const median = (k) => { const v = samples.map(x => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  return { label, ttfb: median('ttfb'), total: median('total'), bytes: samples[0].bytes };
}

await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

process.env.CODEX_ID_PROXY_PORT = String(PROXY_PORT);
process.env.CODEX_ID_PROXY_UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;
// Left unset by default so the proxy uses its own logs/ next to the script.
if (process.env.BENCH_LOG_DIR) process.env.CODEX_ID_PROXY_LOG_DIR = process.env.BENCH_LOG_DIR;
const { createServer } = await import('./id-sanitizing-proxy.mjs');
const proxy = createServer();
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const RUNS = Number(process.env.BENCH_RUNS || 25);
const scenarios = [
  { name: '小请求 8KB / 100 delta', kb: 8, deltas: 100 },
  { name: '中请求 200KB / 400 delta', kb: 200, deltas: 400 },
  { name: '大请求 680KB / 1500 delta', kb: 680, deltas: 1500 },
];

console.log(`每档 ${RUNS} 次取中位数，单位毫秒\n`);
console.log('场景'.padEnd(26) + 'TTFB直连  TTFB经代理  总耗时直连  总耗时经代理  代理开销');
for (const s of scenarios) {
  const body = buildBody(s.kb);
  await bench('warmup', UPSTREAM_PORT, body, s.deltas, 3);
  await bench('warmup', PROXY_PORT, body, s.deltas, 3);
  const direct = await bench('direct', UPSTREAM_PORT, body, s.deltas, RUNS);
  const viaProxy = await bench('proxy', PROXY_PORT, body, s.deltas, RUNS);
  const overhead = viaProxy.total - direct.total;
  console.log(
    s.name.padEnd(24)
    + direct.ttfb.toFixed(1).padStart(9)
    + viaProxy.ttfb.toFixed(1).padStart(12)
    + direct.total.toFixed(1).padStart(12)
    + viaProxy.total.toFixed(1).padStart(14)
    + ('+' + overhead.toFixed(1)).padStart(10)
  );
}

proxy.close();
upstream.close();
