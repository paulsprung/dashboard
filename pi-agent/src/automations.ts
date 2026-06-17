import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Automations / schedules ───────────────────────────────────────────────────
// Time-based rules that fire a device action on a weekly schedule. They live on the
// Pi and run 24/7 even if the dashboard is down. Times use the Pi's local timezone
// (set TZ in the container to match your home).

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  deviceId: string;
  action: string;                 // e.g. 'on' | 'off' | 'toggle' | 'wake'
  params?: Record<string, unknown>;
  time: string;                   // 'HH:MM' 24h, Pi local time
  days: number[];                 // weekdays, 0=Sun … 6=Sat (empty = every day)
  lastRun?: number;               // epoch ms of the last fire
};

const dataDir = process.env.DATA_DIR ?? './data';
const file = path.join(dataDir, 'automations.json');
let automations: Automation[] = [];

function save() {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(automations, null, 2));
  } catch (e) { console.error('[automations] save failed', e); }
}

export function loadAutomations() {
  try {
    automations = JSON.parse(readFileSync(file, 'utf8')) as Automation[];
  } catch { automations = []; }
}

export const listAutomations = (): Automation[] => automations;

const sanitize = (a: Partial<Automation>): Omit<Automation, 'id' | 'lastRun'> | null => {
  if (!a.name || !a.deviceId || !a.action || !a.time) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time)) return null;
  const days = Array.isArray(a.days) ? [...new Set(a.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [];
  return {
    name: String(a.name).slice(0, 80),
    enabled: a.enabled !== false,
    deviceId: String(a.deviceId),
    action: String(a.action),
    params: a.params && typeof a.params === 'object' ? a.params : undefined,
    time: a.time,
    days,
  };
};

export function addAutomation(input: Partial<Automation>): Automation | null {
  const clean = sanitize(input);
  if (!clean) return null;
  const auto: Automation = { id: crypto.randomBytes(8).toString('base64url'), ...clean };
  automations.push(auto);
  save();
  return auto;
}

export function updateAutomation(id: string, input: Partial<Automation>): Automation | null {
  const idx = automations.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  // Allow a lightweight enable/disable toggle without re-sending the whole rule.
  if (input.enabled !== undefined && Object.keys(input).length === 1) {
    automations[idx].enabled = !!input.enabled;
    save();
    return automations[idx];
  }
  const clean = sanitize(input);
  if (!clean) return null;
  automations[idx] = { ...automations[idx], ...clean, id };
  save();
  return automations[idx];
}

export function deleteAutomation(id: string): boolean {
  const before = automations.length;
  automations = automations.filter((a) => a.id !== id);
  if (automations.length === before) return false;
  save();
  return true;
}

export function forgetDeviceAutomations(deviceId: string) {
  const before = automations.length;
  automations = automations.filter((a) => a.deviceId !== deviceId);
  if (automations.length !== before) save();
}

// True when this rule should fire for the given moment: weekday matches (or runs every
// day), the HH:MM matches, and it hasn't already fired in this minute.
export function isDue(a: Automation, at: Date): boolean {
  if (!a.enabled) return false;
  if (a.days.length && !a.days.includes(at.getDay())) return false;
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== a.time) return false;
  return !a.lastRun || at.getTime() - a.lastRun >= 60_000;
}

export function markRun(id: string, ts: number) {
  const a = automations.find((x) => x.id === id);
  if (a) { a.lastRun = ts; save(); }
}
