// ── Philips Hue (local bridge, API v1) ───────────────────────────────────────
// All Hue traffic happens on the LAN, from the Pi. Pairing requires the physical
// round link button on the bridge to be pressed; the resulting application key is
// stored as the device's apiKey — a secret that lives on the Pi only.

const TIMEOUT = 6000;
const sig = () => AbortSignal.timeout(TIMEOUT);

export type HueBridge = { id: string; ip: string };
export type HueTarget = { id: string; label: string; kind: 'group' | 'light'; on: boolean };

// Philips' N-UPnP cloud discovery — needs internet from the Pi. Best-effort: if it
// fails the user can still type the bridge IP by hand.
export async function discoverBridges(): Promise<HueBridge[]> {
  try {
    const r = await fetch('https://discovery.meethue.com', { signal: sig() });
    if (!r.ok) return [];
    const list = await r.json() as { id: string; internalipaddress: string }[];
    return list.filter((b) => b.internalipaddress).map((b) => ({ id: b.id, ip: b.internalipaddress }));
  } catch {
    return [];
  }
}

// Create an application key. Returns it on success, or throws a friendly error if the
// link button hasn't been pressed (Hue error type 101).
export async function pairBridge(ip: string): Promise<{ apiKey: string }> {
  const r = await fetch(`http://${ip}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: 'sm_dashboard#pi' }),
    signal: sig(),
  });
  const data = await r.json() as Array<{ success?: { username: string }; error?: { type: number; description: string } }>;
  const entry = Array.isArray(data) ? data[0] : undefined;
  if (entry?.success?.username) return { apiKey: entry.success.username };
  if (entry?.error?.type === 101) throw new Error('Press the round link button on the Hue bridge, then pair again within 30 seconds.');
  throw new Error(entry?.error?.description ?? 'Pairing failed — check the bridge IP.');
}

// List controllable targets: rooms/zones (groups) plus individual lights, each with
// its current on-state so the picker can show what's currently lit.
export async function listTargets(ip: string, apiKey: string): Promise<HueTarget[]> {
  const base = `http://${ip}/api/${apiKey}`;
  const [gR, lR] = await Promise.all([
    fetch(`${base}/groups`, { signal: sig() }),
    fetch(`${base}/lights`, { signal: sig() }),
  ]);
  const groups = gR.ok ? await gR.json() as Record<string, { name: string; state?: { any_on?: boolean } }> : {};
  const lights = lR.ok ? await lR.json() as Record<string, { name: string; state?: { on?: boolean } }> : {};
  // An unauthorized/invalid key comes back as an error array, not an object.
  if (Array.isArray(groups) || (groups as { 0?: { error?: unknown } })[0]?.error) {
    throw new Error('Hue key not authorized — re-pair the bridge.');
  }
  const out: HueTarget[] = [{ id: 'group:0', label: 'All lights', kind: 'group', on: false }];
  for (const [id, g] of Object.entries(groups)) out.push({ id: `group:${id}`, label: `${g.name} (room)`, kind: 'group', on: !!g.state?.any_on });
  for (const [id, l] of Object.entries(lights)) out.push({ id: `light:${id}`, label: l.name, kind: 'light', on: !!l.state?.on });
  return out;
}

// Execute a control action against a stored Hue device.
//   target = "group:<id>" (group:0 = all lights) or "light:<id>"
export async function hueAction(
  ip: string, apiKey: string, target: string, action: string, params: Record<string, unknown>,
): Promise<unknown> {
  const base = `http://${ip}/api/${apiKey}`;
  const [kind, id] = target.split(':');
  const isGroup = kind !== 'light';
  const writePath = isGroup ? `${base}/groups/${id}/action` : `${base}/lights/${id}/state`;
  const readPath = isGroup ? `${base}/groups/${id}` : `${base}/lights/${id}`;

  const currentlyOn = async (): Promise<boolean> => {
    const r = await fetch(readPath, { signal: sig() });
    const d = await r.json() as { state?: { any_on?: boolean; on?: boolean }; action?: { on?: boolean } };
    return isGroup ? !!(d.state?.any_on ?? d.action?.on) : !!d.state?.on;
  };

  if (action === 'status') {
    const r = await fetch(readPath, { signal: sig() });
    return r.json();
  }

  let body: Record<string, unknown>;
  if (action === 'on') body = { on: true };
  else if (action === 'off') body = { on: false };
  else if (action === 'toggle') body = { on: !(await currentlyOn()) };
  else if (action === 'brightness') {
    const pct = Math.max(0, Math.min(100, Number(params.value ?? params.brightness ?? 100)));
    body = { on: pct > 0, bri: Math.round((pct / 100) * 254) };
  } else throw new Error('Supported actions: on, off, toggle, brightness, status');

  const r = await fetch(writePath, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig(),
  });
  const result = await r.json() as Array<{ error?: { description?: string } }>;
  if (Array.isArray(result) && result.some((x) => x.error)) {
    throw new Error(result.find((x) => x.error)?.error?.description ?? 'Hue rejected the command');
  }
  return { ok: true, result };
}
