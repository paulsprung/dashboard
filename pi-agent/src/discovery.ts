import fs from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns/promises';
import mdns from 'multicast-dns';

export type DiscoveredDevice = {
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  type: 'shelly_plug' | 'shelly_light' | 'tasmota' | 'proxmox' | 'docker' | 'web' | 'http' | 'unknown';
  info?: Record<string, unknown>;
  discoveredAt: number;
  via: 'arp' | 'mdns';
  firstSeen?: number;
  lastSeen?: number;
  online?: boolean;
};

// Persistent registry of every host ever seen on the LAN, keyed by MAC (stable) or IP.
// Full discovery refreshes fingerprints; the lightweight monitor sweep just refreshes
// online/last-seen so the dashboard can show a real presence monitor between scans.
const hostRegistry = new Map<string, DiscoveredDevice>();
const hostKey = (d: { mac?: string; ip: string }) => d.mac?.toLowerCase() || d.ip;
const mdnsCache = new Map<string, { hostname: string; type: DiscoveredDevice['type'] }>();

// ── MAC vendor (OUI) lookup ────────────────────────────────────────────────────
// A small curated map of common smart-home / consumer prefixes — enough to tell a
// Fritzbox from a Hue bridge from an ESP plug from a phone, even with no open ports.
const OUI: Record<string, string> = {
  '001788': 'Philips Hue', 'ecb5fa': 'Philips Hue',
  '38a28a': 'AVM (FRITZ!Box)', '3810d5': 'AVM (FRITZ!Box)', '647002': 'AVM (FRITZ!Box)',
  '5c4979': 'AVM (FRITZ!Box)', '9cc7a6': 'AVM (FRITZ!Box)', 'c02506': 'AVM (FRITZ!Box)',
  'e0286d': 'AVM (FRITZ!Box)', 'ec086b': 'AVM (FRITZ!Box)', '08961d': 'AVM (FRITZ!Box)',
  'b827eb': 'Raspberry Pi', 'dca632': 'Raspberry Pi', 'e45f01': 'Raspberry Pi', '28cdc1': 'Raspberry Pi',
  '246f28': 'Espressif (ESP)', '30aea4': 'Espressif (ESP)', '3c6105': 'Espressif (ESP)',
  '483fda': 'Espressif (ESP)', '5ccf7f': 'Espressif (ESP)', '7c9ebd': 'Espressif (ESP)',
  '84cca8': 'Espressif (ESP)', '8caab5': 'Espressif (ESP)', 'a4cf12': 'Espressif (ESP)',
  'b4e62d': 'Espressif (ESP)', 'bcddc2': 'Espressif (ESP)', 'c44f33': 'Espressif (ESP)',
  'cc50e3': 'Espressif (ESP)', 'd8a01d': 'Espressif (ESP)', 'dc4f22': 'Espressif (ESP)',
  'ecfabc': 'Espressif (ESP)', '2462ab': 'Espressif (ESP)',
  'd073d5': 'Shelly / Allterco', '349454': 'Shelly / Allterco',
  '001132': 'Synology', '0011d8': 'Asustek', '244bfe': 'Asustek',
  '001599': 'Samsung', '5cf370': 'Samsung', 'a48431': 'Samsung',
  'f0189': 'Apple', 'a483e7': 'Apple', '3c0630': 'Apple', '04d6aa': 'Apple', 'acbc32': 'Apple',
  '001a11': 'Google', 'f4f5d8': 'Google', '1c53f9': 'Amazon', 'f0272d': 'Amazon',
  '0017c8': 'TP-Link', '50c7bf': 'TP-Link', 'b0be76': 'TP-Link',
  '0418d6': 'Ubiquiti', '24a43c': 'Ubiquiti', 'fcecda': 'Ubiquiti',
  '001a79': 'Sonoff / Itead',
};
function ouiVendor(mac?: string): string | undefined {
  if (!mac) return undefined;
  return OUI[mac.replace(/:/g, '').slice(0, 6).toLowerCase()];
}

// Reverse-DNS (PTR) lookup — the local resolver (router / Pi-hole) usually knows the
// DHCP hostnames, so this gives a friendly name for plain hosts that have no mDNS or
// fingerprint. Cached because the mapping rarely changes within a session.
const ptrCache = new Map<string, string | null>();
async function reverseDns(ip: string): Promise<string | undefined> {
  if (ptrCache.has(ip)) return ptrCache.get(ip) ?? undefined;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
    ]);
    // Strip a trailing local domain (".lan", ".fritz.box", ".local") for a cleaner label.
    const name = names[0]?.replace(/\.(lan|local|home|fritz\.box|localdomain)\.?$/i, '') || undefined;
    ptrCache.set(ip, name ?? null);
    return name;
  } catch {
    ptrCache.set(ip, null);
    return undefined;
  }
}

// Read a web device's <title> / Server header for a human-friendly name (HTTP only).
async function fetchWebTitle(ip: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(1500), redirect: 'manual' } as any);
    const html = await r.text();
    const m = html.match(/<title>\s*([^<]{1,80}?)\s*<\/title>/i);
    return (m?.[1]?.trim()) || (r.headers.get('server') ?? undefined) || undefined;
  } catch { return undefined; }
}

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

// ── Active subnet sweep ────────────────────────────────────────────────────────
// Touching every host (a TCP SYN forces ARP resolution) populates /proc/net/arp
// for all reachable hosts — turning the passive ARP read into an active scan.

function hostsInSubnet(subnet?: string): string[] {
  if (!subnet) return [];
  const [base, bitsStr] = subnet.split('/');
  const bits = Number(bitsStr ?? '24');
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n)) || bits < 24) return []; // only sweep /24 (or smaller)
  return Array.from({ length: 254 }, (_, i) => `${octets[0]}.${octets[1]}.${octets[2]}.${i + 1}`);
}

async function sweepSubnet(subnet?: string): Promise<void> {
  const hosts = hostsInSubnet(subnet);
  const batchSize = 64;
  for (let i = 0; i < hosts.length; i += batchSize) {
    // A reachable host answers the ARP request even if the TCP port is closed/firewalled,
    // so a short-timeout connect attempt is enough to put it in the ARP cache.
    await Promise.allSettled(hosts.slice(i, i + batchSize).map((ip) => tcpProbe(ip, 80, 500)));
  }
}

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

  // Generic web UI (something you connect to, not switch on/off) — grab its title.
  if (await tcpProbe(ip, 80, 900)) {
    return { type: 'web', hostname: (await fetchWebTitle(ip)) ?? mdnsHint?.hostname };
  }
  if (await tcpProbe(ip, 443, 900)) return { type: 'web', hostname: mdnsHint?.hostname };

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
  // Active sweep first so the ARP table reflects every reachable host, not just
  // the ones the Pi happened to talk to recently.
  await sweepSubnet(subnet);

  const arpEntries = await readArpTable();
  const results: DiscoveredDevice[] = [];

  // Fingerprint all ARP-known hosts in parallel (max 20 concurrent). Hosts we
  // can't classify are still returned as 'unknown' so you can add them manually.
  const batchSize = 20;
  for (let i = 0; i < arpEntries.length; i += batchSize) {
    const batch = arpEntries.slice(i, i + batchSize);
    const probes = await Promise.allSettled(
      batch.map(async ({ ip, mac }) => {
        const fingerprint = await fingerprintIp(ip);
        const mdnsHint = mdnsCache.get(ip);
        return {
          ip, mac,
          vendor: ouiVendor(mac),
          hostname: fingerprint.hostname ?? mdnsHint?.hostname ?? await reverseDns(ip),
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

  mergeIntoRegistry(results, true);
  return getLastResults();
}

// Fold a set of freshly-seen hosts into the persistent registry. Hosts present in this
// pass are marked online; hosts absent from a *full* scan are marked offline (the
// lightweight monitor sweep only flips hosts it can confirm, never the whole registry).
function mergeIntoRegistry(results: DiscoveredDevice[], fullScan: boolean) {
  const now = Date.now();
  const seen = new Set<string>();
  for (const r of results) {
    const key = hostKey(r);
    seen.add(key);
    const prev = hostRegistry.get(key);
    hostRegistry.set(key, {
      ...prev,
      ...r,
      // keep the most informative type/hostname/vendor we've ever learned for this host
      type: r.type !== 'unknown' ? r.type : (prev?.type ?? r.type),
      hostname: r.hostname ?? prev?.hostname,
      vendor: r.vendor ?? prev?.vendor,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      online: true,
    });
  }
  if (fullScan) {
    for (const [key, h] of hostRegistry) {
      if (!seen.has(key)) hostRegistry.set(key, { ...h, online: false });
    }
  }
}

// Lightweight presence check between full scans: touch the subnet, re-read the ARP table
// (an entry means the host answered at L2) and update online/last-seen accordingly.
export async function monitorSweep(subnet?: string): Promise<void> {
  await sweepSubnet(subnet);
  const arp = await readArpTable();
  const now = Date.now();
  const live = new Map(arp.map((a) => [a.ip, a.mac] as const));

  for (const [key, h] of hostRegistry) {
    const online = live.has(h.ip);
    hostRegistry.set(key, { ...h, online, lastSeen: online ? now : h.lastSeen });
  }
  // Register ARP hosts we hadn't catalogued yet (unfingerprinted, but present).
  for (const { ip, mac } of arp) {
    const key = mac.toLowerCase();
    const known = hostRegistry.has(key) || [...hostRegistry.values()].some((h) => h.ip === ip);
    if (!known) {
      hostRegistry.set(key, {
        ip, mac, vendor: ouiVendor(mac), hostname: await reverseDns(ip), type: 'unknown', via: 'arp',
        discoveredAt: now, firstSeen: now, lastSeen: now, online: true,
      });
    }
  }
}

export function getLastResults(): DiscoveredDevice[] {
  return [...hostRegistry.values()].sort((a, b) => {
    const na = a.ip.split('.').map(Number);
    const nb = b.ip.split('.').map(Number);
    for (let i = 0; i < 4; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
    return 0;
  });
}
