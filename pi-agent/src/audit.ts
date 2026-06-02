import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── Audit log ───────────────────────────────────────────────────────────────
// Tracks everything that happens locally on the Pi: device actions, config
// changes, host-agent registrations, discovery runs. Hetzner only knows WHO
// requested an action — the Pi knows WHAT actually happened on the network
// (which IP was contacted, the response code, latency, errors).

export type AuditKind =
  | 'action'            // a device action was executed
  | 'config_create'
  | 'config_update'
  | 'config_delete'
  | 'agent_register'
  | 'agent_ip_change'
  | 'discovery'
  | 'auth_fail';

export type AuditEntry = {
  ts: number;             // epoch ms
  kind: AuditKind;
  ok: boolean;
  actor?: string;         // user email/id forwarded from the dashboard
  deviceId?: string;
  deviceType?: string;
  action?: string;
  target?: string;        // resolved local target, e.g. "192.168.1.50:8006"
  statusCode?: number;    // HTTP status of the upstream call, if any
  latencyMs?: number;
  message?: string;       // error text or extra detail
};

const dataDir = process.env.DATA_DIR ?? './data';
const logFile = path.join(dataDir, 'audit.log');
const MAX_MEMORY = 1000;        // keep last N entries in memory for fast reads
const ring: AuditEntry[] = [];

// Load the tail of the on-disk log into memory on startup, so a restart
// doesn't lose the recent history shown in the dashboard.
const loadTail = () => {
  try {
    const raw = readFileSync(logFile, 'utf8');
    const lines = raw.trimEnd().split('\n').slice(-MAX_MEMORY);
    for (const line of lines) {
      if (!line) continue;
      try { ring.push(JSON.parse(line) as AuditEntry); } catch { /* skip bad line */ }
    }
    if (ring.length) console.log(`Audit: loaded ${ring.length} recent entries`);
  } catch {
    // No log file yet
  }
};
loadTail();

export const logEvent = (entry: Omit<AuditEntry, 'ts'>): void => {
  const full: AuditEntry = { ts: Date.now(), ...entry };
  ring.push(full);
  if (ring.length > MAX_MEMORY) ring.shift();
  // Append durably as JSON-lines (one entry per line)
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(logFile, JSON.stringify(full) + '\n', 'utf8');
  } catch (err) {
    console.error('Audit write failed:', err);
  }
  // Mirror to stdout so `docker compose logs` shows it too
  const tag = full.ok ? 'OK ' : 'ERR';
  const bits = [full.kind, full.deviceType, full.action, full.target, full.actor && `by ${full.actor}`]
    .filter(Boolean).join(' ');
  console.log(`[audit ${tag}] ${bits}${full.message ? ` — ${full.message}` : ''}`);
};

export const getRecent = (limit = 200, kind?: AuditKind): AuditEntry[] => {
  const filtered = kind ? ring.filter((e) => e.kind === kind) : ring;
  return filtered.slice(-limit).reverse(); // newest first
};
