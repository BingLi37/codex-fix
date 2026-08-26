// Repair malformed `custom_tool_call.id` prefixes in Codex rollout files.
// The Responses API rejects any custom_tool_call whose id does not begin with `ctc`,
// which fails every subsequent turn because the whole history is replayed.
// Only the id prefix is rewritten; the unique suffix and all other bytes are preserved.
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_HOME } from './relay-config.mjs';

const SESSIONS = path.join(CODEX_HOME, 'sessions');
const APPLY = process.argv.includes('--apply');
const NEEDLE = '"payload":{"type":"custom_tool_call","id":"';

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

function fixedId(id) {
  if (id.startsWith('ctc_')) return null;
  const suffix = id.startsWith('fc_') ? id.slice(3)
    : id.startsWith('item_') ? id.slice(5)
    : id.includes('_') ? id.slice(id.indexOf('_') + 1)
    : id;
  return 'ctc_' + suffix;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(CODEX_HOME, 'backups', 'ctc-id-repair-' + stamp);

// Other item types also carry wrong prefixes, and the relay has started
// rejecting some of them. The proxy corrects all of that in flight, so these are
// only surveyed and reported here — rewriting rollout files is riskier than
// fixing requests on the way out, and buys nothing while the proxy is running.
const SURVEY_PREFIX = {
  custom_tool_call: 'ctc_',
  custom_tool_call_output: 'ctco_',
  function_call: 'fc_',
  function_call_output: 'fco_',
  reasoning: 'rs_',
  message: 'msg_',
};

function surveyOtherTypes(files) {
  const counts = {};
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"response_item"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const p = obj.payload;
      const want = SURVEY_PREFIX[p?.type];
      if (!want || typeof p.id !== 'string' || p.id.startsWith(want)) continue;
      if (p.type === 'custom_tool_call') continue; // handled below
      const key = `${p.type} (需 ${want})`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

let filesChanged = 0, idsChanged = 0;
const report = [];

for (const file of walk(SESSIONS)) {
  const original = fs.readFileSync(file, 'utf8');
  if (!original.includes(NEEDLE)) continue;

  const lines = original.split('\n');
  const existingIds = new Set();
  const pending = [];

  lines.forEach((line, i) => {
    if (!line.includes(NEEDLE)) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type !== 'response_item') return;
    const id = obj.payload?.id;
    if (typeof id !== 'string') return;
    existingIds.add(id);
    const next = fixedId(id);
    if (next) pending.push({ lineNo: i + 1, from: id, to: next, callId: obj.payload.call_id });
  });

  if (!pending.length) continue;

  const collisions = pending.filter(p => existingIds.has(p.to));
  if (collisions.length) {
    report.push({ file, error: 'id collision, skipped: ' + collisions.map(c => c.to).join(', ') });
    continue;
  }

  let repaired = original;
  for (const p of pending) {
    const from = NEEDLE + p.from + '"';
    const to = NEEDLE + p.to + '"';
    const occurrences = repaired.split(from).length - 1;
    if (occurrences !== 1) {
      report.push({ file, error: `expected 1 occurrence of ${p.from}, found ${occurrences}` });
      repaired = null;
      break;
    }
    repaired = repaired.replace(from, to);
  }
  if (repaired === null) continue;

  // Integrity checks: same line count, every line still parses, no malformed ids left.
  const newLines = repaired.split('\n');
  if (newLines.length !== lines.length) {
    report.push({ file, error: 'line count changed' });
    continue;
  }
  let parseFail = 0, remaining = 0;
  for (const line of newLines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { parseFail++; continue; }
    if (obj.type === 'response_item' && obj.payload?.type === 'custom_tool_call'
        && !String(obj.payload.id).startsWith('ctc_')) remaining++;
  }
  if (parseFail || remaining) {
    report.push({ file, error: `validation failed (parseFail=${parseFail}, remaining=${remaining})` });
    continue;
  }

  const expectedDelta = pending.reduce((n, p) => n + (p.to.length - p.from.length), 0);
  const actualDelta = Buffer.byteLength(repaired) - Buffer.byteLength(original);
  if (actualDelta !== expectedDelta) {
    report.push({ file, error: `byte delta ${actualDelta} != expected ${expectedDelta}` });
    continue;
  }

  if (APPLY) {
    const rel = path.relative(SESSIONS, file);
    const dest = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    // codex.exe keeps handles on recent rollouts, so rename() hits EPERM.
    // Overwrite in place and truncate to the new length instead.
    const buf = Buffer.from(repaired, 'utf8');
    let fd;
    try {
      fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, buf, 0, buf.length, 0);
      fs.ftruncateSync(fd, buf.length);
      fs.fsyncSync(fd);
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      report.push({ file, error: 'write failed: ' + e.code + ' ' + e.message });
      continue;
    }
    fs.closeSync(fd);
    const verify = fs.readFileSync(file, 'utf8');
    if (verify !== repaired) {
      report.push({ file, error: 'post-write verify mismatch' });
      continue;
    }
  }

  filesChanged++;
  idsChanged += pending.length;
  report.push({ file, fixed: pending.length, samples: pending.slice(0, 3) });
}

console.log((APPLY ? 'APPLIED' : 'DRY RUN') + `  custom_tool_call 前缀: files=${filesChanged}  ids=${idsChanged}`);
if (APPLY) console.log('backup: ' + backupRoot);
for (const r of report) {
  if (r.error) console.log('  !! ' + path.relative(SESSIONS, r.file) + '  ' + r.error);
  else console.log('  ' + String(r.fixed).padStart(4) + '  ' + path.relative(SESSIONS, r.file));
}

const survey = surveyOtherTypes(walk(SESSIONS));
const surveyTotal = Object.values(survey).reduce((a, b) => a + b, 0);
console.log('');
if (!surveyTotal) {
  console.log('其他类型的前缀: 无');
} else {
  console.log(`其他类型也有前缀不对的项，共 ${surveyTotal} 个：`);
  for (const [k, n] of Object.entries(survey).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + String(n).padStart(4) + '  ' + k);
  }
  console.log('这些不改文件：代理会在请求发出前就地修好，改文件反而更容易出问题。');
  console.log('（没有 encrypted_content 的 reasoning 项会被去掉 id，而不是改成 rs_，');
  console.log(' 因为那种 id 在 store=false 下查不到。）');
}
