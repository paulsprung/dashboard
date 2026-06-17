import { cpus, totalmem, freemem, loadavg, uptime as osUptime, hostname, release, arch, platform } from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';

// ── Host metrics ──────────────────────────────────────────────────────────────
// Same shape as the Pi Agent's getMetrics() so the dashboard can render any host
// agent's stats with the exact same UI as the Pi. Best-effort: degrades on hosts
// without a thermal sensor or where statfs is unavailable.

type CpuSnap = { idle: number; total: number };
function sampleCpu(): CpuSnap {
  let idle = 0, total = 0;
  for (const c of cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}
let prev = sampleCpu();
function cpuPercent(): number {
  const cur = sampleCpu();
  const idleD = cur.idle - prev.idle;
  const totalD = cur.total - prev.total;
  prev = cur;
  if (totalD <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleD / totalD) * 100)));
}

export type HostMetrics = ReturnType<typeof getMetrics>;

export function getMetrics() {
  const load = loadavg();
  const tm = totalmem(), fm = freemem();
  let tempC: number | null = null;
  try {
    tempC = Math.round(parseInt(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim(), 10) / 100) / 10;
  } catch { /* no thermal sensor */ }
  let diskTotal: number | null = null, diskUsed: number | null = null, diskPct: number | null = null;
  try {
    const s = statfsSync('/');
    diskTotal = s.blocks * s.bsize;
    diskUsed = diskTotal - s.bfree * s.bsize;
    diskPct = Math.round((diskUsed / diskTotal) * 100);
  } catch { /* statfs unavailable */ }
  return {
    cpuPct: cpuPercent(),
    cpus: cpus().length || 1,
    load1: Math.round(load[0] * 100) / 100,
    load5: Math.round(load[1] * 100) / 100,
    load15: Math.round(load[2] * 100) / 100,
    memTotal: tm,
    memUsed: tm - fm,
    memPct: Math.round(((tm - fm) / tm) * 100),
    tempC,
    diskTotal,
    diskUsed,
    diskPct,
    osUptime: Math.round(osUptime()),
    hostname: hostname(),
    platform: platform(),
    kernel: release(),
    arch: arch(),
    cpuModel: (cpus()[0]?.model ?? '').trim() || null,
  };
}
