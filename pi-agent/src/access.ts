// ── Just-in-Time remote access via the Tailscale ACL policy ───────────────────
//
// Security model (read before touching):
//  • INERT BY DEFAULT. If TS_API_KEY / TS_TAILNET / TS_ADMIN_IDENTITY are not all
//    set, accessEnabled() is false and this module never writes any ACL. Nothing
//    can happen to your tailnet until you deliberately configure it.
//  • DEFAULT-DENY. The live policy is always "your baseline file + the currently
//    active grants". The baseline (data/acl-baseline.json) is YOUR static policy
//    and should be default-deny (only Hetzner↔Pi and admin↔Pi). It is never
//    modified by this code — only read.
//  • LEAST PRIVILEGE + TIME-BOXED. A grant opens exactly one identity → ip:port
//    for a capped TTL, then the sweeper removes it and re-applies (re-closing it).
//  • VALIDATE BEFORE APPLY. Every write is checked against /acl/validate first.
//  • The powerful Tailscale API key lives only here on the Pi — never on the
//    internet-facing dashboard. The dashboard asks the Pi (authenticated with
//    AGENT_SECRET); the Pi performs the change.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logEvent } from './audit.js';
import type { DeviceConfig } from './proxy.js';

const TS_API = 'https://api.tailscale.com/api/v2';
const apiKey = process.env.TS_API_KEY ?? '';
const tailnet = process.env.TS_TAILNET ?? '';
const adminIdentity = process.env.TS_ADMIN_IDENTITY ?? '';
const dataDir = process.env.DATA_DIR ?? './data';
const grantsFile = path.join(dataDir, 'grants.json');
const baselineFile = path.join(dataDir, 'acl-baseline.json');

const DEFAULT_TTL = 15 * 60;        // 15 minutes
const MAX_TTL = 4 * 60 * 60;        // hard cap: 4 hours

export const accessEnabled = (): boolean => Boolean(apiKey && tailnet && adminIdentity);

export type Grant = {
  id: string; deviceId: string; label: string;
  ip: string; port: number; identity: string;
  createdAt: number; expiresAt: number;
};

let grants: Grant[] = [];

const loadGrants = () => {
  try { grants = JSON.parse(readFileSync(grantsFile, 'utf8')) as Grant[]; }
  catch { grants = []; }
};
const saveGrants = () => {
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(grantsFile, JSON.stringify(grants, null, 2)); }
  catch (e) { console.error('Failed to persist grants', e); }
};
loadGrants();

const activeGrants = (): Grant[] => {
  const now = Date.now();
  return grants.filter((g) => g.expiresAt > now);
};

const tsHeaders = () => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

// Default reachable port per device type (overridable by the device's own port).
const webPort = (cfg: DeviceConfig): number => {
  const p = (cfg as { port?: number }).port;
  switch (cfg.type) {
    case 'proxmox': return p ?? 8006;
    case 'ssh':     return p ?? 22;
    case 'rdp':     return p ?? 3389;
    case 'docker':  return p ?? 2375;
    default:        return p ?? 80;
  }
};
const deviceIp = (cfg: DeviceConfig): string | null => (cfg as { ip?: string }).ip ?? null;

const urlFor = (ip: string, port: number): string => {
  if (port === 22) return `ssh://${ip}:${port}`;
  if (port === 3389) return `rdp://${ip}:${port}`;
  const https = port === 8006 || port === 443 || port === 8443;
  return `${https ? 'https' : 'http'}://${ip}:${port}`;
};

// Full policy = your baseline + one accept rule per active grant.
const buildPolicy = (): Record<string, unknown> => {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as { acls?: unknown[] };
  const acls = Array.isArray(baseline.acls) ? [...baseline.acls] : [];
  for (const g of activeGrants()) {
    acls.push({ action: 'accept', src: [g.identity], dst: [`${g.ip}:${g.port}`] });
  }
  return { ...baseline, acls };
};

const applyPolicy = async (): Promise<void> => {
  const policy = buildPolicy();
  const base = `${TS_API}/tailnet/${encodeURIComponent(tailnet)}`;
  const v = await fetch(`${base}/acl/validate`, { method: 'POST', headers: tsHeaders(), body: JSON.stringify(policy) });
  if (!v.ok) throw new Error(`ACL validation failed (${v.status}): ${await v.text()}`);
  const r = await fetch(`${base}/acl`, { method: 'POST', headers: tsHeaders(), body: JSON.stringify(policy) });
  if (!r.ok) throw new Error(`ACL apply failed (${r.status}): ${await r.text()}`);
};

export const listGrants = (): (Grant & { url: string })[] =>
  activeGrants().map((g) => ({ ...g, url: urlFor(g.ip, g.port) }));

export const grantAccess = async (opts: {
  deviceId: string; label: string; cfg: DeviceConfig; ttlSec?: number; actor?: string;
}): Promise<Grant & { url: string }> => {
  if (!accessEnabled()) throw new Error('Remote access not configured (set TS_API_KEY, TS_TAILNET, TS_ADMIN_IDENTITY)');
  const ip = deviceIp(opts.cfg);
  if (!ip) throw new Error('Device has no IP to grant access to');
  const port = webPort(opts.cfg);
  const ttl = Math.min(MAX_TTL, Math.max(60, Math.floor(opts.ttlSec ?? DEFAULT_TTL)));
  const now = Date.now();
  const grant: Grant = {
    id: Math.random().toString(36).slice(2, 14),
    deviceId: opts.deviceId, label: opts.label,
    ip, port, identity: adminIdentity,
    createdAt: now, expiresAt: now + ttl * 1000,
  };
  // One active grant per device — replace any previous one.
  grants = activeGrants().filter((g) => g.deviceId !== opts.deviceId);
  grants.push(grant);
  saveGrants();
  await applyPolicy();
  logEvent({ kind: 'action', ok: true, actor: opts.actor, target: `${ip}:${port}`, action: 'access_grant',
    message: `Remote access opened to ${opts.label} for ${Math.round(ttl / 60)} min` });
  return { ...grant, url: urlFor(ip, port) };
};

export const revokeAccess = async (id: string, actor?: string): Promise<void> => {
  const g = grants.find((x) => x.id === id);
  grants = grants.filter((x) => x.id !== id);
  saveGrants();
  if (accessEnabled()) await applyPolicy();
  if (g) logEvent({ kind: 'action', ok: true, actor, target: `${g.ip}:${g.port}`, action: 'access_revoke',
    message: `Remote access revoked for ${g.label}` });
};

// Periodic sweep: drop expired grants and re-apply so the ACL closes again.
let lastActiveCount = -1;
const reconcile = async (): Promise<void> => {
  const active = activeGrants();
  if (active.length !== grants.length) { grants = active; saveGrants(); }
  if (active.length !== lastActiveCount) {
    lastActiveCount = active.length;
    try { await applyPolicy(); }
    catch (e) { console.error('ACL reconcile failed:', (e as Error).message); }
  }
};

export const startAccessSweeper = (): void => {
  if (!accessEnabled()) { console.log('Remote access: disabled (TS_API_KEY/TS_TAILNET/TS_ADMIN_IDENTITY not set)'); return; }
  console.log('Remote access: enabled (Tailscale JIT grants)');
  // Reconcile on boot only if we have persisted grants (covers grants that
  // expired while the agent was down). Never touches the live policy otherwise.
  if (grants.length > 0) void reconcile();
  setInterval(() => void reconcile(), 30_000);
};
