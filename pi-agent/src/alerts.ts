// ── Alert rules ──────────────────────────────────────────────────────────────
// Decides *when* to fire a notification. Two sources:
//   • Pi health — temperature / disk / memory crossing a threshold (with hysteresis
//     so it alerts on the way up and "recovered" on the way back down, never spams).
//   • Device reachability — a monitored device going offline / coming back.

import { sendNotification, notificationsEnabled } from './notify.js';

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const alertThresholds = {
  tempC: num(process.env.ALERT_TEMP_C, 75),
  diskPct: num(process.env.ALERT_DISK_PCT, 90),
  memPct: num(process.env.ALERT_MEM_PCT, 92),
};
const RECOVER_MARGIN = 5; // must drop this far below the threshold before "recovered"

type Metrics = { tempC: number | null; diskPct: number | null; memPct: number | null };
const inAlert: Record<string, boolean> = {};

// Evaluate one health signal: fire on cross-up, "recovered" on cross-down past the margin.
function evalSignal(key: string, label: string, value: number | null, threshold: number, unit: string, emoji: string) {
  if (value == null) return;
  const active = inAlert[key] ?? false;
  if (!active && value >= threshold) {
    inAlert[key] = true;
    void sendNotification({ title: `${emoji} Pi ${label} high`, message: `${label} is ${value}${unit} (threshold ${threshold}${unit}).`, priority: 'high', tags: ['warning'] });
  } else if (active && value <= threshold - RECOVER_MARGIN) {
    inAlert[key] = false;
    void sendNotification({ title: `✅ Pi ${label} recovered`, message: `${label} back to ${value}${unit}.`, priority: 'low' });
  }
}

export function evaluatePiHealth(m: Metrics) {
  if (!notificationsEnabled()) return;
  evalSignal('temp', 'temperature', m.tempC, alertThresholds.tempC, '°C', '🌡️');
  evalSignal('disk', 'disk usage', m.diskPct, alertThresholds.diskPct, '%', '💾');
  evalSignal('mem', 'memory', m.memPct, alertThresholds.memPct, '%', '🧠');
}

// Device reachability transitions. We skip the very first observation per device so a
// fresh start doesn't alert for everything that merely hasn't been checked yet.
const deviceOnline = new Map<string, boolean>();

export function evaluateDeviceState(deviceId: string, label: string, online: boolean) {
  if (!notificationsEnabled()) { deviceOnline.set(deviceId, online); return; }
  const prev = deviceOnline.get(deviceId);
  deviceOnline.set(deviceId, online);
  if (prev === undefined || prev === online) return;
  if (!online) void sendNotification({ title: '🔴 Device offline', message: `${label} stopped responding.`, priority: 'high', tags: ['red_circle'] });
  else void sendNotification({ title: '🟢 Device back online', message: `${label} is reachable again.`, priority: 'default', tags: ['green_circle'] });
}

export function forgetDevice(deviceId: string) {
  deviceOnline.delete(deviceId);
}
