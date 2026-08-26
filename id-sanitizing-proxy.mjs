// Local sanitizing proxy for the Codex -> relay Responses API path.
//
// The relay sometimes emits a `custom_tool_call` whose id starts with `fc_` or
// `item_`. The Responses API requires `ctc_`. Codex stores whatever it receives,
// replays the full history every turn, and from then on every request 400s with
// "Expected an ID that begins with 'ctc'", which bricks the session.
//
// This proxy sits in between and rewrites those ids in both directions, so the
// bad id never reaches Codex's in-memory history and never gets persisted.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { activeRelay, mapPath, parseRelay, readRelayConfig } from './relay-config.mjs';

const PORT = Number(process.env.CODEX_ID_PROXY_PORT || 7801);

// The relay is read from relays.json on every request, so switching relays in
// the panel takes effect without restarting. CODEX_ID_PROXY_UPSTREAM still wins
// when set, which the tests rely on.
const UPSTREAM_OVERRIDE = process.env.CODEX_ID_PROXY_UPSTREAM
  ? new URL(process.env.CODEX_ID_PROXY_UPSTREAM)
  : null;

function currentTarget() {
  if (UPSTREAM_OVERRIDE) {
    return {
      id: 'env-override',
      name: UPSTREAM_OVERRIDE.origin,
      protocol: UPSTREAM_OVERRIDE.protocol,
      hostname: UPSTREAM_OVERRIDE.hostname,
      port: UPSTREAM_OVERRIDE.port || (UPSTREAM_OVERRIDE.protocol === 'http:' ? 80 : 443),
      origin: UPSTREAM_OVERRIDE.origin,
      basePath: '',
      apiKey: '',
      baseUrl: UPSTREAM_OVERRIDE.origin,
      passthroughPath: true,
    };
  }
  return parseRelay(activeRelay(readRelayConfig()));
}
const LOG_DIR = process.env.CODEX_ID_PROXY_LOG_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
const HEALTH_PATH = '/__id_proxy_health';
// Structured feed the dashboard tails. Trimmed when it gets large.
const EVENT_LOG = path.join(LOG_DIR, 'events.jsonl');
const EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024;

// item type -> required id prefix.
//
// This started as custom_tool_call only, because every prefix rejection on
// record wanted 'ctc'. That is no longer true: the relay now also rejects
// reasoning items carrying an 'item_' prefix, wanting 'rs'. Fixing a prefix
// keeps the unique suffix, so the item's identity survives — unlike the fresh-id
// rename used for server-side poisoning, this is purely a format correction.
const REQUIRED_PREFIX = {
  custom_tool_call: 'ctc_',
  custom_tool_call_output: 'ctco_',
  function_call: 'fc_',
  function_call_output: 'fco_',
  reasoning: 'rs_',
  message: 'msg_',
};

// Codex itself honours HTTPS_PROXY, so reach the relay the same way it does.
// Set CODEX_ID_PROXY_NO_UPSTREAM_PROXY=1 to force a direct connection.
const SYSTEM_PROXY = (() => {
  if (process.env.CODEX_ID_PROXY_NO_UPSTREAM_PROXY === '1') return null;
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
})();

// Only https targets go through the CONNECT tunnel; plain http is direct.
const proxyFor = (target) => (SYSTEM_PROXY && target.protocol === 'https:' ? SYSTEM_PROXY : null);

const stats = { started: new Date().toISOString(), requests: 0, idsFixed: 0, refsFixed: 0, lastFix: null };

// Tunnels TLS to the relay through the local system proxy.
// Note: createConnection has to be assigned on the instance. Node ignores it
// when passed in the Agent constructor options, which silently falls back to a
// direct connection.
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
        callback(new Error(`proxy CONNECT returned ${res.statusCode}`));
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

// Both logs are buffered and flushed on a timer. Writing synchronously on every
// event blocked the stream long enough to measure (4-6ms per request).
const pending = { text: [], events: [] };
let flushTimer = null;
let logDirReady = false;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, 250);
  flushTimer.unref?.();
}

function flushLogs() {
  flushTimer = null;
  const text = pending.text.splice(0);
  const events = pending.events.splice(0);
  if (!text.length && !events.length) return;
  try {
    if (!logDirReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logDirReady = true; }
    if (text.length) fs.appendFileSync(path.join(LOG_DIR, 'id-sanitizing-proxy.log'), text.join(''));
    if (events.length) {
      trimEventLog();
      fs.appendFileSync(EVENT_LOG, events.join(''));
    }
  } catch {}
}

function trimEventLog() {
  try {
    if (!fs.existsSync(EVENT_LOG)) return;
    if (fs.statSync(EVENT_LOG).size <= EVENT_LOG_MAX_BYTES) return;
    const kept = fs.readFileSync(EVENT_LOG, 'utf8').split('\n').slice(-2000).join('\n');
    fs.writeFileSync(EVENT_LOG, kept);
  } catch {}
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  pending.text.push(msg + '\n');
  scheduleFlush();
}

// Appends one machine-readable event. The dashboard tails this file, so each
// line has to stay a self-contained JSON object.
function emit(kind, level, data = {}) {
  const event = { at: new Date().toISOString(), kind, level, ...data };
  pending.events.push(JSON.stringify(event) + '\n');
  scheduleFlush();
  return event;
}

let requestSeq = 0;

// Returns the corrected id, or null when the id is already valid.
export function normalizeId(id, itemType) {
  const want = REQUIRED_PREFIX[itemType];
  if (!want || typeof id !== 'string' || id.startsWith(want)) return null;
  const underscore = id.indexOf('_');
  const suffix = underscore === -1 ? id : id.slice(underscore + 1);
  if (!suffix) return null;
  return want + suffix;
}

// Walks any Responses-API shaped object and repairs ids in place.
// `remap` carries bad->good ids so that later references (item_id on delta
// events, and the same item echoed in response.completed) stay consistent.
export function sanitize(node, remap, counters) {
  if (Array.isArray(node)) {
    for (const child of node) sanitize(child, remap, counters);
    return;
  }
  if (!node || typeof node !== 'object') return;

  // A reasoning item with a wrong prefix and no encrypted_content has no
  // server-side record: one backend rejects the `item_` prefix ("Expected an ID
  // that begins with 'rs'"), while renaming it to rs_ makes another backend look
  // it up and fail ("not found. Items are not persisted when store is false").
  // Dropping the id satisfies both — there is nothing to validate or look up.
  if (node.type === 'reasoning' && typeof node.id === 'string'
      && !node.id.startsWith('rs_') && !node.encrypted_content) {
    counters.pairs?.push({ from: node.id, to: '(已移除 id)', name: node.type });
    delete node.id;
    counters.ids++;
  } else {
    const fixed = normalizeId(node.id, node.type);
    if (fixed) {
      remap.set(node.id, fixed);
      counters.pairs?.push({ from: node.id, to: fixed, name: node.name, call_id: node.call_id });
      node.id = fixed;
      counters.ids++;
    }
  }
  // Delta/streaming events reference the item by item_id and carry no type.
  if (typeof node.item_id === 'string' && remap.has(node.item_id)) {
    node.item_id = remap.get(node.item_id);
    counters.refs++;
  }
  // An already-remapped item seen again (e.g. inside response.completed).
  if (typeof node.id === 'string' && remap.has(node.id)) {
    node.id = remap.get(node.id);
    counters.refs++;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') sanitize(value, remap, counters);
  }
}

// Cheap screen before the expensive parse. A line can only need rewriting if it
// carries a malformed prefix, or references an id we have already remapped.
// Token deltas are the bulk of a stream and match neither.
// Cheap screen used only for SSE lines, where thousands of token deltas flow and
// parsing each one is the actual cost. It cannot enumerate every wrong prefix
// (a `resp_` message id slipped through an earlier version), so request and
// response bodies skip this and are always parsed: that is one parse each,
// which is worth paying for correctness.
// Only the prefixes actually seen arriving wrong are screened for: `fc_` on a
// custom_tool_call, and `item_` / `resp_` on anything. Screening for valid
// prefixes too (msg_, rs_, ctc_) would match every token delta's "item_id":"msg_…"
// and parse the whole stream, which is the cost this exists to avoid.
// Anything exotic that slips through inbound is still corrected on the next
// outbound pass, which never screens.
export function mayNeedRewrite(text, remap) {
  // Match the value position, not the prefix alone: plain `"item_` also matches
  // the *key* "item_id", present on every delta.
  if (/:\s*"(fc|item|resp)_/.test(text)) return true;
  if (remap.size === 0) return false;
  for (const from of remap.keys()) if (text.includes(from)) return true;
  return false;
}

// Sanitizes a JSON string. Returns the rewritten text, or null if unchanged
// or not JSON (callers then forward the original bytes untouched).
export function sanitizeJsonText(text, remap, { screen = true } = {}) {
  if (screen && !mayNeedRewrite(text, remap)) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const counters = { ids: 0, refs: 0, pairs: [] };
  sanitize(obj, remap, counters);
  if (!counters.ids && !counters.refs) return null;
  stats.idsFixed += counters.ids;
  stats.refsFixed += counters.refs;
  stats.lastFix = new Date().toISOString();
  return { text: JSON.stringify(obj), counters };
}

// Rewrites SSE `data:` lines as they stream past, without buffering the stream.
export function makeSseRewriter(remap, onFix) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let out = '';
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const cr = line.endsWith('\r') ? '\r' : '';
        if (cr) line = line.slice(0, -1);
        if (line.startsWith('data:')) {
          const prefix = line.slice(0, 5);
          const payload = line.slice(5);
          const lead = payload.startsWith(' ') ? ' ' : '';
          const body = lead ? payload.slice(1) : payload;
          if (body && body !== '[DONE]') {
            const result = sanitizeJsonText(body, remap);
            if (result) {
              line = prefix + lead + result.text;
              onFix?.(result.counters);
            }
          }
        }
        out += line + cr + '\n';
      }
      return out;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest;
    },
  };
}

// Note: there is deliberately no attempt to guess which reasoning item belongs
// to which function_call. Ids from one model turn share a long common stem
// (fc_0bf175…8bcf34dcd887 vs rs_0bf175…8bcf310ba887 differ only late), so stem
// matching reports a pairing that does not exist and misses the real problem.
// The relay's rejection names both ids exactly; that is the only reliable source
// and it is what explainRejection uses.

// Requests are summarised and kept briefly so that when the relay rejects one,
// the error can name the offending item. Warning proactively is not viable: a
// call without a reasoning item is usually accepted, so it would be all noise.
const recentRequests = new Map();
const RECENT_LIMIT = 40;

function inspectHistory(reqId, text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return; }
  const input = Array.isArray(payload?.input) ? payload.input : null;
  if (!input) return;
  const counts = {};
  // Index by id so a rejection can be answered with facts about the exact
  // items the relay named, including their order and whether the reasoning
  // item still carried its encrypted payload.
  const index = new Map();
  input.forEach((item, position) => {
    counts[item?.type ?? '?'] = (counts[item?.type ?? '?'] ?? 0) + 1;
    if (typeof item?.id === 'string') {
      index.set(item.id, {
        position,
        type: item.type,
        hasEncrypted: item.type === 'reasoning'
          ? Boolean(item.encrypted_content)
          : undefined,
      });
    }
  });
  recentRequests.set(reqId, { counts, index });
  if (recentRequests.size > RECENT_LIMIT) {
    recentRequests.delete(recentRequests.keys().next().value);
  }
}

// Called when the relay rejects a request. The error names the exact ids it
// wanted, so look those up in what was actually sent rather than guessing.
function explainRejection(reqId, message) {
  const summary = recentRequests.get(reqId);
  if (!summary) return;
  const wantsReasoning = /required 'reasoning' item/i.test(message);
  const missingOutput = /No tool output found for function call/i.test(message);
  if (!wantsReasoning && !missingOutput) return;

  const detail = { reqId, itemCounts: summary.counts };
  if (wantsReasoning) {
    // "Item 'fc_x' of type 'function_call' was provided without its required
    // 'reasoning' item: 'rs_y'." Both ids matter, so check each precisely.
    const callId = message.match(/Item '([^']+)'/)?.[1];
    const reasoningId = message.match(/'reasoning' item: '([^']+)'/)?.[1];
    const call = summary.index?.get(callId);
    const reasoning = summary.index?.get(reasoningId);
    detail.callId = callId;
    detail.reasoningId = reasoningId;
    detail.callPresent = Boolean(call);
    detail.reasoningPresent = Boolean(reasoning);
    detail.callPosition = call?.position ?? null;
    detail.reasoningPosition = reasoning?.position ?? null;
    detail.reasoningHasEncryptedContent = reasoning?.hasEncrypted ?? null;

    if (!reasoning) {
      detail.message = `这次请求里没有它要的那个 reasoning 项（${reasoningId}）。`
        + `历史是 Codex 组装的，代理不删项，通常是上下文压缩把它丢掉了。新开一个会话可绕过。`;
    } else if (call && reasoning.position > call.position) {
      detail.message = `reasoning 项在请求里排在工具调用之后（第 ${reasoning.position} 项 vs 第 ${call.position} 项），`
        + `顺序反了，需要排在前面。`;
    } else if (reasoning.hasEncrypted === false) {
      detail.message = `reasoning 项在请求里，但没有 encrypted_content，中转站无法校验配对。`;
    } else {
      detail.message = `reasoning 项确实在请求里（第 ${reasoning.position} 项，排在工具调用第 ${call?.position} 项之前，`
        + `带 encrypted_content），中转站仍然拒绝。这更像是中转站或其上游的问题，不是本地历史缺失。`;
    }
  } else {
    detail.message = '中转站说这个工具调用缺少对应的输出。同样是历史组装问题，不是 id 前缀问题。';
  }
  emit('history', 'warn', detail);
}

// The relay refuses certain function_call ids outright, insisting the paired
// reasoning item is missing even when it is present, in order, and still carries
// its encrypted_content. Verified against the live relay: renaming only that one
// item id (leaving the reasoning id and call_id untouched) is accepted, so the
// stored record behind the old id is what is broken. Retrying with a fresh id
// recovers a session that would otherwise fail on every single turn.
// Observed rejected so far: function_call, custom_tool_call, message. Rather
// than enumerate types and be wrong again on the next one, the prefix is taken
// from the id itself and only the unique part is regenerated.
//
// Renaming the reasoning item is explicitly refused: tested against the live
// relay, renaming it instead of the dependent item is still rejected, so doing
// it would discard a good item for nothing.
const RENAMEABLE_PREFIX = /^(fc|ctc|msg|item)_/;

export function freshIdLike(id) {
  const prefix = String(id).match(RENAMEABLE_PREFIX)?.[1];
  if (!prefix) return null;
  return `${prefix}_` + (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 48);
}

function isRenameable(item, id) {
  if (!item || item.id !== id) return false;
  if (item.type === 'reasoning') return false;
  return Boolean(freshIdLike(id));
}

export function renameRejectedCall(bodyText, rejectedId) {
  let payload;
  try { payload = JSON.parse(bodyText); } catch { return null; }
  const input = Array.isArray(payload?.input) ? payload.input : null;
  if (!input) return null;
  const item = input.find((i) => isRenameable(i, rejectedId));
  if (!item) return null;
  // call_id pairs a call with its output, so it is deliberately left alone.
  const fresh = freshIdLike(rejectedId);
  item.id = fresh;
  return { text: JSON.stringify(payload), from: rejectedId, to: fresh, type: item.type };
}

// A poisoned history holds several bad ids and the relay only reports one per
// attempt, so the retry has to walk through them. Observed: one request needed
// a function_call and then a custom_tool_call renamed before it went through.
// Renames accumulate across attempts because each retry reuses the rewritten body.
// A poisoned history holds several bad ids and the relay only reports one per
// attempt, so the retry has to walk through them. Observed: 5 renameable tool
// calls in one session, which would be 5 extra round trips on every single turn.
// Renames accumulate across attempts because each retry reuses the rewritten body.
const MAX_ID_RETRIES = 8;

// Inactivity budget for the upstream socket. Generous enough that a slow relay
// start or a pause between tokens is fine, short enough that a dead connection
// becomes a retry within a couple of minutes instead of hanging indefinitely.
const UPSTREAM_IDLE_TIMEOUT_MS = Number(process.env.CODEX_ID_PROXY_IDLE_MS || 120000);

// Ids the relay has rejected are remembered and rewritten up front on later
// requests, so a session pays the round trips once rather than every turn.
// Persisted because otherwise a restart re-pays the whole cost.
const POISON_PATH = path.join(LOG_DIR, 'poisoned-ids.json');
const POISON_LIMIT = 500;
const poisoned = new Map();

function loadPoisoned() {
  try {
    const raw = JSON.parse(fs.readFileSync(POISON_PATH, 'utf8'));
    for (const [id, type] of Object.entries(raw?.ids ?? {})) poisoned.set(id, type);
  } catch {}
}

function rememberPoisoned(id, type) {
  if (!id || poisoned.has(id)) return;
  poisoned.set(id, type);
  while (poisoned.size > POISON_LIMIT) poisoned.delete(poisoned.keys().next().value);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(POISON_PATH, JSON.stringify({ ids: Object.fromEntries(poisoned) }, null, 2));
  } catch {}
}

// Rewrites every known-bad id in one pass, before the request is sent.
export function renameKnownPoisoned(bodyText, known) {
  if (!known.size) return null;
  let payload;
  try { payload = JSON.parse(bodyText); } catch { return null; }
  const input = Array.isArray(payload?.input) ? payload.input : null;
  if (!input) return null;
  const pairs = [];
  for (const item of input) {
    if (!item || !known.has(item.id) || !isRenameable(item, item.id)) continue;
    const fresh = freshIdLike(item.id);
    pairs.push({ from: item.id, to: fresh, type: item.type });
    item.id = fresh;
  }
  if (!pairs.length) return null;
  return { text: JSON.stringify(payload), pairs };
}

function forward(clientReq, clientRes, requestBody, target = currentTarget(), viaProxy = null, isRetry = false) {
  const remap = new Map();
  let body = requestBody;
  const systemProxy = proxyFor(target);
  const useProxy = viaProxy === null ? Boolean(systemProxy) : viaProxy;

  const reqId = isRetry ? clientReq.__reqId : (clientReq.__reqId = ++requestSeq);
  if (!isRetry) {
    emit('request', 'info', {
      reqId, method: clientReq.method, url: clientReq.url, bytes: body.length,
      relay: target.name, relayId: target.id,
    });
  }

  // Repair the replayed history on the way out. This is what unbricks a session
  // that already has a bad id sitting in its rollout file.
  if (body.length) {
    const text = body.toString('utf8');
    // Always parse the outgoing history: one parse per request, and a missed
    // prefix here is what bricks a session.
    const result = sanitizeJsonText(text, remap, { screen: false });
    if (result) {
      body = Buffer.from(result.text, 'utf8');
      log(`request  ${clientReq.url} repaired ids=${result.counters.ids} refs=${result.counters.refs}`);
      emit('repair', 'fix', {
        reqId, phase: 'request', ids: result.counters.ids, refs: result.counters.refs,
        pairs: result.counters.pairs.slice(0, 20),
      });
    }
    // Fix ids the relay has already rejected before sending, so a poisoned
    // history costs its round trips once instead of on every turn.
    const ahead = renameKnownPoisoned(body.toString('utf8'), poisoned);
    if (ahead) {
      body = Buffer.from(ahead.text, 'utf8');
      log(`request  ${clientReq.url} pre-renamed ${ahead.pairs.length} known-bad id(s)`);
      emit('repair', 'fix', {
        reqId, phase: 'known-bad', ids: ahead.pairs.length, refs: 0,
        pairs: ahead.pairs.slice(0, 20),
        message: `${ahead.pairs.length} 个此前被中转站拒绝过的 id 已提前换掉，省去重试`,
      });
    }
    inspectHistory(reqId, body.toString('utf8'));
  }

  const headers = { ...clientReq.headers };
  delete headers.host;
  delete headers['content-length'];
  // The body is fully buffered here, so it goes upstream with an explicit
  // length. Leaving the client's chunked encoding header on would make the
  // request invalid and the upstream would answer 400.
  delete headers['transfer-encoding'];
  headers['accept-encoding'] = 'identity';
  if (body.length) headers['content-length'] = String(body.length);
  // A relay-specific key lets you switch relays without editing auth.json.
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;

  const transport = target.protocol === 'http:' ? http : https;
  const upstreamPath = target.passthroughPath ? clientReq.url : mapPath(clientReq.url, target.basePath);
  const upstreamReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: clientReq.method,
    path: upstreamPath,
    headers,
    ...(useProxy ? { agent: tunnelAgent(systemProxy, target.hostname, target.port) } : {}),
  }, (upstreamRes) => {
    const outHeaders = { ...upstreamRes.headers };
    const encoding = String(upstreamRes.headers['content-encoding'] || '').toLowerCase();
    const compressed = encoding && encoding !== 'identity';
    const contentType = String(upstreamRes.headers['content-type'] || '');
    // Node already decoded the chunked framing, and re-frames whatever we
    // write. Carrying the upstream header over would conflict with the
    // content-length we set below.
    delete outHeaders['transfer-encoding'];

    // If the upstream ignored our identity request, pass the bytes straight
    // through rather than corrupting a compressed body.
    if (compressed) {
      delete outHeaders['content-length'];
      clientRes.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(clientRes);
      return;
    }

    emit('response', upstreamRes.statusCode >= 400 ? 'error' : 'info', {
      reqId, status: upstreamRes.statusCode, contentType, viaProxy: useProxy,
      stream: contentType.includes('text/event-stream'), relay: target.name,
    });

    // A rejected request comes back as 4xx but still labelled text/event-stream,
    // with a plain JSON body rather than SSE frames. Capture it here, otherwise
    // it slips past the stream path unlogged and the dashboard shows nothing.
    const streamStatus = upstreamRes.statusCode || 0;
    if (contentType.includes('text/event-stream') && streamStatus >= 400) {
      const chunks = [];
      upstreamRes.on('data', (c) => chunks.push(Buffer.from(c)));
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let message = raw.slice(0, 300);
        try {
          const parsed = JSON.parse(raw);
          message = parsed?.error?.message ?? message;
        } catch {}
        emit('error', 'error', {
          reqId, where: 'upstream', status: streamStatus, relay: target.name,
          message, body: raw.slice(0, 1200),
        });
        explainRejection(reqId, message);
        log(`upstream ${streamStatus} ${clientReq.url} ${message.slice(0, 200)}`);

        // Recover from a poisoned function_call id by renaming it and retrying,
        // rather than handing Codex an error it cannot get past.
        if (/required 'reasoning' item/i.test(message) && !clientRes.headersSent) {
          const attempts = clientReq.__idRetries ?? 0;
          const callItemId = message.match(/Item '([^']+)'/)?.[1];
          if (callItemId && attempts < MAX_ID_RETRIES) {
            const renamed = renameRejectedCall(requestBody.toString('utf8'), callItemId);
            if (renamed) {
              rememberPoisoned(renamed.from, renamed.type);
              clientReq.__idRetries = attempts + 1;
              emit('retry', 'warn', {
                reqId,
                reason: 'rejected function_call id',
                mode: 'rename',
                from: renamed.from,
                to: renamed.to,
                message: `中转站拒绝了这个 function_call id，已换成新 id 重试（第 ${attempts + 1} 次）`,
              });
              log(`retrying ${clientReq.url} with renamed id ${renamed.from} -> ${renamed.to}`);
              forward(clientReq, clientRes, Buffer.from(renamed.text, 'utf8'), target, viaProxy, true);
              return;
            }
          }
        }

        delete outHeaders['content-length'];
        clientRes.writeHead(streamStatus, outHeaders);
        clientRes.end(raw);
        emit('done', 'info', { reqId, status: streamStatus });
      });
      upstreamRes.on('error', (err) => {
        emit('error', 'error', { reqId, where: 'stream', code: err.code, message: err.message });
        clientRes.end();
      });
      return;
    }

    if (contentType.includes('text/event-stream')) {
      delete outHeaders['content-length'];
      delete outHeaders['content-encoding'];
      clientRes.writeHead(upstreamRes.statusCode || 502, outHeaders);
      clientRes.flushHeaders?.();
      let streamIds = 0, streamRefs = 0;
      // A relay can report a failure inside a 200 stream. Without this the
      // dashboard showed nothing while Codex was visibly stuck.
      let sawStreamError = false;
      const watchForErrors = (text) => {
        if (sawStreamError) return;
        if (!text.includes('"error"') && !text.includes('response.failed')
            && !text.includes('"incomplete"')) return;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const body = line.slice(5).trim();
          if (!body || body === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(body); } catch { continue; }
          const err = parsed.error ?? parsed.response?.error
            ?? (parsed.type === 'error' ? parsed : null);
          const failed = parsed.type === 'response.failed' || parsed.response?.status === 'failed';
          if (!err && !failed) continue;
          sawStreamError = true;
          emit('error', 'error', {
            reqId, where: 'upstream-stream', relay: target.name,
            message: err?.message ?? parsed.response?.status ?? 'stream reported a failure',
            body: body.slice(0, 1200),
          });
          log(`stream error ${clientReq.url} ${(err?.message ?? '').slice(0, 200)}`);
          return;
        }
      };
      const rewriter = makeSseRewriter(remap, (c) => {
        log(`stream   ${clientReq.url} repaired ids=${c.ids} refs=${c.refs}`);
        streamIds += c.ids;
        streamRefs += c.refs;
        if (c.pairs.length) {
          emit('repair', 'fix', { reqId, phase: 'stream', ids: c.ids, refs: c.refs, pairs: c.pairs.slice(0, 20) });
        }
      });
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk) => {
        const out = rewriter.push(chunk);
        if (out) watchForErrors(out);
        clientRes.write(out);
      });
      upstreamRes.on('end', () => {
        const rest = rewriter.flush();
        if (rest) clientRes.write(rest);
        clientRes.end();
        emit('done', 'info', { reqId, streamIds, streamRefs });
      });
      upstreamRes.on('error', (err) => {
        emit('error', 'error', { reqId, where: 'stream', code: err.code, message: err.message });
        clientRes.end();
      });
      return;
    }

    const chunks = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      let out = Buffer.concat(chunks);
      const result = sanitizeJsonText(out.toString('utf8'), remap, { screen: false });
      if (result) {
        out = Buffer.from(result.text, 'utf8');
        log(`response ${clientReq.url} repaired ids=${result.counters.ids} refs=${result.counters.refs}`);
        emit('repair', 'fix', {
          reqId, phase: 'response', ids: result.counters.ids, refs: result.counters.refs,
          pairs: result.counters.pairs.slice(0, 20),
        });
      }
      // Surface relay-side rejections verbatim; this is what the user needs to see.
      if ((upstreamRes.statusCode || 0) >= 400) {
        const raw = out.toString('utf8');
        let message = raw.slice(0, 300);
        try { message = JSON.parse(raw)?.error?.message ?? message; } catch {}
        emit('error', 'error', {
          reqId, where: 'upstream', status: upstreamRes.statusCode,
          message, body: raw.slice(0, 1200),
        });
        explainRejection(reqId, message);
      }
      delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(out.length);
      clientRes.writeHead(upstreamRes.statusCode || 502, outHeaders);
      clientRes.end(out);
      emit('done', 'info', { reqId, status: upstreamRes.statusCode });
    });
    upstreamRes.on('error', (err) => {
      emit('error', 'error', { reqId, where: 'response', code: err.code, message: err.message });
      clientRes.end();
    });
  });

  // Without this a stalled socket can hang for over an hour: one request was
  // observed taking 5847s. The timer is on *inactivity*, not total duration, so
  // a long but healthy stream keeps resetting it while a dead one fails fast
  // and becomes a retry instead of a hang.
  upstreamReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    log(`upstream idle ${UPSTREAM_IDLE_TIMEOUT_MS}ms ${clientReq.url} — destroying`);
    emit('error', 'error', {
      reqId, where: 'upstream-idle', relay: target.name,
      message: `上游 ${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒没有任何数据，已断开（避免无限挂住）`,
    });
    upstreamReq.destroy(new Error('upstream idle timeout'));
  });

  upstreamReq.on('error', (err) => {
    log(`upstream error ${clientReq.url} ${err.code || ''} ${err.message}${useProxy ? ' (via system proxy)' : ''}`);
    emit('error', 'error', {
      reqId, where: 'upstream-connect', code: err.code, message: err.message,
      viaProxy: useProxy, relay: target.name, upstream: target.baseUrl,
    });
    // If the system proxy is down, try once more without the tunnel rather than
    // taking Codex offline. Only safe while nothing has been sent downstream.
    if (useProxy && !isRetry && !clientRes.headersSent) {
      log(`retrying ${clientReq.url} with a direct connection`);
      emit('retry', 'warn', { reqId, reason: err.code || err.message, mode: 'direct' });
      forward(clientReq, clientRes, requestBody, target, false, true);
      return;
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: { message: 'id-sanitizing-proxy upstream error: ' + err.message } }));
  });

  if (body.length) upstreamReq.write(body);
  upstreamReq.end();
}

export function createServer() {
  return http.createServer((clientReq, clientRes) => {
    if (clientReq.url === HEALTH_PATH) {
      const target = currentTarget();
      const payload = JSON.stringify({
        ok: true,
        upstream: target.baseUrl,
        relay: target.name,
        relayId: target.id,
        hasRelayKey: Boolean(target.apiKey),
        ...stats,
      });
      clientRes.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
      clientRes.end(payload);
      return;
    }
    stats.requests++;
    const chunks = [];
    clientReq.on('data', (c) => chunks.push(c));
    clientReq.on('end', () => forward(clientReq, clientRes, Buffer.concat(chunks)));
    clientReq.on('error', () => clientRes.end());
  });
}

loadPoisoned();

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`port ${PORT} already in use — another proxy instance is probably running`);
      emit('error', 'error', { where: 'listen', code: err.code, message: `端口 ${PORT} 已被占用，可能已有一个代理实例在运行` });
      process.exit(1);
    }
    log(`server error ${err.code || ''} ${err.message}`);
    emit('error', 'error', { where: 'listen', code: err.code, message: err.message });
    process.exit(1);
  });
  // Long-lived streaming responses must not be cut short.
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 75_000;
  server.listen(PORT, '127.0.0.1', () => {
    const target = currentTarget();
    const via = proxyFor(target) ? ` via ${SYSTEM_PROXY.origin}` : ' directly';
    log(`listening on http://127.0.0.1:${PORT} -> ${target.baseUrl}${via}`);
    emit('listening', 'info', {
      port: PORT, upstream: target.baseUrl, relay: target.name,
      systemProxy: proxyFor(target) ? SYSTEM_PROXY.origin : null, pid: process.pid,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      emit('stopped', 'warn', { reason: signal, pid: process.pid });
      flushLogs();
      process.exit(0);
    });
  }
  // Buffered lines would otherwise be lost on a normal exit.
  process.on('exit', flushLogs);
}
