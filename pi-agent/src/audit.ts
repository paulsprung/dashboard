import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── Audit log ───────────────────────────────────────────────────────────────
// Two-tier logging:
//   Persistent file  → only real device actions (human-readable, stays small)
//   In-memory ring   → all event kinds (config changes, heartbeats, auth fails)
//                      available in the dashboard audit viewer, lost on restart

export type AuditKind =
  | 'action'            // a device action was executed — written to file
  | 'config_create'
  | 'config_update'
  | 'config_delete'
  | 'agent_register'
  | 'agent_ip_change'
  | 'discovery'
  | 'alert'             // a notification was triggered (device offline, Pi health…)
  | 'auth_fail';

export type AuditEntry = {
  ts: number;             // epoch ms
  kind: AuditKind;
  ok: boolean;
  actor?: string;         // user email forwarded from the dashboard
  deviceId?: string;
  deviceType?: string;
  action?: string;
  target?: string;        // resolved local target, e.g. "192.168.1.50:8006"
  statusCode?: number;
  latencyMs?: number;
  message?: string;
};

const dataDir = process.env.DATA_DIR ?? './data';
const logFile = path.join(dataDir, 'audit.log');
const MAX_MEMORY = 1000;
const ring: AuditEntry[] = [];

// Human-readable device type labels for the log file
const typeLabel: Record<string, string> = {
  shelly_plug: 'Steckdose', shelly_light: 'Lampe', tasmota: 'Tasmota',
  wol: 'Wake-on-LAN', proxmox: 'Proxmox', rdp: 'RDP', ssh: 'SSH',
  http: 'HTTP', docker: 'Docker', tailscale: 'Tailscale',
};

// Human-readable action labels
const actionLabel: Record<string, string> = {
  on: 'eingeschaltet', off: 'ausgeschaltet', toggle: 'umgeschaltet',
  wake: 'aufgeweckt (WOL)', status: 'Status abgefragt',
  list_vms: 'VMs abgerufen', list_containers: 'Container abgerufen',
  list_devices: 'Geräte abgerufen', energy: 'Energieverbrauch abgefragt',
};

const formatLine = (e: AuditEntry): string => {
  const d = new Date(e.ts);
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const who   = e.actor ?? 'unbekannt';
  const what  = `${typeLabel[e.deviceType ?? ''] ?? e.deviceType ?? '?'} (${e.target ?? e.deviceId ?? '?'})`;
  const verb  = actionLabel[e.action ?? ''] ?? e.action ?? '?';
  const state = e.ok ? `✓${e.latencyMs != null ? ` ${e.latencyMs}ms` : ''}` : `✗ ${e.message ?? 'Fehler'}`;
  return `${ts}  ${who.padEnd(30)}  ${what.padEnd(40)}  ${verb.padEnd(25)}  ${state}`;
};

// On startup, parse the log file back into the ring so the dashboard can show
// recent action history even after a restart.
const loadTail = () => {
  try {
    const raw = readFileSync(logFile, 'utf8');
    const lines = raw.trimEnd().split('\n').slice(-MAX_MEMORY);
    // The file is human-readable, not JSON — rebuild minimal ring entries
    // We only reconstruct enough for the dashboard's "recent actions" view.
    // Exact field recovery isn't possible from the text format, so we store
    // the raw line as the message so it still shows up in the audit viewer.
    for (const line of lines) {
      if (!line.trim()) continue;
      // Parse timestamp from the start of the line (YYYY-MM-DD HH:MM:SS)
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const ts = tsMatch ? new Date(tsMatch[1]).getTime() : Date.now();
      const ok = line.includes(' ✓');
      ring.push({ ts, kind: 'action', ok, message: line.trim() });
    }
    if (ring.length) console.log(`Audit: loaded ${ring.length} recent action entries`);
  } catch {
    // No log file yet — first run
  }
};
loadTail();

export const logEvent = (entry: Omit<AuditEntry, 'ts'>): void => {
  const full: AuditEntry = { ts: Date.now(), ...entry };

  // Always add to in-memory ring (for dashboard audit viewer)
  ring.push(full);
  if (ring.length > MAX_MEMORY) ring.shift();

  // Only write device actions to the persistent file — keeps it lean and readable
  if (full.kind === 'action') {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(logFile, formatLine(full) + '\n', 'utf8');
    } catch (err) {
      console.error('Audit write failed:', err);
    }
  }

  // Always mirror to stdout (docker compose logs)
  const tag = full.ok ? 'OK ' : 'ERR';
  const bits = [full.kind, full.deviceType, full.action, full.target, full.actor && `by ${full.actor}`]
    .filter(Boolean).join(' ');
  console.log(`[audit ${tag}] ${bits}${full.message ? ` — ${full.message}` : ''}`);
};

export const getRecent = (limit = 200, kind?: AuditKind): AuditEntry[] => {
  const filtered = kind ? ring.filter((e) => e.kind === kind) : ring;
  return filtered.slice(-limit).reverse(); // newest first
};
