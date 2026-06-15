import dgram from 'node:dgram';
import httpsModule from 'node:https';

// ── Types (mirrors dashboard DeviceConfig) ───────────────────────────────────

export type DeviceConfig =
  | { type: 'shelly_plug';  ip: string; channel?: number }
  | { type: 'shelly_light'; ip: string; channel?: number }
  | { type: 'wol';          mac: string; broadcastIp?: string; port?: number }
  | { type: 'proxmox';      ip: string; port?: number; tokenId: string; tokenSecret: string; allowSelfSigned?: boolean; node?: string }
  | { type: 'rdp';          ip: string; port?: number; username?: string }
  | { type: 'ssh';          ip: string; port?: number; username?: string }
  | { type: 'http';         ip: string; onPath: string; offPath?: string; method?: string }
  | { type: 'tasmota';      ip: string; channels?: number }
  | { type: 'docker';       ip: string; port?: number }
  | { type: 'tailscale';    apiKey: string; tailnet: string };

// ── WOL ──────────────────────────────────────────────────────────────────────

const sendWOL = (mac: string, broadcastIp = '255.255.255.255', port = 9): Promise<void> =>
  new Promise((resolve, reject) => {
    const macHex = mac.replace(/[:\-]/g, '');
    if (macHex.length !== 12) { reject(new Error('Invalid MAC address')); return; }
    const macBytes = Buffer.from(macHex, 'hex');
    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);
    const socket = dgram.createSocket('udp4');
    socket.once('error', (e) => { socket.close(); reject(e); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magic, 0, magic.length, port, broadcastIp, (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });

// ── Main proxy executor ───────────────────────────────────────────────────────

export async function executeDeviceAction(
  config: DeviceConfig,
  action: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (config.type === 'shelly_plug' || config.type === 'shelly_light') {
    const channel = config.channel ?? 0;
    const relayPath = config.type === 'shelly_plug' ? 'relay' : 'light';
    if (['on', 'off', 'toggle', 'status'].includes(action)) {
      const query = action === 'status' ? '' : `?turn=${action}`;
      const r = await fetch(`http://${config.ip}/${relayPath}/${channel}${query}`);
      return r.json();
    }
    throw new Error('Supported actions: on, off, toggle, status');
  }

  if (config.type === 'wol') {
    if (action !== 'wake') throw new Error('WOL only supports wake');
    await sendWOL(config.mac, config.broadcastIp, config.port);
    return { ok: true };
  }

  if (config.type === 'tasmota') {
    const ch = params.channel ? `${Number(params.channel)}` : '';
    if (['on', 'off', 'toggle', 'status'].includes(action)) {
      const cmd = action === 'status'
        ? `Power${ch}`
        : `Power${ch}+${action.charAt(0).toUpperCase() + action.slice(1)}`;
      const r = await fetch(`http://${config.ip}/cm?cmnd=${encodeURIComponent(cmd)}`);
      return r.json();
    }
    if (action === 'energy') {
      const r = await fetch(`http://${config.ip}/cm?cmnd=Status+10`);
      return r.json();
    }
    throw new Error('Supported: on, off, toggle, status, energy');
  }

  if (config.type === 'proxmox') {
    const agent = new httpsModule.Agent({ rejectUnauthorized: !config.allowSelfSigned });
    const base = `https://${config.ip}:${config.port ?? 8006}/api2/json`;
    const node = config.node ?? 'pve';
    const headers = { Authorization: `PVEAPIToken=${config.tokenId}=${config.tokenSecret}` };

    if (action === 'list_vms') {
      // List both KVM/QEMU VMs and LXC containers, tagged with their kind.
      const [qemuR, lxcR] = await Promise.all([
        fetch(`${base}/nodes/${node}/qemu`, { headers, agent: agent as any } as any),
        fetch(`${base}/nodes/${node}/lxc`,  { headers, agent: agent as any } as any),
      ]);
      if (!qemuR.ok) throw new Error(`Proxmox API error ${qemuR.status}`);
      const qemu = (((await qemuR.json()) as any).data ?? []).map((v: any) => ({ ...v, _kind: 'qemu' }));
      const lxc = lxcR.ok ? (((await lxcR.json()) as any).data ?? []).map((v: any) => ({ ...v, _kind: 'lxc' })) : [];
      return { data: [...qemu, ...lxc] };
    }
    if (action === 'vm_ctrl') {
      const { vmId, vmAction, vmKind } = params as { vmId?: string; vmAction?: string; vmKind?: string };
      const kind = vmKind === 'lxc' ? 'lxc' : 'qemu';
      if (!vmId || !vmAction || !['start', 'stop', 'reboot', 'shutdown'].includes(vmAction)) {
        throw new Error('Provide vmId and vmAction (start|stop|reboot|shutdown)');
      }
      const r = await fetch(`${base}/nodes/${node}/${kind}/${vmId}/status/${vmAction}`, {
        method: 'POST', headers, agent: agent as any,
      } as any);
      return r.json();
    }
    throw new Error('Use action=list_vms or action=vm_ctrl with vmId+vmAction');
  }

  if (config.type === 'docker') {
    const base = `http://${config.ip}:${config.port ?? 2375}`;
    if (action === 'list_containers') {
      const r = await fetch(`${base}/containers/json?all=1`);
      if (!r.ok) throw new Error(`Docker API error ${r.status}`);
      return r.json();
    }
    if (action === 'container_ctrl') {
      const { containerId, containerAction } = params as { containerId?: string; containerAction?: string };
      if (!containerId || !containerAction || !['start', 'stop', 'restart', 'pause', 'unpause'].includes(containerAction)) {
        throw new Error('Provide containerId and containerAction');
      }
      const r = await fetch(`${base}/containers/${containerId}/${containerAction}`, { method: 'POST' });
      return { ok: r.ok, status: r.status };
    }
    throw new Error('Use action=list_containers or action=container_ctrl');
  }

  if (config.type === 'tailscale') {
    if (action !== 'list_devices') throw new Error('Only list_devices is supported');
    const tailnet = encodeURIComponent(config.tailnet);
    const r = await fetch(`https://api.tailscale.com/api/v2/tailnet/${tailnet}/devices`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!r.ok) throw new Error(`Tailscale API error ${r.status}`);
    return r.json();
  }

  if (config.type === 'rdp' || config.type === 'ssh') {
    const protocol = config.type;
    const port = config.port ?? (protocol === 'rdp' ? 3389 : 22);
    const user = (config as { username?: string }).username;
    return { ok: true, url: `${protocol}://${user ? `${user}@` : ''}${config.ip}:${port}` };
  }

  if (config.type === 'http') {
    const actionPath = action === 'on' ? config.onPath : (config.offPath ?? config.onPath);
    const method = config.method ?? 'GET';
    const r = await fetch(`http://${config.ip}${actionPath}`, { method });
    return { ok: true, status: r.status };
  }

  throw new Error(`Unknown device type: ${(config as any).type}`);
}
