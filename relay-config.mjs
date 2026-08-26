// Shared relay configuration for the proxy and the control panel.
//
// Codex's base_url stays permanently at http://127.0.0.1:7801/v1. Switching
// relays happens here instead, so config.toml never needs editing again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Codex's own data directory. Codex honours CODEX_HOME, so do the same instead
// of assuming the default location.
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
export const RELAY_CONFIG_PATH = process.env.CODEX_RELAY_CONFIG
  ?? path.join(HERE, 'relays.json');

// The local prefix Codex is configured with. Everything after it is forwarded
// onto the active relay's own base path.
export const LOCAL_PREFIX = '/v1';

const DEFAULT_CONFIG = {
  active: 'agentrouter',
  relays: [
    { id: 'agentrouter', name: 'agentrouter', baseUrl: 'https://agentrouter.org/v1', apiKey: '' },
  ],
};

export function readRelayConfig() {
  let raw;
  try {
    raw = fs.readFileSync(RELAY_CONFIG_PATH, 'utf8');
  } catch {
    // No file yet: first run, or it was deleted.
    return { ...DEFAULT_CONFIG, fallback: 'absent' };
  }
  try {
    const parsed = JSON.parse(raw);
    const relays = Array.isArray(parsed.relays) ? parsed.relays.filter((r) => r?.id && r?.baseUrl) : [];
    if (!relays.length) return { ...DEFAULT_CONFIG, fallback: 'empty' };
    const active = relays.some((r) => r.id === parsed.active) ? parsed.active : relays[0].id;
    return { active, relays };
  } catch {
    return { ...DEFAULT_CONFIG, fallback: 'corrupt' };
  }
}

export function writeRelayConfig(config) {
  // Never silently discard a file we could not parse; keep a copy first so a
  // hand-edit mistake does not lose the relay list.
  try {
    const existing = fs.readFileSync(RELAY_CONFIG_PATH, 'utf8');
    JSON.parse(existing);
  } catch (err) {
    if (err instanceof SyntaxError) {
      try {
        fs.copyFileSync(RELAY_CONFIG_PATH, RELAY_CONFIG_PATH + '.corrupt-' + Date.now());
      } catch {}
    }
  }
  return writeRelayConfigUnchecked(config);
}

function writeRelayConfigUnchecked(config) {
  const clean = {
    active: config.active,
    relays: config.relays.map((r) => ({
      id: r.id,
      name: r.name || r.id,
      baseUrl: String(r.baseUrl).replace(/\/+$/, ''),
      apiKey: r.apiKey || '',
    })),
  };
  fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

export function activeRelay(config = readRelayConfig()) {
  return config.relays.find((r) => r.id === config.active) ?? config.relays[0];
}

// Splits a relay base URL into the pieces the proxy needs to forward a request.
export function parseRelay(relay) {
  const url = new URL(relay.baseUrl);
  return {
    id: relay.id,
    name: relay.name || relay.id,
    origin: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    // "/v1" from https://host/v1, or "" when the relay has no path prefix.
    basePath: url.pathname.replace(/\/+$/, ''),
    apiKey: relay.apiKey || '',
    baseUrl: relay.baseUrl,
  };
}

// Rewrites the path Codex asked for onto the relay's own base path, so a relay
// served from https://host/api/v3 still receives /api/v3/responses.
export function mapPath(incomingUrl, basePath) {
  const [pathOnly, query] = String(incomingUrl).split('?');
  const tail = pathOnly.startsWith(LOCAL_PREFIX) ? pathOnly.slice(LOCAL_PREFIX.length) : pathOnly;
  const mapped = (basePath + (tail.startsWith('/') ? tail : '/' + tail)) || '/';
  return query ? `${mapped}?${query}` : mapped;
}
