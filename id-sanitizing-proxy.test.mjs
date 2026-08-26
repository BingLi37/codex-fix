// Verifies the proxy against payload shapes taken from the real broken sessions.
// Runs entirely against a fake local upstream; never touches the live relay.
import http from 'node:http';
import assert from 'node:assert';

const PORT = 7811;
const UPSTREAM_PORT = 7812;
process.env.CODEX_ID_PROXY_PORT = String(PORT);
process.env.CODEX_ID_PROXY_UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

const { createServer, freshIdLike, mayNeedRewrite, normalizeId, renameKnownPoisoned, renameRejectedCall, sanitize } = await import('./id-sanitizing-proxy.mjs');
const { mapPath, parseRelay } = await import('./relay-config.mjs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('unit: normalizeId');
check('fc_ on custom_tool_call becomes ctc_', () => {
  assert.equal(
    normalizeId('fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721', 'custom_tool_call'),
    'ctc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721');
});
check('item_ on custom_tool_call becomes ctc_', () => {
  assert.equal(normalizeId('item_d615fbd06da9166384ceaf53', 'custom_tool_call'),
    'ctc_d615fbd06da9166384ceaf53');
});
check('valid ctc_ is left alone', () => {
  assert.equal(normalizeId('ctc_abc123', 'custom_tool_call'), null);
});
check('a wrong prefix is corrected for every type, keeping the suffix', () => {
  // The relay now rejects reasoning items prefixed item_ too, wanting rs_.
  assert.equal(normalizeId('item_a36b55d392c0e9755697d0fa', 'function_call'), 'fc_a36b55d392c0e9755697d0fa');
  assert.equal(normalizeId('item_deadbeef', 'reasoning'), 'rs_deadbeef');
  assert.equal(normalizeId('item_deadbeef', 'message'), 'msg_deadbeef');
  assert.equal(normalizeId('resp_deadbeef', 'message'), 'msg_deadbeef');
});
check('an unpersisted reasoning item loses its id instead of gaining rs_', () => {
  // Two backends disagree: one rejects the item_ prefix, the other rejects an
  // rs_ id it cannot find because store is false. No id satisfies both.
  const node = { type: 'reasoning', id: 'item_abc', summary: [] };
  const counters = { ids: 0, refs: 0, pairs: [] };
  sanitize(node, new Map(), counters);
  assert.equal('id' in node, false, 'id should be dropped, got ' + node.id);
  assert.equal(counters.ids, 1);
});
check('a reasoning item with encrypted_content keeps an id, fixed to rs_', () => {
  const node = { type: 'reasoning', id: 'item_abc', encrypted_content: 'x' };
  const counters = { ids: 0, refs: 0, pairs: [] };
  sanitize(node, new Map(), counters);
  assert.equal(node.id, 'rs_abc');
});
check('a correct rs_ id is never touched either way', () => {
  for (const extra of [{ summary: [] }, { encrypted_content: 'x' }]) {
    const node = { type: 'reasoning', id: 'rs_abc', ...extra };
    const counters = { ids: 0, refs: 0, pairs: [] };
    sanitize(node, new Map(), counters);
    assert.equal(node.id, 'rs_abc');
    assert.equal(counters.ids, 0);
  }
});
check('an already correct prefix is left alone', () => {
  assert.equal(normalizeId('rs_abc', 'reasoning'), null);
  assert.equal(normalizeId('msg_abc', 'message'), null);
  assert.equal(normalizeId('fc_abc', 'function_call'), null);
  assert.equal(normalizeId('ctc_abc', 'custom_tool_call'), null);
});

console.log('unit: sanitize keeps references consistent');
check('item_id on later delta follows the remap', () => {
  const remap = new Map(), counters = { ids: 0, refs: 0 };
  const added = { type: 'custom_tool_call', id: 'fc_abc', call_id: 'call_1', name: 'exec' };
  sanitize(added, remap, counters);
  const delta = { type: 'response.custom_tool_call_input.delta', item_id: 'fc_abc', delta: 'x' };
  sanitize(delta, remap, counters);
  assert.equal(added.id, 'ctc_abc');
  assert.equal(delta.item_id, 'ctc_abc');
  assert.equal(counters.ids, 1);
  assert.equal(counters.refs, 1);
});
check('call_id and input payload are preserved exactly', () => {
  const remap = new Map(), counters = { ids: 0, refs: 0 };
  const item = {
    type: 'custom_tool_call', id: 'fc_xyz', call_id: 'call_WYq5iTP7yqF6E0AEOHzxtdKu',
    name: 'exec', input: 'const r = await tools.exec_command({cmd: "ls"});',
  };
  sanitize(item, remap, counters);
  assert.equal(item.call_id, 'call_WYq5iTP7yqF6E0AEOHzxtdKu');
  assert.equal(item.input, 'const r = await tools.exec_command({cmd: "ls"});');
  assert.equal(item.name, 'exec');
});
check('a bad id quoted inside tool text is not rewritten', () => {
  const remap = new Map(), counters = { ids: 0, refs: 0 };
  const item = {
    type: 'custom_tool_call', id: 'ctc_good',
    input: 'grep -F "fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721" file.jsonl',
  };
  sanitize(item, remap, counters);
  assert.ok(item.input.includes('fc_0e87554e5562efea'), 'tool text must stay byte-identical');
  assert.equal(counters.ids, 0);
});

// The fast path skips JSON.parse for lines that cannot need rewriting. If it
// ever returns false for a line that does need work, ids silently leak through.
console.log('unit: parse fast path');
check('a bad prefix is always caught', () => {
  assert.equal(mayNeedRewrite('{"type":"custom_tool_call","id":"fc_x"}', new Map()), true);
  assert.equal(mayNeedRewrite('{"type":"custom_tool_call","id":"item_x"}', new Map()), true);
});
check('a plain token delta is skipped', () => {
  const line = '{"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}';
  assert.equal(mayNeedRewrite(line, new Map()), false);
});
check('a delta referencing an already remapped id is caught', () => {
  const remap = new Map([['fc_abc', 'ctc_abc']]);
  const line = '{"type":"response.custom_tool_call_input.delta","item_id":"fc_abc","delta":"x"}';
  assert.equal(mayNeedRewrite(line, remap), true);
});
check('a good ctc_ id is not screened in', () => {
  const line = '{"type":"custom_tool_call","id":"ctc_abc","call_id":"call_1"}';
  assert.equal(mayNeedRewrite(line, new Map()), false);
});
check('a resp_ prefixed message is screened in', () => {
  const line = '{"type":"message","id":"resp_abc","role":"assistant"}';
  assert.equal(mayNeedRewrite(line, new Map()), true);
});
check('the fast path does not change sanitize results', () => {
  // Same payload through sanitizeJsonText must still be repaired end to end.
  const remap = new Map();
  const added = { type: 'custom_tool_call', id: 'fc_seq1', call_id: 'call_s', name: 'exec' };
  sanitize(added, remap, { ids: 0, refs: 0, pairs: [] });
  assert.equal(added.id, 'ctc_seq1');
  assert.equal(mayNeedRewrite('{"item_id":"fc_seq1"}', remap), true);
});


// Verified against the live relay: renaming only this one id is accepted, while
// renaming the reasoning id instead is still rejected.
console.log('unit: renaming a rejected function_call id');
check('renames the named function_call and nothing else', () => {
  const body = JSON.stringify({ input: [
    { type: 'reasoning', id: 'rs_keep', encrypted_content: 'x' },
    { type: 'function_call', id: 'fc_bad', name: 'send_message', call_id: 'call_keep' },
    { type: 'function_call_output', call_id: 'call_keep', output: 'done' },
  ] });
  const out = renameRejectedCall(body, 'fc_bad');
  assert.ok(out, 'expected a rewrite');
  const parsed = JSON.parse(out.text);
  const call = parsed.input.find((i) => i.type === 'function_call');
  assert.notEqual(call.id, 'fc_bad');
  assert.ok(call.id.startsWith('fc_'));
  // call_id must survive: it is what pairs the call with its output.
  assert.equal(call.call_id, 'call_keep');
  assert.equal(parsed.input[0].id, 'rs_keep');
  assert.equal(parsed.input[2].call_id, 'call_keep');
});
check('leaves other tool calls untouched', () => {
  const body = JSON.stringify({ input: [
    { type: 'function_call', id: 'fc_other', name: 'a', call_id: 'call_a' },
    { type: 'function_call', id: 'fc_bad', name: 'b', call_id: 'call_b' },
  ] });
  const parsed = JSON.parse(renameRejectedCall(body, 'fc_bad').text);
  assert.equal(parsed.input[0].id, 'fc_other');
  assert.notEqual(parsed.input[1].id, 'fc_bad');
});
check('renames a rejected custom_tool_call with the ctc_ prefix', () => {
  // Observed in the wild: the same rejection happens for custom_tool_call, and
  // a fresh id must keep the ctc_ prefix or it just becomes a prefix error.
  const body = JSON.stringify({ input: [
    { type: 'reasoning', id: 'rs_keep', encrypted_content: 'x' },
    { type: 'custom_tool_call', id: 'ctc_bad', name: 'exec', input: 'a', call_id: 'call_keep' },
    { type: 'custom_tool_call_output', call_id: 'call_keep', output: 'done' },
  ] });
  const out = renameRejectedCall(body, 'ctc_bad');
  assert.ok(out, 'expected a rewrite');
  assert.equal(out.type, 'custom_tool_call');
  const parsed = JSON.parse(out.text);
  const call = parsed.input.find((i) => i.type === 'custom_tool_call');
  assert.ok(call.id.startsWith('ctc_'), 'must keep the ctc_ prefix, got ' + call.id);
  assert.notEqual(call.id, 'ctc_bad');
  assert.equal(call.call_id, 'call_keep');
  assert.equal(parsed.input[0].id, 'rs_keep');
});
check('renames accumulate so a second pass keeps the first fix', () => {
  // The relay reports one bad id per attempt, so fixes must not be lost.
  const body = JSON.stringify({ input: [
    { type: 'function_call', id: 'fc_bad1', call_id: 'c1' },
    { type: 'custom_tool_call', id: 'ctc_bad2', call_id: 'c2' },
  ] });
  const first = renameRejectedCall(body, 'fc_bad1');
  const second = renameRejectedCall(first.text, 'ctc_bad2');
  const parsed = JSON.parse(second.text);
  assert.notEqual(parsed.input[0].id, 'fc_bad1');
  assert.ok(parsed.input[0].id.startsWith('fc_'));
  assert.notEqual(parsed.input[1].id, 'ctc_bad2');
  assert.ok(parsed.input[1].id.startsWith('ctc_'));
});
check('renames a rejected message item, keeping the msg_ prefix', () => {
  // Third type seen rejected in the wild. A message carries no call_id.
  const body = JSON.stringify({ input: [
    { type: 'reasoning', id: 'rs_keep', encrypted_content: 'x' },
    { type: 'message', id: 'msg_bad', role: 'assistant', content: [] },
  ] });
  const out = renameRejectedCall(body, 'msg_bad');
  assert.ok(out, 'expected a rewrite');
  assert.equal(out.type, 'message');
  const parsed = JSON.parse(out.text);
  assert.ok(parsed.input[1].id.startsWith('msg_'), 'got ' + parsed.input[1].id);
  assert.notEqual(parsed.input[1].id, 'msg_bad');
  assert.equal(parsed.input[0].id, 'rs_keep');
});
check('refuses to rename a reasoning item', () => {
  // Verified live: renaming the reasoning item instead of the dependent item is
  // still rejected, so renaming it would throw away a good item for nothing.
  const body = JSON.stringify({ input: [{ type: 'reasoning', id: 'rs_x', encrypted_content: 'a' }] });
  assert.equal(renameRejectedCall(body, 'rs_x'), null);
});
check('the prefix comes from the id, not a hardcoded type list', () => {
  assert.ok(freshIdLike('fc_abc').startsWith('fc_'));
  assert.ok(freshIdLike('ctc_abc').startsWith('ctc_'));
  assert.ok(freshIdLike('msg_abc').startsWith('msg_'));
  assert.ok(freshIdLike('item_abc').startsWith('item_'));
  // An id with no recognisable prefix must not be guessed at.
  assert.equal(freshIdLike('weird'), null);
  assert.equal(freshIdLike('rs_abc'), null);
});
check('returns null when the id is absent or body is not usable', () => {
  assert.equal(renameRejectedCall(JSON.stringify({ input: [] }), 'fc_bad'), null);
  assert.equal(renameRejectedCall('not json', 'fc_bad'), null);
  assert.equal(renameRejectedCall(JSON.stringify({}), 'fc_bad'), null);
});
check('generated ids are unique', () => {
  const body = JSON.stringify({ input: [{ type: 'function_call', id: 'fc_bad', call_id: 'c' }] });
  const a = JSON.parse(renameRejectedCall(body, 'fc_bad').text).input[0].id;
  const b = JSON.parse(renameRejectedCall(body, 'fc_bad').text).input[0].id;
  assert.notEqual(a, b);
});


// Known-bad ids are rewritten before sending, so a poisoned history does not
// re-pay its retry round trips on every turn.
console.log('unit: pre-renaming known-bad ids');
check('rewrites every known-bad id in one pass', () => {
  const known = new Map([['fc_bad1', 'function_call'], ['ctc_bad2', 'custom_tool_call']]);
  const body = JSON.stringify({ input: [
    { type: 'function_call', id: 'fc_bad1', call_id: 'c1' },
    { type: 'custom_tool_call', id: 'ctc_bad2', call_id: 'c2' },
    { type: 'function_call', id: 'fc_fine', call_id: 'c3' },
  ] });
  const out = renameKnownPoisoned(body, known);
  assert.equal(out.pairs.length, 2);
  const parsed = JSON.parse(out.text);
  assert.ok(parsed.input[0].id.startsWith('fc_') && parsed.input[0].id !== 'fc_bad1');
  assert.ok(parsed.input[1].id.startsWith('ctc_') && parsed.input[1].id !== 'ctc_bad2');
  // An id the relay never complained about must be left alone.
  assert.equal(parsed.input[2].id, 'fc_fine');
  // call_id pairing must survive.
  assert.equal(parsed.input[0].call_id, 'c1');
});
check('does nothing when no known-bad id is present', () => {
  const known = new Map([['fc_bad1', 'function_call']]);
  const body = JSON.stringify({ input: [{ type: 'function_call', id: 'fc_fine', call_id: 'c' }] });
  assert.equal(renameKnownPoisoned(body, known), null);
});
check('does nothing with an empty memory', () => {
  const body = JSON.stringify({ input: [{ type: 'function_call', id: 'fc_bad1', call_id: 'c' }] });
  assert.equal(renameKnownPoisoned(body, new Map()), null);
});
check('survives an unusable body', () => {
  assert.equal(renameKnownPoisoned('not json', new Map([['a', 'function_call']])), null);
  assert.equal(renameKnownPoisoned(JSON.stringify({}), new Map([['a', 'function_call']])), null);
});

console.log('unit: relay path mapping');
check('a /v1 relay keeps the same path', () => {
  const relay = parseRelay({ id: 'a', baseUrl: 'https://agentrouter.org/v1' });
  assert.equal(relay.basePath, '/v1');
  assert.equal(mapPath('/v1/responses', relay.basePath), '/v1/responses');
});
check('a relay with a deeper base path is rewritten', () => {
  const relay = parseRelay({ id: 'b', baseUrl: 'https://example.com/api/v3' });
  assert.equal(mapPath('/v1/responses', relay.basePath), '/api/v3/responses');
  assert.equal(mapPath('/v1/models', relay.basePath), '/api/v3/models');
});
check('a relay with no base path drops the local prefix', () => {
  const relay = parseRelay({ id: 'c', baseUrl: 'https://example.com' });
  assert.equal(relay.basePath, '');
  assert.equal(mapPath('/v1/responses', relay.basePath), '/responses');
});
check('query strings survive mapping', () => {
  assert.equal(mapPath('/v1/models?limit=5', '/api'), '/api/models?limit=5');
});
check('a trailing slash in the relay url is normalised', () => {
  const relay = parseRelay({ id: 'd', baseUrl: 'https://example.com/v1/' });
  assert.equal(relay.basePath, '/v1');
  assert.equal(mapPath('/v1/responses', relay.basePath), '/v1/responses');
});
check('relay port and protocol are derived', () => {
  const plain = parseRelay({ id: 'e', baseUrl: 'http://127.0.0.1:9000/v1' });
  assert.equal(plain.protocol, 'http:');
  assert.equal(Number(plain.port), 9000);
  const secure = parseRelay({ id: 'f', baseUrl: 'https://example.com/v1' });
  assert.equal(Number(secure.port), 443);
});


// A stalled upstream must not hang: one real request was seen taking 5847s.
// The budget is on inactivity, so a slow-but-alive stream has to survive it.
console.log('integration: upstream idle timeout');
{
  const IDLE_PORT = 7913, IDLE_UP = 7914;
  const silent = http.createServer((req, res) => { req.resume(); req.on('end', () => {}); });
  await new Promise((r) => silent.listen(IDLE_UP, '127.0.0.1', r));

  // A second proxy instance with a short budget, so the test stays quick.
  process.env.CODEX_ID_PROXY_IDLE_MS = '2000';
  const started = Date.now();
  const idleProxy = createServer();
  await new Promise((r) => idleProxy.listen(IDLE_PORT, '127.0.0.1', r));

  const reqBody = JSON.stringify({ model: 'x', stream: true, input: [] });
  const res = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: IDLE_PORT, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) } }, (r) => {
      r.resume(); r.on('end', () => resolve({ status: r.statusCode }));
    });
    rq.on('error', () => resolve({ status: 0 }));
    rq.end(reqBody);
  });
  const elapsed = Date.now() - started;
  check('a silent upstream is abandoned rather than left hanging', () => {
    assert.ok(elapsed < 15000, 'took ' + elapsed + 'ms');
    assert.equal(res.status, 502);
  });
  idleProxy.close();
  silent.close();
  delete process.env.CODEX_ID_PROXY_IDLE_MS;
}

console.log('integration: proxy end to end');

let seenRequestBody = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seenRequestBody = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/json') {
      const payload = JSON.stringify({
        id: 'resp_1',
        output: [{ type: 'custom_tool_call', id: 'fc_nonstream', call_id: 'call_a', name: 'exec', input: '1' }],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
      return;
    }
    // SSE, deliberately split mid-line to exercise the line buffer.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","id":"fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721","call_id":"call_WYq5iTP7yqF6E0AEOHzxtdKu","name":"exec","input":""}}\n\n',
      'event: response.custom_tool_call_input.delta\n',
      'data: {"type":"response.custom_tool_call_input.delta","item_id":"fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721","delta":"const r"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"custom_tool_call","id":"fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721","call_id":"call_WYq5iTP7yqF6E0AEOHzxtdKu","name":"exec","input":"const r"}]}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const mid = Math.floor(frames.length / 2);
    res.write(frames.slice(0, mid));
    setTimeout(() => { res.write(frames.slice(mid)); res.end(); }, 10);
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const proxy = createServer();
await new Promise((r) => proxy.listen(PORT, '127.0.0.1', r));

function request(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A replayed history containing a bad id, exactly as Codex would send it.
const historyWithBadId = JSON.stringify({
  model: 'gpt-5.6-sol',
  stream: true,
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'custom_tool_call', id: 'fc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721',
      call_id: 'call_WYq5iTP7yqF6E0AEOHzxtdKu', name: 'exec', input: 'ls' },
    { type: 'custom_tool_call_output', call_id: 'call_WYq5iTP7yqF6E0AEOHzxtdKu', output: 'ok' },
    { type: 'function_call', id: 'item_a36b55d392c0e9755697d0fa', call_id: 'call_b', name: 'wait_agent', arguments: '{}' },
  ],
});

const streamed = await request('/v1/responses', historyWithBadId);

check('outbound history had its custom_tool_call id repaired', () => {
  const sent = JSON.parse(seenRequestBody);
  const ctc = sent.input.find((i) => i.type === 'custom_tool_call');
  assert.equal(ctc.id, 'ctc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721');
  assert.equal(ctc.call_id, 'call_WYq5iTP7yqF6E0AEOHzxtdKu');
});
check('outbound function_call item_ id was corrected to fc_', () => {
  const sent = JSON.parse(seenRequestBody);
  const fn = sent.input.find((i) => i.type === 'function_call');
  assert.equal(fn.id, 'fc_a36b55d392c0e9755697d0fa');
});
check('streamed response contains no fc_ custom_tool_call id', () => {
  assert.ok(!/"type":"custom_tool_call","id":"fc_/.test(streamed.text), streamed.text.slice(0, 300));
  assert.ok(streamed.text.includes('"id":"ctc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721"'));
});
check('delta item_id was remapped to match', () => {
  assert.ok(streamed.text.includes('"item_id":"ctc_0e87554e5562efea016a8a40be615087d094df518ccb7ab721"'));
  assert.ok(!streamed.text.includes('"item_id":"fc_'));
});
check('SSE framing survived the rewrite', () => {
  assert.ok(streamed.text.includes('event: response.output_item.added\n'));
  assert.ok(streamed.text.trimEnd().endsWith('data: [DONE]'));
  assert.equal(streamed.text.split('\n\n').length, 5);
});
check('every data line is still valid JSON', () => {
  for (const line of streamed.text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const body = line.slice(5).trim();
    if (!body || body === '[DONE]') continue;
    JSON.parse(body);
  }
});

const nonStream = await request('/v1/json', '{}');
check('non-streaming JSON response is repaired too', () => {
  const obj = JSON.parse(nonStream.text);
  assert.equal(obj.output[0].id, 'ctc_nonstream');
  assert.equal(nonStream.headers['content-length'], String(Buffer.byteLength(nonStream.text)));
});

const health = await request('/__id_proxy_health');
check('health endpoint reports counters', () => {
  const obj = JSON.parse(health.text);
  assert.equal(obj.ok, true);
  assert.ok(obj.idsFixed >= 3, 'idsFixed=' + obj.idsFixed);
});

proxy.close();
upstream.close();
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
