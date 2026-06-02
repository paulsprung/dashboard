import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import { startMdnsListener, runDiscovery, getLastResults } from './discovery.js';
import { executeDeviceAction } from './proxy.js';
import type { DeviceConfig } from './proxy.js';
import { logEvent, getRecent, type AuditKind } from './audit.js';

// Best-effort human-readable target for the audit log (what the Pi will contact)
const describeTarget = (cfg: DeviceConfig): string => {
  if (cfg.type === 'wol') return `mac ${cfg.mac}`;
  if (cfg.type === 'tailscale') return 'tailscale-api';
  const ip = (cfg as { ip?: string }).ip;
  const p = (cfg as { port?: number }).port;
  return ip ? (p ? `${ip}:${p}` : ip) : cfg.type;
};

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT ?? 3002);
const agentSecret = process.env.AGENT_SECRET;
const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
const dataDir = process.env.DATA_DIR ?? './data';
const configsFile = path.join(dataDir, 'device-configs.json');

if (!agentSecret) {
  console.error('AGENT_SECRET environment variable is required. Refusing to start.');
  process.exit(1);
}

// ── Device config store ───────────────────────────────────────────────────────
// All sensitive device data (IPs, MACs, tokens) lives here on the Pi — never on Hetzner.

type StoredConfig = DeviceConfig & { id: string };
const deviceConfigs = new Map<string, StoredConfig>();

const loadConfigs = () => {
  try {
    mkdirSync(dataDir, { recursive: true });
    const raw = readFileSync(configsFile, 'utf8');
    const data = JSON.parse(raw) as StoredConfig[];
    for (const cfg of data) deviceConfigs.set(cfg.id, cfg);
    console.log(`Loaded ${deviceConfigs.size} device configs from disk`);
  } catch {
    // File doesn't exist on first run
  }
};

const saveConfigs = () => {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configsFile, JSON.stringify([...deviceConfigs.values()], null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save device configs:', err);
  }
};

loadConfigs();

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${agentSecret}`) {
    logEvent({ kind: 'auth_fail', ok: false, action: `${req.method} ${req.path}`, message: 'Bad or missing bearer token' });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

// ── Registered host agents ────────────────────────────────────────────────────

type HostAgent = {
  id: string; hostname: string; ip: string; tailscaleIp?: string;
  os?: string; services: string[]; registeredAt: number; lastSeen: number;
};
const hostAgents = new Map<string, HostAgent>();

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0', uptime: process.uptime() });
});

// ── Device config CRUD ────────────────────────────────────────────────────────
// Dashboard saves sensitive config here. Dashboard itself never persists IPs/tokens.

app.post('/devices/config', (req, res) => {
  const config = req.body as StoredConfig;
  if (!config.id || !config.type) return res.status(400).json({ error: 'id and type required' });
  deviceConfigs.set(config.id, config);
  saveConfigs();
  logEvent({ kind: 'config_create', ok: true, deviceId: config.id, deviceType: config.type, target: describeTarget(config) });
  return res.json({ ok: true });
});

app.get('/devices/config/:id', (req, res) => {
  const cfg = deviceConfigs.get(req.params.id);
  if (!cfg) return res.status(404).json({ error: 'Config not found' });
  return res.json(cfg);
});

app.put('/devices/config/:id', (req, res) => {
  const config = req.body as StoredConfig;
  config.id = req.params.id;
  if (!config.type) return res.status(400).json({ error: 'type required' });
  deviceConfigs.set(req.params.id, config);
  saveConfigs();
  logEvent({ kind: 'config_update', ok: true, deviceId: config.id, deviceType: config.type, target: describeTarget(config) });
  return res.json({ ok: true });
});

app.delete('/devices/config/:id', (req, res) => {
  const existed = deviceConfigs.get(req.params.id);
  deviceConfigs.delete(req.params.id);
  monitorStatuses.delete(req.params.id);
  saveConfigs();
  logEvent({ kind: 'config_delete', ok: true, deviceId: req.params.id, deviceType: existed?.type });
  return res.json({ ok: true });
});

// ── TCP monitor ───────────────────────────────────────────────────────────────

type MonitorStatus = { deviceId: string; online: boolean; latencyMs: number | null; lastCheck: number };
const monitorStatuses = new Map<string, MonitorStatus>();

const checkTcp = (host: string, port: number, timeoutMs = 2500): Promise<number | null> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(Date.now() - t0); });
    sock.once('error', () => resolve(null));
    sock.once('timeout', () => { sock.destroy(); resolve(null); });
  });

const getCheckTarget = (cfg: StoredConfig): { host: string; port: number } | null => {
  if (cfg.type === 'wol' || cfg.type === 'tailscale') return null;
  const ip = (cfg as { ip?: string }).ip;
  if (!ip) return null;
  const portMap: Record<string, number> = {
    shelly_plug: 80, shelly_light: 80, tasmota: 80, http: 80,
    proxmox: (cfg as { port?: number }).port ?? 8006,
    rdp: (cfg as { port?: number }).port ?? 3389,
    ssh: (cfg as { port?: number }).port ?? 22,
    docker: (cfg as { port?: number }).port ?? 2375,
  };
  const p = portMap[cfg.type];
  return p ? { host: ip, port: p } : null;
};

const runMonitorChecks = async () => {
  const promises = [...deviceConfigs.values()].map(async (cfg) => {
    const target = getCheckTarget(cfg);
    if (!target) return;
    const latency = await checkTcp(target.host, target.port);
    monitorStatuses.set(cfg.id, { deviceId: cfg.id, online: latency !== null, latencyMs: latency, lastCheck: Date.now() });
  });
  await Promise.allSettled(promises);
};

setTimeout(() => void runMonitorChecks(), 8_000);
setInterval(() => void runMonitorChecks(), 30_000);

app.get('/devices/monitor', (_req, res) => {
  res.json([...monitorStatuses.values()]);
});

// ── Proxy: execute device action ──────────────────────────────────────────────
// Accepts either { deviceId, action, ...params } (zero-knowledge mode from dashboard)
// or  { config, action, ...params } (legacy/direct mode, kept for backward compat)

app.post('/proxy', async (req, res) => {
  const { deviceId, config: inlineConfig, action, actor, ...params } = req.body as {
    deviceId?: string;
    config?: DeviceConfig;
    action: string;
    actor?: string;       // user identity forwarded by the dashboard, for the audit trail
    [key: string]: unknown;
  };

  if (!action) return res.status(400).json({ error: 'action is required' });

  let config: DeviceConfig | undefined;
  if (deviceId) {
    const stored = deviceConfigs.get(deviceId);
    if (!stored) {
      logEvent({ kind: 'action', ok: false, actor, deviceId, action, message: 'No config found for device' });
      return res.status(404).json({
        error: `No config found for device "${deviceId}". Re-add the device in Settings to re-register its config.`,
      });
    }
    config = stored;
  } else if (inlineConfig) {
    // Legacy mode: config sent directly (dashboard stores it)
    config = inlineConfig;
  } else {
    return res.status(400).json({ error: 'deviceId or config is required' });
  }

  const t0 = Date.now();
  try {
    const result = await executeDeviceAction(config, action, params);
    logEvent({
      kind: 'action', ok: true, actor, deviceId,
      deviceType: config.type, action, target: describeTarget(config),
      latencyMs: Date.now() - t0,
    });
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Device action failed';
    logEvent({
      kind: 'action', ok: false, actor, deviceId,
      deviceType: config.type, action, target: describeTarget(config),
      latencyMs: Date.now() - t0, message: msg,
    });
    return res.status(502).json({ error: msg });
  }
});

// ── Audit log ──────────────────────────────────────────────────────────────
// Admins read this via the dashboard (proxied over Tailscale). It never leaves
// the Tailscale tunnel — the detailed internal trail stays on the Pi.

app.get('/audit', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const kind = typeof req.query.kind === 'string' ? req.query.kind as AuditKind : undefined;
  res.json({ entries: getRecent(limit, kind) });
});

// ── Discovery ─────────────────────────────────────────────────────────────────

app.post('/discover', async (_req, res) => {
  res.json({ ok: true, message: 'Discovery started' });
  void runDiscovery(process.env.LOCAL_SUBNET).then((results) => {
    logEvent({ kind: 'discovery', ok: true, message: `${results.length} devices found` });
  });
});

app.get('/discover/results', (_req, res) => {
  res.json(getLastResults());
});

// ── Host agents ───────────────────────────────────────────────────────────────

app.post('/agents/register', (req, res) => {
  const { hostname, ip, tailscaleIp, os, services } = req.body as Partial<HostAgent>;
  if (!hostname || !ip) return res.status(400).json({ error: 'hostname and ip are required' });
  const id = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const existing = hostAgents.get(id);
  const agent: HostAgent = {
    id, hostname, ip, tailscaleIp, os,
    services: (services as unknown as string[]) ?? [],
    registeredAt: existing?.registeredAt ?? Date.now(),
    lastSeen: Date.now(),
  };
  hostAgents.set(id, agent);
  logEvent({ kind: 'agent_register', ok: true, target: `${hostname} (${ip})`, message: agent.services.length ? `services: ${agent.services.join(', ')}` : undefined });
  return res.json({ ok: true, id });
});

app.post('/agents/heartbeat', (req, res) => {
  const { hostname, ip, tailscaleIp } = req.body as { hostname?: string; ip?: string; tailscaleIp?: string };
  if (!hostname) return res.status(400).json({ error: 'hostname is required' });
  const id = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const agent = hostAgents.get(id);
  if (!agent) return res.status(404).json({ error: 'Agent not registered. Call /agents/register first.' });
  // Log only when the IP actually changes — heartbeats are too frequent to log every time
  if (ip && ip !== agent.ip) {
    logEvent({ kind: 'agent_ip_change', ok: true, target: hostname, message: `${agent.ip} → ${ip}` });
  }
  agent.lastSeen = Date.now();
  if (ip) agent.ip = ip;
  if (tailscaleIp !== undefined) agent.tailscaleIp = tailscaleIp;
  return res.json({ ok: true });
});

app.get('/agents', (_req, res) => {
  const list = [...hostAgents.values()].map((a) => ({
    ...a,
    online: Date.now() - a.lastSeen < 90_000,
  }));
  res.json(list);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, bindHost, () => {
  console.log(`SM Pi Agent listening on ${bindHost}:${port}`);
  startMdnsListener();
  setTimeout(() => {
    void runDiscovery(process.env.LOCAL_SUBNET).then((r) =>
      console.log(`Initial discovery: ${r.length} devices found`),
    );
  }, 10_000);
});
