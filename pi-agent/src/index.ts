import 'dotenv/config';
import express from 'express';
import { startMdnsListener, runDiscovery, getLastResults } from './discovery.js';
import { executeDeviceAction, type DeviceConfig } from './proxy.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT ?? 3002);
const agentSecret = process.env.AGENT_SECRET;
const bindHost = process.env.BIND_HOST ?? '0.0.0.0';

if (!agentSecret) {
  console.error('AGENT_SECRET environment variable is required. Refusing to start.');
  process.exit(1);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${agentSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

// ── Registered host agents ────────────────────────────────────────────────────

type HostAgent = {
  id: string;
  hostname: string;
  ip: string;
  tailscaleIp?: string;
  os?: string;
  services: string[];
  registeredAt: number;
  lastSeen: number;
};
const hostAgents = new Map<string, HostAgent>();

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0', uptime: process.uptime() });
});

// Proxy: execute device action locally
app.post('/proxy', async (req, res) => {
  const { config, action, ...params } = req.body as {
    config: DeviceConfig;
    action: string;
    [key: string]: unknown;
  };
  if (!config || !action) {
    return res.status(400).json({ error: 'config and action are required' });
  }
  try {
    const result = await executeDeviceAction(config, action, params);
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Device action failed';
    console.error('proxy error', { type: config.type, action, msg });
    return res.status(502).json({ error: msg });
  }
});

// Discovery: trigger a scan
app.post('/discover', async (_req, res) => {
  res.json({ ok: true, message: 'Discovery started' });
  // Run in background so the response is immediate
  void runDiscovery(process.env.LOCAL_SUBNET).then((results) => {
    console.log(`Discovery complete: ${results.length} devices found`);
  });
});

// Discovery: get last results
app.get('/discover/results', (_req, res) => {
  res.json(getLastResults());
});

// Host agents: register
app.post('/agents/register', (req, res) => {
  const { hostname, ip, tailscaleIp, os, services } = req.body as Partial<HostAgent>;
  if (!hostname || !ip) return res.status(400).json({ error: 'hostname and ip are required' });
  const id = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const existing = hostAgents.get(id);
  const agent: HostAgent = {
    id,
    hostname,
    ip,
    tailscaleIp,
    os,
    services: services ?? [],
    registeredAt: existing?.registeredAt ?? Date.now(),
    lastSeen: Date.now(),
  };
  hostAgents.set(id, agent);
  console.log(`Host agent registered: ${hostname} (${ip})`);
  return res.json({ ok: true, id });
});

// Host agents: heartbeat
app.post('/agents/heartbeat', (req, res) => {
  const { id, ip, tailscaleIp } = req.body as { id?: string; ip?: string; tailscaleIp?: string };
  if (!id) return res.status(400).json({ error: 'id is required' });
  const agent = hostAgents.get(id);
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });
  agent.lastSeen = Date.now();
  if (ip) agent.ip = ip;
  if (tailscaleIp) agent.tailscaleIp = tailscaleIp;
  return res.json({ ok: true });
});

// Host agents: list
app.get('/agents', (_req, res) => {
  const list = [...hostAgents.values()].map((a) => ({
    ...a,
    online: Date.now() - a.lastSeen < 90_000, // online if seen in last 90s
  }));
  res.json(list);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, bindHost, () => {
  console.log(`SM Pi Agent listening on ${bindHost}:${port}`);
  // Start mDNS listener in background
  startMdnsListener();
  // Run an initial discovery 10s after start
  setTimeout(() => {
    void runDiscovery(process.env.LOCAL_SUBNET).then((r) =>
      console.log(`Initial discovery: ${r.length} devices found`),
    );
  }, 10_000);
});
