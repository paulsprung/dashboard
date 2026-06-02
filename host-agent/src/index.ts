import 'dotenv/config';
import { networkInterfaces, hostname as osHostname } from 'node:os';
import { existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

const PI_AGENT_URL = process.env.PI_AGENT_URL ?? '';
const AGENT_SECRET = process.env.AGENT_SECRET ?? '';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? '30', 10) * 1000;
const AGENT_HOSTNAME = process.env.HOSTNAME_OVERRIDE ?? osHostname();

if (!PI_AGENT_URL) {
  console.error('[host-agent] PI_AGENT_URL is required');
  process.exit(1);
}
if (!AGENT_SECRET) {
  console.error('[host-agent] AGENT_SECRET is required');
  process.exit(1);
}

interface NetworkInfo {
  primaryIp: string;
  tailscaleIp: string | null;
}

function getNetworkInfo(): NetworkInfo {
  const ifaces = networkInterfaces();
  let primaryIp = '127.0.0.1';
  let tailscaleIp: string | null = null;

  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Tailscale IPs are always in 100.64.0.0/10
      if (addr.address.startsWith('100.')) {
        tailscaleIp = addr.address;
      } else if (primaryIp === '127.0.0.1') {
        primaryIp = addr.address;
      }
    }
  }

  return { primaryIp, tailscaleIp };
}

interface ServiceInfo {
  hasDocker: boolean;
  hasProxmox: boolean;
  dockerVersion?: string;
  proxmoxVersion?: string;
}

function tcpCheck(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function fetchJsonHttps(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function fetchUnixSocket(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, path, method: 'GET', timeout: 3000 } as unknown as string,
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function detectServices(): Promise<ServiceInfo> {
  const info: ServiceInfo = { hasDocker: false, hasProxmox: false };

  // Docker: prefer unix socket, fall back to TCP 2375
  if (existsSync('/var/run/docker.sock')) {
    info.hasDocker = true;
    try {
      const v = await fetchUnixSocket('/var/run/docker.sock', '/version') as { Version?: string };
      if (v?.Version) info.dockerVersion = v.Version;
    } catch { /* docker present even without version */ }
  } else {
    info.hasDocker = await tcpCheck('127.0.0.1', 2375);
    if (info.hasDocker) {
      try {
        const v = await fetchJson('http://localhost:2375/version') as { Version?: string };
        if (v?.Version) info.dockerVersion = v.Version;
      } catch { /* ignore */ }
    }
  }

  // Proxmox: HTTPS API on 8006
  info.hasProxmox = await tcpCheck('127.0.0.1', 8006);
  if (info.hasProxmox) {
    try {
      const v = await fetchJsonHttps('https://localhost:8006/api2/json/version') as { data?: { version?: string } };
      if (v?.data?.version) info.proxmoxVersion = v.data.version;
    } catch { /* ignore */ }
  }

  return info;
}

function agentPost(path: string, body: object): Promise<void> {
  const url = `${PI_AGENT_URL}${path}`;
  const isHttps = url.startsWith('https://');
  const payload = JSON.stringify(body);
  const parsedUrl = new URL(url);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? '443' : '80'),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_SECRET}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    };

    const req = (isHttps ? httpsRequest : httpRequest)(options as unknown as string, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
      } else {
        resolve();
      }
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface AgentState {
  hostname: string;
  ip: string;
  tailscaleIp: string | null;
  services: ServiceInfo;
}

let lastState: AgentState | null = null;

async function buildState(): Promise<AgentState> {
  const { primaryIp, tailscaleIp } = getNetworkInfo();
  const services = await detectServices();
  return { hostname: AGENT_HOSTNAME, ip: primaryIp, tailscaleIp, services };
}

// Pi Agent stores `services` as a string[], so flatten the detected ServiceInfo.
function servicesList(info: ServiceInfo): string[] {
  const out: string[] = [];
  if (info.hasDocker) out.push(info.dockerVersion ? `docker:${info.dockerVersion}` : 'docker');
  if (info.hasProxmox) out.push(info.proxmoxVersion ? `proxmox:${info.proxmoxVersion}` : 'proxmox');
  return out;
}

async function register(): Promise<void> {
  const state = await buildState();
  lastState = state;
  await agentPost('/agents/register', {
    hostname: state.hostname,
    ip: state.ip,
    tailscaleIp: state.tailscaleIp,
    services: servicesList(state.services),
  });
  console.log(`[host-agent] Registered as "${state.hostname}" (${state.ip}${state.tailscaleIp ? `, ts: ${state.tailscaleIp}` : ''})`);
  if (state.services.hasDocker) console.log(`[host-agent]   Docker${state.services.dockerVersion ? ` v${state.services.dockerVersion}` : ''}`);
  if (state.services.hasProxmox) console.log(`[host-agent]   Proxmox${state.services.proxmoxVersion ? ` v${state.services.proxmoxVersion}` : ''}`);
}

async function heartbeat(): Promise<void> {
  const { primaryIp, tailscaleIp } = getNetworkInfo();

  // Re-register on IP change (DHCP renewal)
  if (lastState && (lastState.ip !== primaryIp || lastState.tailscaleIp !== tailscaleIp)) {
    console.log(`[host-agent] IP changed ${lastState.ip} -> ${primaryIp}, re-registering`);
    await register();
    return;
  }

  await agentPost('/agents/heartbeat', { hostname: AGENT_HOSTNAME, ip: primaryIp, tailscaleIp });
}

async function main() {
  console.log(`[host-agent] Starting — host: "${AGENT_HOSTNAME}", pi-agent: ${PI_AGENT_URL}`);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await register();
      break;
    } catch (err) {
      const delay = Math.min(2 ** attempt * 1000, 30_000);
      console.error(`[host-agent] Registration failed (attempt ${attempt}): ${(err as Error).message}`);
      if (attempt === 5) { console.error('[host-agent] Giving up'); process.exit(1); }
      console.log(`[host-agent] Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  setInterval(async () => {
    try {
      await heartbeat();
    } catch (err) {
      console.error(`[host-agent] Heartbeat failed: ${(err as Error).message}`);
    }
  }, HEARTBEAT_INTERVAL);
}

main().catch((err) => { console.error('[host-agent] Fatal:', err); process.exit(1); });
