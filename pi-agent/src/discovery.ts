import fs from 'node:fs/promises';
import net from 'node:net';
import mdns from 'multicast-dns';

export type DiscoveredDevice = {
  ip: string;
  mac?: string;
  hostname?: string;
  type: 'shelly_plug' | 'shelly_light' | 'tasmota' | 'proxmox' | 'docker' | 'http' | 'unknown';
  info?: Record<string, unknown>;
  discoveredAt: number;
  via: 'arp' | 'mdns';
};

let lastResults: DiscoveredDevice[] = [];
const mdnsCache = new Map<string, { hostname: string; type: DiscoveredDevice['type'] }>();

// ── ARP table ────────────────────────────────────────────────────────────────

async function readArpTable(): Promise<{ ip: string; mac: string }[]> {
  try {
    const raw = await fs.readFile('/proc/net/arp', 'utf8');
    return raw
      .split('\n')
      .slice(1) // skip header
      .flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[2] !== '0x2') return []; // 0x2 = complete entry
        return [{ ip: parts[0], mac: parts[3] }];
      });
  } catch {
    return [];
  }
}

// ── TCP probe ─────────────────────────────────────────────────────────────────

const tcpProbe = (host: string, port: number, timeoutMs = 1500): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createConnection({ host, port, timeout: timeoutMs });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });

// ── Device fingerprinting ─────────────────────────────────────────────────────

async function fingerprintIp(ip: string): Promise<Omit<DiscoveredDevice, 'ip' | 'mac' | 'discoveredAt' | 'via'>> {
  // Check if mdns gave us a hint
  const mdnsHint = mdnsCache.get(ip);

  // Try Shelly: GET /shelly
  try {
    const r = await fetch(`http://${ip}/shelly`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const data = await r.json() as any;
      if (data?.type || data?.app) {
        const isLight = String(data.type ?? data.app ?? '').toLowerCase().includes('bulb') ||
          String(data.type ?? '').toLowerCase().includes('dim') ||
          String(data.type ?? '').toLowerCase().includes('rgbw');
        return { type: isLight ? 'shelly_light' : 'shelly_plug', hostname: data.hostname, info: data };
      }
    }
  } catch {}

  // Try Tasmota: GET /cm?cmnd=Status0
  try {
    const r = await fetch(`http://${ip}/cm?cmnd=Status0`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const data = await r.json() as any;
      if (data?.Status || data?.status) {
        const s = data.Status ?? data.status;
        return { type: 'tasmota', hostname: s.DeviceName ?? s.Hostname, info: data };
      }
    }
  } catch {}

  // Try Docker: GET :2375/version
  try {
    const r = await fetch(`http://${ip}:2375/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const data = await r.json() as any;
      if (data?.Version) return { type: 'docker', info: data };
    }
  } catch {}

  // Try Proxmox: TCP probe on port 8006
  const proxmoxOpen = await tcpProbe(ip, 8006, 1500);
  if (proxmoxOpen) return { type: 'proxmox', hostname: mdnsHint?.hostname };

  // Generic HTTP
  const httpOpen = await tcpProbe(ip, 80, 1000);
  if (httpOpen) return { type: 'http' };

  return { type: 'unknown' };
}

// ── mDNS listener ─────────────────────────────────────────────────────────────

export function startMdnsListener() {
  const m = mdns();

  m.on('response', (response: any) => {
    const answers = [...(response.answers ?? []), ...(response.additionals ?? [])];
    const ptrRecords = answers.filter((a: any) => a.type === 'PTR');
    const aRecords = answers.filter((a: any) => a.type === 'A');

    for (const ptr of ptrRecords) {
      const service = String(ptr.name ?? '');
      let type: DiscoveredDevice['type'] | null = null;
      if (service.includes('_shelly')) type = 'shelly_plug';
      else if (service.includes('_http') || service.includes('_tasmota')) type = 'tasmota';

      if (type) {
        for (const a of aRecords) {
          if (a.data) mdnsCache.set(a.data, { hostname: ptr.data, type });
        }
      }
    }
  });

  // Query periodically
  const query = () => m.query([
    { name: '_shelly._tcp.local', type: 'PTR' },
    { name: '_http._tcp.local', type: 'PTR' },
  ]);

  query();
  setInterval(query, 60_000);
}

// ── Full discovery run ────────────────────────────────────────────────────────

export async function runDiscovery(subnet?: string): Promise<DiscoveredDevice[]> {
  const arpEntries = await readArpTable();
  const results: DiscoveredDevice[] = [];

  // Fingerprint all ARP-known hosts in parallel (max 20 concurrent)
  const batchSize = 20;
  for (let i = 0; i < arpEntries.length; i += batchSize) {
    const batch = arpEntries.slice(i, i + batchSize);
    const probes = await Promise.allSettled(
      batch.map(async ({ ip, mac }) => {
        const fingerprint = await fingerprintIp(ip);
        if (fingerprint.type === 'unknown') return null;
        const mdnsHint = mdnsCache.get(ip);
        return {
          ip, mac,
          hostname: fingerprint.hostname ?? mdnsHint?.hostname,
          type: fingerprint.type,
          info: fingerprint.info,
          discoveredAt: Date.now(),
          via: 'arp' as const,
        } satisfies DiscoveredDevice;
      }),
    );

    for (const p of probes) {
      if (p.status === 'fulfilled' && p.value) results.push(p.value);
    }
  }

  // Add mdns-only entries (not in ARP table)
  for (const [ip, hint] of mdnsCache.entries()) {
    if (!results.find((r) => r.ip === ip)) {
      results.push({
        ip, hostname: hint.hostname, type: hint.type,
        discoveredAt: Date.now(), via: 'mdns',
      });
    }
  }

  lastResults = results;
  return results;
}

export function getLastResults(): DiscoveredDevice[] {
  return lastResults;
}
