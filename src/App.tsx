import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

// ── Types ────────────────────────────────────────────────────────────────────

type Role = 'root' | 'admin' | 'user' | 'readonly';
type ThemeMode = 'light' | 'dark' | 'ultra-dark';
type SessionUser = { id: string; email: string; role: Role; avatarUrl?: string };
type SetupStatus = {
  completed: boolean; dashboardName: string; theme: ThemeMode; accent: string;
  setupStarted: boolean; backupPasswordAccepted: boolean; rootEmail: string | null;
};
type AdminUser = { id: string; email: string; role: Role; hasPasskey: boolean };

type PermissionFlag =
  | 'control:plugs' | 'control:lights' | 'control:wol'
  | 'view:proxmox' | 'control:proxmox' | 'view:rdp' | 'view:ssh' | 'control:http';

const ALL_PERMISSIONS: { flag: PermissionFlag; label: string; desc: string }[] = [
  { flag: 'control:plugs',   label: 'Steckdosen',   desc: 'Smart Plugs ein/ausschalten' },
  { flag: 'control:lights',  label: 'Licht',         desc: 'Lichter steuern' },
  { flag: 'control:wol',     label: 'Wake-on-LAN',   desc: 'Geräte per WOL aufwecken' },
  { flag: 'view:proxmox',    label: 'Proxmox (lesen)',desc: 'VMs einsehen' },
  { flag: 'control:proxmox', label: 'Proxmox (ctrl)', desc: 'VMs starten/stoppen' },
  { flag: 'view:rdp',        label: 'RDP anzeigen',  desc: 'RDP-Verbindungsdaten sehen' },
  { flag: 'view:ssh',        label: 'SSH anzeigen',  desc: 'SSH-Verbindungsdaten sehen' },
  { flag: 'control:http',    label: 'HTTP-Geräte',   desc: 'HTTP-Gerätebefehle senden' },
];

type DeviceConfig =
  | { type: 'shelly_plug';  ip: string; channel?: number }
  | { type: 'shelly_light'; ip: string; channel?: number }
  | { type: 'wol';  mac: string; broadcastIp?: string; port?: number }
  | { type: 'proxmox'; ip: string; port?: number; tokenId: string; tokenSecret: string; allowSelfSigned?: boolean; node?: string }
  | { type: 'rdp'; ip: string; port?: number; username?: string }
  | { type: 'ssh'; ip: string; port?: number; username?: string }
  | { type: 'http'; ip: string; onPath: string; offPath?: string; method?: string };

type Device = {
  id: string; name: string; room?: string; icon?: string;
  config: DeviceConfig; requiredPermissions: PermissionFlag[];
};

type WidgetLayout = { col: number; row: number; w: number; h: number };
type WidgetConfig =
  | { type: 'clock';         format?: '12h' | '24h'; showSeconds?: boolean; showDate?: boolean }
  | { type: 'weather';       location?: string; unit?: 'C' | 'F' }
  | { type: 'device_toggle'; deviceId: string }
  | { type: 'wol_button';    deviceId: string; label?: string }
  | { type: 'proxmox_vms';   deviceId: string }
  | { type: 'note';          content: string; title?: string }
  | { type: 'quick_actions'; deviceIds: string[] };

type Widget = { id: string; userId: string; layout: WidgetLayout; config: WidgetConfig };

// ── Design tokens ────────────────────────────────────────────────────────────

const APPLE_COLORS = [
  '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#FF3B30',
  '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#32ADE6',
  '#A2845E', '#636366',
];

function tok(theme: ThemeMode) {
  const t = {
    light: {
      page:       'bg-[#F2F2F7] text-[#1D1D1F]',
      card:       'bg-white/90',
      border:     'border-black/[0.07]',
      text:       'text-[#1D1D1F]',
      muted:      'text-[#6E6E73]',
      inputBg:    'bg-[#F2F2F7]',
      inputText:  'text-[#1D1D1F] placeholder:text-[#C7C7CC]',
      inputBorder:'border border-black/[0.1]',
      divider:    'border-black/[0.06]',
      navHover:   'hover:bg-black/[0.04]',
      navActive:  'bg-black/[0.06] font-medium',
      userCard:   'bg-black/[0.04]',
      shadow:     '0 2px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
      shadowSm:   '0 1px 4px rgba(0,0,0,0.06)',
    },
    dark: {
      page:       'bg-[#1C1C1E] text-[#F5F5F7]',
      card:       'bg-[#2C2C2E]/95',
      border:     'border-white/[0.08]',
      text:       'text-[#F5F5F7]',
      muted:      'text-[#98989F]',
      inputBg:    'bg-[#3A3A3C]',
      inputText:  'text-[#F5F5F7] placeholder:text-[#636366]',
      inputBorder:'border border-transparent',
      divider:    'border-white/[0.08]',
      navHover:   'hover:bg-white/[0.06]',
      navActive:  'bg-white/[0.1] font-medium',
      userCard:   'bg-white/[0.05]',
      shadow:     '0 2px 16px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.25)',
      shadowSm:   '0 1px 4px rgba(0,0,0,0.2)',
    },
    'ultra-dark': {
      page:       'bg-black text-[#F5F5F7]',
      card:       'bg-[#111111]',
      border:     'border-white/[0.07]',
      text:       'text-[#F5F5F7]',
      muted:      'text-[#6E6E73]',
      inputBg:    'bg-[#1C1C1E]',
      inputText:  'text-[#F5F5F7] placeholder:text-[#48484A]',
      inputBorder:'border border-white/[0.06]',
      divider:    'border-white/[0.06]',
      navHover:   'hover:bg-white/[0.06]',
      navActive:  'bg-white/[0.1] font-medium',
      userCard:   'bg-white/[0.04]',
      shadow:     '0 2px 20px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.5)',
      shadowSm:   '0 1px 4px rgba(0,0,0,0.4)',
    },
  } as const;
  return t[theme];
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

function Spinner({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin" style={{ color }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.2" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function SuccessCheck({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 52 52" width={56} height={56} fill="none" className="animate-scale-in">
      <circle cx="26" cy="26" r="24" stroke={color} strokeWidth="2" strokeOpacity="0.3" />
      <circle cx="26" cy="26" r="24" stroke={color} strokeWidth="2"
        strokeDasharray="150" strokeDashoffset="150"
        style={{ animation: 'drawCheck 0.5s ease-out forwards', strokeDasharray: 150, strokeDashoffset: 150 }} />
      <path d="M14 26l9 9 15-15" stroke={color} strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
    </svg>
  );
}

function Btn({
  children, onClick, loading = false, disabled = false,
  variant = 'primary', accent, className = '', size = 'md',
}: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
  disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  accent: string; className?: string; size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm';
  const base = `inline-flex items-center justify-center gap-2 rounded-xl ${pad} font-medium transition-all duration-150 hover:brightness-105 active:scale-[0.97] active:brightness-95 disabled:opacity-40 select-none cursor-pointer`;
  if (variant === 'primary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-white ${className}`}
      style={{ backgroundColor: accent, boxShadow: `0 2px 8px ${accent}55` }}>
      {loading ? <Spinner size={16} color="white" /> : children}
    </button>
  );
  if (variant === 'danger') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-white bg-red-500 ${className}`}
      style={{ boxShadow: '0 2px 8px rgba(239,68,68,0.35)' }}>
      {loading ? <Spinner size={16} color="white" /> : children}
    </button>
  );
  if (variant === 'secondary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-[#F5F5F7] bg-white/10 border border-white/[0.1] ${className}`}>
      {loading ? <Spinner size={16} color="#F5F5F7" /> : children}
    </button>
  );
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-[#F5F5F7] opacity-50 hover:opacity-90 ${className}`}>
      {loading ? <Spinner size={16} color="#F5F5F7" /> : children}
    </button>
  );
}

function Input({
  label, hint, value, onChange, placeholder, type = 'text', disabled, t,
  accent, autoFocus,
}: {
  label?: string; hint?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; disabled?: boolean; t: ReturnType<typeof tok>;
  accent: string; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => ref.current?.focus(), 80); }, [autoFocus]);
  return (
    <div className="space-y-1.5">
      {label && <label className={`block text-sm font-medium ${t.muted}`}>{label}</label>}
      <input
        ref={ref}
        type={type} value={value} placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`focus-accent w-full rounded-xl px-3.5 py-2.5 text-sm outline-none transition-all
          ${t.inputBg} ${t.inputText} ${t.inputBorder} disabled:opacity-50`}
        style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}
      />
      {hint && <p className={`text-xs ${t.muted}`}>{hint}</p>}
    </div>
  );
}

function Select({
  label, value, onChange, options, t, accent,
}: {
  label?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
  t: ReturnType<typeof tok>; accent: string;
}) {
  return (
    <div className="space-y-1.5">
      {label && <label className={`block text-sm font-medium ${t.muted}`}>{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`focus-accent w-full rounded-xl px-3.5 py-2.5 text-sm outline-none transition-all
          ${t.inputBg} ${t.inputText} ${t.inputBorder}`}
        style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Card({ children, className = '', t, accent }: {
  children: React.ReactNode; className?: string;
  t: ReturnType<typeof tok>; accent?: string;
}) {
  return (
    <div className={`rounded-2xl border backdrop-blur-xl transition-shadow duration-300 ${t.card} ${t.border} ${className}`}
      style={{
        boxShadow: accent
          ? `${t.shadow}, inset 0 1px 0 0 ${accent}18, 0 0 40px 0 ${accent}0A`
          : t.shadow,
        borderColor: accent ? `${accent}20` : undefined,
      }}>
      {children}
    </div>
  );
}

const panelStyle = (accent: string, t: ReturnType<typeof tok>) => ({
  boxShadow: `inset 0 1px 0 0 ${accent}15`,
  borderColor: `${accent}18`,
});

function ColorPicker({ value, onChange, t }: {
  value: string; onChange: (hex: string) => void; t: ReturnType<typeof tok>;
}) {
  const [custom, setCustom] = useState(value);
  const handleCustom = (raw: string) => {
    setCustom(raw);
    if (/^#[0-9A-Fa-f]{6}$/.test(raw)) onChange(raw);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-6 gap-2">
        {APPLE_COLORS.map((c) => (
          <button key={c} onClick={() => { onChange(c); setCustom(c); }}
            title={c}
            className="h-8 w-8 rounded-full transition-all hover:scale-110 active:scale-95"
            style={{
              backgroundColor: c,
              outline: value === c ? `2px solid ${c}` : '2px solid transparent',
              outlineOffset: 2,
              transform: value === c ? 'scale(1.15)' : undefined,
            }} />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 flex-shrink-0 rounded-full border"
          style={{ backgroundColor: value, borderColor: `${value}66` }} />
        <input
          value={custom}
          onChange={(e) => handleCustom(e.target.value)}
          placeholder="#007AFF"
          maxLength={7}
          className={`focus-accent w-full rounded-lg px-3 py-1.5 font-mono text-xs outline-none transition-all
            ${t.inputBg} ${t.inputText} ${t.inputBorder}`}
          style={{ '--accent-ring': `${value}55` } as React.CSSProperties}
        />
      </div>
    </div>
  );
}

function StatusMsg({ msg, t }: { msg: string; t: ReturnType<typeof tok> }) {
  if (!msg) return null;
  const isErr = msg.startsWith('✗');
  return (
    <p className={`rounded-xl px-3.5 py-2.5 text-sm animate-slide-up ${
      isErr ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-600'
    }`}>{msg}</p>
  );
}

const readErr = async (r: Response, fallback: string) => {
  try { return ((await r.json()) as { error?: string }).error ?? fallback; } catch { return fallback; }
};

// ── Device helpers ────────────────────────────────────────────────────────────

const DEVICE_TYPE_OPTIONS = [
  { value: 'shelly_plug',  label: '🔌 Smart Plug (Shelly)' },
  { value: 'shelly_light', label: '💡 Licht (Shelly)' },
  { value: 'wol',          label: '⚡ Wake-on-LAN' },
  { value: 'proxmox',      label: '🖥  Proxmox Server' },
  { value: 'rdp',          label: '🪟 Windows RDP' },
  { value: 'ssh',          label: '🐧 SSH / Linux' },
  { value: 'http',         label: '🌐 HTTP Gerät' },
];

const deviceTypeIcon = (type: string) => {
  const map: Record<string, string> = {
    shelly_plug: '🔌', shelly_light: '💡', wol: '⚡',
    proxmox: '🖥', rdp: '🪟', ssh: '🐧', http: '🌐',
  };
  return map[type] ?? '📱';
};

const deviceTypePermission = (type: string): PermissionFlag | null => {
  const map: Record<string, PermissionFlag> = {
    shelly_plug: 'control:plugs', shelly_light: 'control:lights',
    wol: 'control:wol', proxmox: 'view:proxmox',
    rdp: 'view:rdp', ssh: 'view:ssh', http: 'control:http',
  };
  return map[type] ?? null;
};

// ── Device Form (add/edit) ────────────────────────────────────────────────────

function DeviceForm({
  initial, onSave, onCancel, t, accent,
}: {
  initial?: Partial<Device>;
  onSave: (d: Omit<Device, 'id'>) => Promise<void>;
  onCancel: () => void;
  t: ReturnType<typeof tok>;
  accent: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [room, setRoom] = useState(initial?.room ?? '');
  const [type, setType] = useState<string>(initial?.config?.type ?? 'shelly_plug');
  const [ip, setIp] = useState((initial?.config as any)?.ip ?? '');
  const [channel, setChannel] = useState(String((initial?.config as any)?.channel ?? '0'));
  const [mac, setMac] = useState((initial?.config as any)?.mac ?? '');
  const [broadcastIp, setBroadcastIp] = useState((initial?.config as any)?.broadcastIp ?? '');
  const [tokenId, setTokenId] = useState((initial?.config as any)?.tokenId ?? '');
  const [tokenSecret, setTokenSecret] = useState((initial?.config as any)?.tokenSecret ?? '');
  const [pxNode, setPxNode] = useState((initial?.config as any)?.node ?? 'pve');
  const [allowSelfSigned, setAllowSelfSigned] = useState((initial?.config as any)?.allowSelfSigned ?? false);
  const [username, setUsername] = useState((initial?.config as any)?.username ?? '');
  const [port, setPort] = useState(String((initial?.config as any)?.port ?? ''));
  const [onPath, setOnPath] = useState((initial?.config as any)?.onPath ?? '/relay/0?turn=on');
  const [offPath, setOffPath] = useState((initial?.config as any)?.offPath ?? '/relay/0?turn=off');
  const [perms, setPerms] = useState<PermissionFlag[]>(initial?.requiredPermissions ?? []);
  const [loading, setLoading] = useState(false);

  // auto-suggest permission when type changes
  useEffect(() => {
    const suggested = deviceTypePermission(type);
    if (suggested && !perms.includes(suggested)) setPerms([suggested]);
    else if (!suggested) setPerms([]);
  }, [type]);

  const buildConfig = (): DeviceConfig | null => {
    if (type === 'shelly_plug') return { type, ip, channel: Number(channel) };
    if (type === 'shelly_light') return { type, ip, channel: Number(channel) };
    if (type === 'wol') { if (!mac) return null; return { type, mac, broadcastIp: broadcastIp || undefined }; }
    if (type === 'proxmox') { if (!ip || !tokenId || !tokenSecret) return null; return { type, ip, tokenId, tokenSecret, allowSelfSigned, node: pxNode || 'pve', port: port ? Number(port) : undefined }; }
    if (type === 'rdp') return { type, ip, username: username || undefined, port: port ? Number(port) : undefined };
    if (type === 'ssh') return { type, ip, username: username || undefined, port: port ? Number(port) : undefined };
    if (type === 'http') return { type, ip, onPath, offPath: offPath || undefined };
    return null;
  };

  const save = async () => {
    const config = buildConfig();
    if (!name || !config) return;
    setLoading(true);
    await onSave({ name, room: room || undefined, config, requiredPermissions: perms });
    setLoading(false);
  };

  const togglePerm = (p: PermissionFlag) =>
    setPerms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Name" value={name} onChange={setName} placeholder="Wohnzimmer Steckdose" t={t} accent={accent} autoFocus />
        <Input label="Raum (optional)" value={room} onChange={setRoom} placeholder="Wohnzimmer" t={t} accent={accent} />
      </div>
      <Select label="Typ" value={type} onChange={setType}
        options={DEVICE_TYPE_OPTIONS} t={t} accent={accent} />

      {(type === 'shelly_plug' || type === 'shelly_light') && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.100" t={t} accent={accent} />
          <Input label="Kanal" value={channel} onChange={setChannel} placeholder="0" t={t} accent={accent} />
        </div>
      )}
      {type === 'wol' && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="MAC-Adresse" value={mac} onChange={setMac} placeholder="AA:BB:CC:DD:EE:FF" t={t} accent={accent} />
          <Input label="Broadcast-IP (opt.)" value={broadcastIp} onChange={setBroadcastIp} placeholder="255.255.255.255" t={t} accent={accent} />
        </div>
      )}
      {type === 'proxmox' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.10" t={t} accent={accent} />
            <Input label="Port" value={port} onChange={setPort} placeholder="8006" t={t} accent={accent} />
          </div>
          <Input label="API Token ID (user@pam!token)" value={tokenId} onChange={setTokenId} placeholder="root@pam!dashboard" t={t} accent={accent} />
          <Input label="API Token Secret" value={tokenSecret} onChange={setTokenSecret} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" t={t} accent={accent} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Node Name" value={pxNode} onChange={setPxNode} placeholder="pve" t={t} accent={accent} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowSelfSigned} onChange={(e) => setAllowSelfSigned(e.target.checked)}
              className="rounded" />
            <span className={`text-sm ${t.muted}`}>Self-signed Zertifikat erlauben</span>
          </label>
        </div>
      )}
      {(type === 'rdp' || type === 'ssh') && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.50" t={t} accent={accent} />
          <Input label="Port (opt.)" value={port} onChange={setPort} placeholder={type === 'rdp' ? '3389' : '22'} t={t} accent={accent} />
          <Input label="Benutzername (opt.)" value={username} onChange={setUsername} placeholder="admin" t={t} accent={accent} />
        </div>
      )}
      {type === 'http' && (
        <div className="space-y-3">
          <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.200" t={t} accent={accent} />
          <Input label="Pfad EIN" value={onPath} onChange={setOnPath} placeholder="/relay/0?turn=on" t={t} accent={accent} />
          <Input label="Pfad AUS (opt.)" value={offPath} onChange={setOffPath} placeholder="/relay/0?turn=off" t={t} accent={accent} />
        </div>
      )}

      <div className="space-y-2">
        <label className={`block text-sm font-medium ${t.muted}`}>Berechtigungen (wer darf dieses Gerät sehen)</label>
        <div className="grid grid-cols-2 gap-1.5">
          {ALL_PERMISSIONS.map(({ flag, label }) => (
            <label key={flag} className={`flex items-center gap-2 cursor-pointer rounded-xl px-3 py-2 text-sm transition-all ${t.inputBg} ${t.navHover}`}>
              <input type="checkbox" checked={perms.includes(flag)} onChange={() => togglePerm(flag)} className="rounded" />
              <span className={t.text}>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Btn accent={accent} className="flex-1" onClick={save} loading={loading}
          disabled={!name || (!ip && type !== 'wol') || (type === 'wol' && !mac)}>
          Speichern
        </Btn>
        <Btn accent={accent} variant="secondary" onClick={onCancel}>Abbrechen</Btn>
      </div>
    </div>
  );
}

// ── Widget Form (add widget) ──────────────────────────────────────────────────

const WIDGET_TYPE_OPTIONS = [
  { value: 'clock',         label: '🕐 Uhr' },
  { value: 'weather',       label: '🌤 Wetter' },
  { value: 'device_toggle', label: '🔌 Gerät schalten' },
  { value: 'wol_button',    label: '⚡ Wake-on-LAN' },
  { value: 'proxmox_vms',   label: '🖥  Proxmox VMs' },
  { value: 'note',          label: '📝 Notiz' },
];

const WIDGET_DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  clock: { w: 4, h: 2 }, weather: { w: 4, h: 2 }, device_toggle: { w: 3, h: 2 },
  wol_button: { w: 3, h: 2 }, proxmox_vms: { w: 6, h: 3 }, note: { w: 4, h: 2 },
};

function WidgetForm({
  onSave, onCancel, devices, t, accent,
}: {
  onSave: (w: Omit<Widget, 'id' | 'userId'>) => Promise<void>;
  onCancel: () => void;
  devices: Device[];
  t: ReturnType<typeof tok>;
  accent: string;
}) {
  const [wtype, setWtype] = useState('clock');
  const [format, setFormat] = useState<'12h' | '24h'>('24h');
  const [showSeconds, setShowSeconds] = useState(false);
  const [showDate, setShowDate] = useState(true);
  const [location, setLocation] = useState('');
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [wolLabel, setWolLabel] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [loading, setLoading] = useState(false);

  const def = WIDGET_DEFAULT_SIZE[wtype] ?? { w: 4, h: 2 };

  const buildConfig = (): WidgetConfig | null => {
    if (wtype === 'clock') return { type: 'clock', format, showSeconds, showDate };
    if (wtype === 'weather') return { type: 'weather', location: location || undefined };
    if (wtype === 'device_toggle') { if (!deviceId) return null; return { type: 'device_toggle', deviceId }; }
    if (wtype === 'wol_button') { if (!deviceId) return null; return { type: 'wol_button', deviceId, label: wolLabel || undefined }; }
    if (wtype === 'proxmox_vms') { if (!deviceId) return null; return { type: 'proxmox_vms', deviceId }; }
    if (wtype === 'note') return { type: 'note', content: noteContent, title: noteTitle || undefined };
    return null;
  };

  const save = async () => {
    const config = buildConfig();
    if (!config) return;
    setLoading(true);
    await onSave({ layout: { col: 1, row: 1, w: def.w, h: def.h }, config });
    setLoading(false);
  };

  const deviceOptions = devices.map((d) => ({ value: d.id, label: `${deviceTypeIcon(d.config.type)} ${d.name}${d.room ? ` (${d.room})` : ''}` }));

  return (
    <div className="space-y-4">
      <Select label="Widget-Typ" value={wtype} onChange={setWtype} options={WIDGET_TYPE_OPTIONS} t={t} accent={accent} />

      {wtype === 'clock' && (
        <div className="space-y-3">
          <Select label="Format" value={format} onChange={(v) => setFormat(v as '12h' | '24h')}
            options={[{ value: '24h', label: '24h (15:30)' }, { value: '12h', label: '12h (3:30 PM)' }]} t={t} accent={accent} />
          <div className="flex gap-4">
            <label className={`flex items-center gap-2 cursor-pointer text-sm ${t.text}`}>
              <input type="checkbox" checked={showSeconds} onChange={(e) => setShowSeconds(e.target.checked)} />
              Sekunden
            </label>
            <label className={`flex items-center gap-2 cursor-pointer text-sm ${t.text}`}>
              <input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
              Datum
            </label>
          </div>
        </div>
      )}
      {wtype === 'weather' && (
        <Input label="Ort (opt.)" value={location} onChange={setLocation} placeholder="Berlin" t={t} accent={accent} />
      )}
      {(wtype === 'device_toggle' || wtype === 'proxmox_vms') && (
        deviceOptions.length > 0
          ? <Select label="Gerät" value={deviceId} onChange={setDeviceId} options={deviceOptions} t={t} accent={accent} />
          : <p className={`text-sm ${t.muted}`}>Keine Geräte vorhanden. Zuerst in den Einstellungen Geräte hinzufügen.</p>
      )}
      {wtype === 'wol_button' && (
        <div className="space-y-3">
          {deviceOptions.length > 0
            ? <Select label="Gerät" value={deviceId} onChange={setDeviceId}
                options={deviceOptions.filter((d) => devices.find((dev) => dev.id === d.value)?.config.type === 'wol')}
                t={t} accent={accent} />
            : <p className={`text-sm ${t.muted}`}>Kein WOL-Gerät vorhanden.</p>}
          <Input label="Beschriftung (opt.)" value={wolLabel} onChange={setWolLabel} placeholder="Server aufwecken" t={t} accent={accent} />
        </div>
      )}
      {wtype === 'note' && (
        <div className="space-y-3">
          <Input label="Titel (opt.)" value={noteTitle} onChange={setNoteTitle} placeholder="Notiz" t={t} accent={accent} />
          <div className="space-y-1.5">
            <label className={`block text-sm font-medium ${t.muted}`}>Inhalt</label>
            <textarea
              value={noteContent} onChange={(e) => setNoteContent(e.target.value)}
              rows={3} placeholder="Deine Notiz…"
              className={`focus-accent w-full rounded-xl px-3.5 py-2.5 text-sm outline-none transition-all resize-none
                ${t.inputBg} ${t.inputText} ${t.inputBorder}`}
              style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Btn accent={accent} className="flex-1" onClick={save} loading={loading}>Widget hinzufügen</Btn>
        <Btn accent={accent} variant="secondary" onClick={onCancel}>Abbrechen</Btn>
      </div>
    </div>
  );
}

// ── Widget renderers ──────────────────────────────────────────────────────────

function ClockWidget({ config, t, accent }: { config: Extract<WidgetConfig, { type: 'clock' }>; t: ReturnType<typeof tok>; accent: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const fmt = (d: Date) => {
    if (config.format === '12h') {
      const h = d.getHours() % 12 || 12;
      const m = d.getMinutes().toString().padStart(2, '0');
      const s = config.showSeconds ? `:${d.getSeconds().toString().padStart(2, '0')}` : '';
      return `${h}:${m}${s} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
    }
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = config.showSeconds ? `:${d.getSeconds().toString().padStart(2, '0')}` : '';
    return `${h}:${m}${s}`;
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <p className="text-4xl font-thin tabular-nums tracking-tight" style={{ color: accent }}>{fmt(now)}</p>
      {config.showDate !== false && (
        <p className={`text-xs ${t.muted}`}>
          {now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      )}
    </div>
  );
}

function WeatherWidget({ config, t, accent }: { config: Extract<WidgetConfig, { type: 'weather' }>; t: ReturnType<typeof tok>; accent: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <span className="text-5xl">🌤</span>
      <p className={`text-sm font-medium ${t.text}`}>{config.location ?? 'Aktueller Standort'}</p>
      <p className={`text-xs ${t.muted}`}>Wetter-API nicht konfiguriert</p>
    </div>
  );
}

function DeviceToggleWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'device_toggle' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);

  const doAction = async (action: 'on' | 'off' | 'toggle') => {
    if (!device) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action }),
      });
      if (r.ok) {
        const data = await r.json() as any;
        if (typeof data.ison === 'boolean') setOn(data.ison);
        else if (action === 'on') setOn(true);
        else if (action === 'off') setOn(false);
        setStatus(null);
      } else {
        setStatus('Fehler');
      }
    } catch { setStatus('Netzwerkfehler'); }
    setLoading(false);
  };

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <p className={`text-sm font-medium ${t.text}`}>{device.name}</p>
          {device.room && <p className={`text-xs ${t.muted}`}>{device.room}</p>}
        </div>
        <span className="text-2xl">{device.icon ?? deviceTypeIcon(device.config.type)}</span>
      </div>
      {on !== null && (
        <div className="flex items-center gap-1.5">
          <div className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className={`text-xs ${t.muted}`}>{on ? 'Ein' : 'Aus'}</span>
        </div>
      )}
      {status && <p className="text-xs text-red-500">{status}</p>}
      <div className="mt-auto flex gap-2">
        <button
          onClick={() => doAction('on')} disabled={loading}
          className={`flex-1 rounded-xl py-2 text-xs font-medium transition-all ${on === true ? 'text-white' : `${t.inputBg} ${t.text} opacity-60 hover:opacity-100`}`}
          style={on === true ? { backgroundColor: accent } : {}}>
          {loading ? <Spinner size={12} /> : 'Ein'}
        </button>
        <button
          onClick={() => doAction('off')} disabled={loading}
          className={`flex-1 rounded-xl py-2 text-xs font-medium transition-all ${on === false ? 'bg-red-500/80 text-white' : `${t.inputBg} ${t.text} opacity-60 hover:opacity-100`}`}>
          {loading ? <Spinner size={12} /> : 'Aus'}
        </button>
      </div>
    </div>
  );
}

function WolButtonWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'wol_button' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const wake = async () => {
    if (!device) return;
    setLoading(true);
    try {
      await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'wake' }),
      });
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch {}
    setLoading(false);
  };

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="text-3xl">⚡</span>
      <p className={`text-sm font-medium ${t.text}`}>{config.label ?? device.name}</p>
      {sent ? (
        <p className="text-xs text-green-500">Magic Packet gesendet ✓</p>
      ) : (
        <Btn accent={accent} onClick={wake} loading={loading} size="sm">Aufwecken</Btn>
      )}
    </div>
  );
}

function ProxmoxVmsWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'proxmox_vms' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [vms, setVms] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    if (!device) return;
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'list_vms' }),
      });
      if (!r.ok) { setErr('Proxmox API Fehler'); }
      else {
        const data = await r.json() as any;
        setVms((data.data ?? []).slice(0, 8));
      }
    } catch { setErr('Netzwerkfehler'); }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [config.deviceId]);

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className={`text-sm font-medium ${t.text}`}>{device.name}</p>
        <button onClick={() => void load()} className={`text-xs ${t.muted} hover:opacity-100 opacity-60`}>↻</button>
      </div>
      {loading && <div className="flex flex-1 items-center justify-center"><Spinner size={20} color={accent} /></div>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      {!loading && vms.length === 0 && !err && <p className={`text-xs ${t.muted}`}>Keine VMs gefunden</p>}
      <div className="flex flex-col gap-1 overflow-auto">
        {vms.map((vm) => (
          <div key={vm.vmid} className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${t.inputBg}`}>
            <div className="flex items-center gap-2">
              <div className={`h-1.5 w-1.5 rounded-full ${vm.status === 'running' ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className={`text-xs ${t.text}`}>{vm.name ?? `VM ${vm.vmid}`}</span>
            </div>
            <span className={`text-[10px] ${t.muted}`}>{vm.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoteWidget({ config, t }: {
  config: Extract<WidgetConfig, { type: 'note' }>;
  t: ReturnType<typeof tok>;
}) {
  return (
    <div className="flex h-full flex-col gap-2">
      {config.title && <p className={`text-sm font-semibold ${t.text}`}>{config.title}</p>}
      <p className={`text-sm leading-relaxed ${t.muted} overflow-auto`}>{config.content}</p>
    </div>
  );
}

function WidgetRenderer({ widget, devices, t, accent, onRemove }: {
  widget: Widget; devices: Device[];
  t: ReturnType<typeof tok>; accent: string;
  onRemove?: () => void;
}) {
  const c = widget.config;
  return (
    <div className={`group relative rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-px ${t.inputBg} ${t.border}`}
      style={panelStyle(accent, t)}>
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-full bg-red-500/80 text-white text-xs group-hover:flex">
          ×
        </button>
      )}
      {c.type === 'clock'         && <ClockWidget config={c} t={t} accent={accent} />}
      {c.type === 'weather'       && <WeatherWidget config={c} t={t} accent={accent} />}
      {c.type === 'device_toggle' && <DeviceToggleWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'wol_button'    && <WolButtonWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'proxmox_vms'   && <ProxmoxVmsWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'note'          && <NoteWidget config={c} t={t} />}
    </div>
  );
}

// ── Setup Wizard ─────────────────────────────────────────────────────────────

function SetupWizard({ onDone, initStep, initEmail }: { onDone: () => void; initStep: number; initEmail: string }) {
  const [step, setStep] = useState(initStep);
  const [animKey, setAnimKey] = useState(0);
  const [email, setEmail] = useState(initEmail);
  const [dashboardName, setDashboardName] = useState('SM Dashboard');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [accent, setAccent] = useState('#007AFF');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupLoading, setBackupLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const t = tok(theme);

  const go = (n: number) => { setAnimKey((k) => k + 1); setStep(n); setStatus(''); };

  const run = async (fn: () => Promise<void>) => {
    setLoading(true); setStatus('');
    try { await fn(); } catch { setStatus('✗ Ein unerwarteter Fehler ist aufgetreten.'); }
    setLoading(false);
  };

  const startSetup = () => run(async () => {
    const r = await fetch('/api/setup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootEmail: email }) });
    if (!r.ok) return setStatus(`✗ ${await readErr(r, 'Fehler beim Starten')}`);
    go(2);
  });

  const registerPasskey = () => run(async () => {
    const opts = await fetch('/api/setup/root/registration-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!opts.ok) return setStatus(`✗ ${await readErr(opts, 'Optionen konnten nicht geladen werden')}`);
    const reg = await startRegistration({ optionsJSON: await opts.json() });
    const verify = await fetch('/api/setup/root/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse: reg }) });
    if (!verify.ok) return setStatus(`✗ ${await readErr(verify, 'Registrierung fehlgeschlagen')}`);
    go(3);
  });

  const generateBackup = async () => {
    setBackupLoading(true);
    try {
      const r = await fetch('/api/setup/generate-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      if (!r.ok) setStatus(`✗ ${await readErr(r, 'Fehler beim Generieren')}`);
      else setBackupPassword((await r.json() as { rootBackupPassword: string }).rootBackupPassword);
    } catch { setStatus('✗ Netzwerkfehler.'); }
    setBackupLoading(false);
  };

  useEffect(() => { if (step === 3 && !backupPassword) void generateBackup(); }, [step]);

  const confirmBackup = () => run(async () => {
    const r = await fetch('/api/setup/acknowledge-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted: true }) });
    if (!r.ok) return setStatus(`✗ ${await readErr(r, 'Fehler')}`);
    go(4);
  });

  const finish = () => run(async () => {
    const r = await fetch('/api/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, dashboardName, theme, accent }) });
    if (!r.ok) return setStatus(`✗ ${await readErr(r, 'Fehler beim Abschließen')}`);
    setDone(true);
    setTimeout(onDone, 1800);
  });

  const steps = ['E-Mail', 'Passkey', 'Backup', 'Design'];

  return (
    <div className={`min-h-screen ${t.page} flex flex-col items-center justify-center p-6 animate-fade-in`}>
      <div className="w-full max-w-md space-y-6">
        <div className="text-center animate-slide-up">
          <img src="/logo.svg" alt="Logo" className="mx-auto mb-4 h-12 w-12 rounded-2xl" style={{ boxShadow: `0 4px 16px ${accent}44` }} />
          <h1 className={`text-2xl font-semibold tracking-tight ${t.text}`}>Dashboard einrichten</h1>
          <p className={`mt-1 text-sm ${t.muted}`}>Schritt {Math.min(step, 4)} von 4</p>
        </div>

        <div className={`h-1 w-full rounded-full overflow-hidden ${t.inputBg}`}>
          <div className="h-full rounded-full transition-all duration-500"
            style={{ width: `${(Math.min(step, 4) / 4) * 100}%`, backgroundColor: accent }} />
        </div>

        <div className="flex justify-between">
          {steps.map((label, i) => {
            const s = i + 1;
            const active = step === s;
            const done_ = step > s;
            return (
              <div key={s} className="flex flex-col items-center gap-1">
                <div className={`h-6 w-6 rounded-full text-xs flex items-center justify-center font-medium transition-all ${
                  done_ ? 'text-white' : active ? 'text-white' : `${t.muted} ${t.inputBg}`
                }`} style={done_ || active ? { backgroundColor: accent } : {}}>
                  {done_ ? '✓' : s}
                </div>
                <span className={`text-[10px] ${active ? t.text : t.muted}`}>{label}</span>
              </div>
            );
          })}
        </div>

        <div key={animKey} className="animate-slide-up">
          <Card t={t} accent={accent} className="p-7">
            {done ? (
              <div className="flex flex-col items-center gap-4 py-4">
                <SuccessCheck color={accent} />
                <div className="text-center">
                  <p className={`font-semibold ${t.text}`}>Einrichtung abgeschlossen</p>
                  <p className={`mt-1 text-sm ${t.muted}`}>Du wirst weitergeleitet…</p>
                </div>
              </div>
            ) : step === 1 ? (
              <div className="space-y-5">
                <div>
                  <h2 className={`text-lg font-semibold ${t.text}`}>Root-Konto anlegen</h2>
                  <p className={`mt-1 text-sm ${t.muted}`}>Gib deine E-Mail-Adresse ein. Sie wird als Administrator-Konto verwendet.</p>
                </div>
                <Input label="E-Mail" value={email} onChange={setEmail}
                  placeholder="du@beispiel.de" type="email" t={t} accent={accent} autoFocus />
                <StatusMsg msg={status} t={t} />
                <Btn accent={accent} className="w-full" onClick={startSetup} loading={loading}
                  disabled={!email.includes('@')}>Weiter</Btn>
              </div>
            ) : step === 2 ? (
              <div className="space-y-5">
                <div>
                  <h2 className={`text-lg font-semibold ${t.text}`}>Passkey registrieren</h2>
                  <p className={`mt-1 text-sm ${t.muted}`}>Dein Gerät generiert einen sicheren Schlüssel. Keine Passwörter nötig.</p>
                </div>
                <button onClick={() => go(1)}
                  className={`flex w-full items-center gap-3 rounded-xl p-4 text-left transition-all ${t.inputBg} ${t.navHover}`}>
                  <span className="text-base">📧</span>
                  <div>
                    <p className={`text-sm font-medium ${t.text}`}>{email}</p>
                    <p className={`text-xs ${t.muted}`}>Tippe zum Ändern</p>
                  </div>
                </button>
                <StatusMsg msg={status} t={t} />
                <Btn accent={accent} className="w-full" onClick={registerPasskey} loading={loading}>
                  Passkey erstellen
                </Btn>
              </div>
            ) : step === 3 ? (
              <div className="space-y-5">
                <div>
                  <h2 className={`text-lg font-semibold ${t.text}`}>Backup-Code sichern</h2>
                  <p className={`mt-1 text-sm ${t.muted}`}>Bewahre diesen Code sicher auf. Er ist dein einziger Weg ins Dashboard, falls du deinen Passkey verlierst.</p>
                </div>
                {backupLoading ? (
                  <div className="flex items-center justify-center py-8"><Spinner size={24} color={accent} /></div>
                ) : backupPassword ? (
                  <div className="space-y-4">
                    <div className={`rounded-xl border p-4 space-y-2 ${t.inputBg} ${t.border}`}>
                      <p className={`text-xs font-medium ${t.muted}`}>Backup-Code — wird nur einmal angezeigt</p>
                      <p className="font-mono text-base tracking-widest break-all select-all leading-relaxed" style={{ color: accent }}>
                        {backupPassword}
                      </p>
                    </div>
                    <div className={`rounded-xl p-3 text-xs ${t.muted} space-y-1`} style={{ backgroundColor: `${accent}12` }}>
                      <p style={{ color: accent }} className="font-medium">So aufbewahren:</p>
                      <p>• Passwortmanager (empfohlen)</p>
                      <p>• Sicher ausgedruckt und eingeschlossen</p>
                      <p>• Verschlüsseltes Notizdokument</p>
                    </div>
                    <Btn accent={accent} className="w-full" onClick={confirmBackup} loading={loading}>
                      Ich habe den Code gesichert
                    </Btn>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <StatusMsg msg={status} t={t} />
                    <Btn accent={accent} className="w-full" onClick={() => void generateBackup()} loading={backupLoading}>
                      Erneut versuchen
                    </Btn>
                  </div>
                )}
                {backupPassword && <StatusMsg msg={status} t={t} />}
              </div>
            ) : step === 4 ? (
              <div className="space-y-5">
                <div>
                  <h2 className={`text-lg font-semibold ${t.text}`}>Dashboard anpassen</h2>
                  <p className={`mt-1 text-sm ${t.muted}`}>Gib deinem Dashboard einen Namen und wähle das Erscheinungsbild.</p>
                </div>
                <Input label="Dashboard-Name" value={dashboardName} onChange={setDashboardName}
                  placeholder="Mein Dashboard" t={t} accent={accent} />
                <div className="space-y-1.5">
                  <label className={`block text-sm font-medium ${t.muted}`}>Design</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['light', 'dark', 'ultra-dark'] as ThemeMode[]).map((m) => (
                      <button key={m} onClick={() => setTheme(m)}
                        className={`rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                          theme === m ? '' : `${t.border} opacity-40 hover:opacity-70`
                        }`}
                        style={theme === m ? { borderColor: accent, color: accent } : {}}>
                        {m === 'light' ? 'Hell' : m === 'dark' ? 'Dunkel' : 'Ultra-Dark'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className={`block text-sm font-medium ${t.muted}`}>Akzentfarbe</label>
                  <ColorPicker value={accent} onChange={setAccent} t={t} />
                </div>
                <StatusMsg msg={status} t={t} />
                <Btn accent={accent} className="w-full" onClick={finish} loading={loading}>
                  Einrichtung abschließen
                </Btn>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Auth pages ───────────────────────────────────────────────────────────────

function AuthPage({ title, sub, children, accent, t }: {
  title: string; sub: string; children: React.ReactNode;
  accent: string; t: ReturnType<typeof tok>;
}) {
  return (
    <div className={`min-h-screen ${t.page} flex flex-col items-center justify-center p-6 animate-fade-in`}>
      <div className="w-full max-w-sm space-y-6 animate-slide-up">
        <div className="text-center">
          <img src="/logo.svg" alt="Logo" className="mx-auto mb-4 h-11 w-11 rounded-[14px]"
            style={{ boxShadow: `0 4px 14px ${accent}44` }} />
          <h1 className={`text-2xl font-semibold tracking-tight ${t.text}`}>{title}</h1>
          <p className={`mt-1 text-sm ${t.muted}`}>{sub}</p>
        </div>
        <Card t={t} accent={accent} className="p-7">{children}</Card>
      </div>
    </div>
  );
}

function LoginPage({ onLogin, setup }: { onLogin: (u: SessionUser) => void; setup: SetupStatus }) {
  const t = tok(setup.theme);
  const accent = setup.accent;
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    setLoading(true); setStatus('');
    try {
      const ch = await fetch('/api/auth/passkey/authentication-options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      if (!ch.ok) return setStatus(`✗ ${await readErr(ch, 'Anmeldung fehlgeschlagen')}`);
      const assertion = await startAuthentication({ optionsJSON: await ch.json() });
      const verify = await fetch('/api/auth/passkey/verify-authentication', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(assertion),
      });
      if (!verify.ok) return setStatus(`✗ ${await readErr(verify, 'Anmeldung fehlgeschlagen')}`);
      onLogin((await verify.json() as { user: SessionUser }).user);
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') setStatus('✗ Anmeldung fehlgeschlagen oder abgebrochen.');
    } finally { setLoading(false); }
  };

  return (
    <AuthPage title={setup.dashboardName} sub="Melde dich mit deinem Passkey an" accent={accent} t={t}>
      <div className="space-y-4">
        <Input label="E-Mail" value={email} onChange={setEmail}
          placeholder="du@beispiel.de" type="email" t={t} accent={accent} autoFocus />
        <StatusMsg msg={status} t={t} />
        <Btn accent={accent} className="w-full" onClick={signIn}
          loading={loading} disabled={!email.includes('@')}>
          Mit Passkey anmelden
        </Btn>
      </div>
    </AuthPage>
  );
}

function InvitePage({ setup, inviteToken, initEmail }: {
  setup: SetupStatus; inviteToken: string; initEmail: string;
}) {
  const t = tok(setup.theme);
  const accent = setup.accent;
  const [email, setEmail] = useState(initEmail);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const register = async () => {
    setLoading(true); setStatus('');
    try {
      const opts = await fetch('/api/auth/passkey/registration-options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, inviteToken }),
      });
      if (!opts.ok) return setStatus(`✗ ${await readErr(opts, 'Einladung ungültig oder abgelaufen')}`);
      const reg = await startRegistration({ optionsJSON: await opts.json() });
      const verify = await fetch('/api/auth/passkey/verify-registration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, registrationResponse: reg, inviteToken }),
      });
      if (!verify.ok) return setStatus(`✗ ${await readErr(verify, 'Registrierung fehlgeschlagen')}`);
      window.history.replaceState({}, '', window.location.pathname);
      setDone(true);
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') setStatus('✗ Passkey-Erstellung fehlgeschlagen.');
    } finally { setLoading(false); }
  };

  return (
    <AuthPage title="Einladung annehmen" sub="Erstelle deinen Passkey für das Dashboard" accent={accent} t={t}>
      {done ? (
        <div className="flex flex-col items-center gap-4 py-2">
          <SuccessCheck color={accent} />
          <div className="text-center">
            <p className={`font-medium ${t.text}`}>Passkey erstellt</p>
            <p className={`mt-1 text-sm ${t.muted}`}>Du kannst dich jetzt anmelden. Lade die Seite neu.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Input label="E-Mail" value={email} onChange={setEmail} t={t} accent={accent} />
          <StatusMsg msg={status} t={t} />
          <Btn accent={accent} className="w-full" onClick={register}
            loading={loading} disabled={!email.includes('@')}>
            Passkey erstellen
          </Btn>
        </div>
      )}
    </AuthPage>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

type Tab = 'home' | 'devices' | 'admin' | 'settings';

const NAV: { key: Tab; label: string; icon: string }[] = [
  { key: 'home',     label: 'Home',      icon: '⌂' },
  { key: 'devices',  label: 'Geräte',   icon: '◫' },
  { key: 'admin',    label: 'Admin',     icon: '⚙' },
];

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ user, theme, setTheme, accent, setAccent, devices, setDevices, widgets, setWidgets, t }: {
  user: SessionUser; theme: ThemeMode; setTheme: (t: ThemeMode) => void;
  accent: string; setAccent: (a: string) => void;
  devices: Device[]; setDevices: (d: Device[]) => void;
  widgets: Widget[]; setWidgets: (w: Widget[]) => void;
  t: ReturnType<typeof tok>;
}) {
  const canAdmin = user.role === 'root' || user.role === 'admin';
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const [showWidgetForm, setShowWidgetForm] = useState(false);
  const [devStatus, setDevStatus] = useState('');

  const saveDevice = async (data: Omit<Device, 'id'>) => {
    if (editDevice) {
      const r = await fetch(`/api/devices/${editDevice.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(data),
      });
      if (r.ok) {
        const updated = (await r.json() as { device: Device }).device;
        setDevices(devices.map((d) => d.id === updated.id ? updated : d));
        setEditDevice(null);
      } else { setDevStatus(`✗ ${await readErr(r, 'Fehler beim Speichern')}`); }
    } else {
      const r = await fetch('/api/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(data),
      });
      if (r.ok) {
        const { device } = await r.json() as { device: Device };
        setDevices([...devices, device]);
        setShowDeviceForm(false);
      } else { setDevStatus(`✗ ${await readErr(r, 'Fehler beim Erstellen')}`); }
    }
  };

  const deleteDevice = async (id: string) => {
    const r = await fetch(`/api/devices/${id}`, { method: 'DELETE', credentials: 'include' });
    if (r.ok) setDevices(devices.filter((d) => d.id !== id));
  };

  const saveWidget = async (data: Omit<Widget, 'id' | 'userId'>) => {
    const r = await fetch('/api/widgets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify(data),
    });
    if (r.ok) {
      const { widget } = await r.json() as { widget: Widget };
      setWidgets([...widgets, widget]);
      setShowWidgetForm(false);
    }
  };

  const deleteWidget = async (id: string) => {
    const r = await fetch(`/api/widgets/${id}`, { method: 'DELETE', credentials: 'include' });
    if (r.ok) setWidgets(widgets.filter((w) => w.id !== id));
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className={`text-xl font-semibold ${t.text}`}>Einstellungen</h1>

      {/* Appearance */}
      <section className={`rounded-2xl border p-5 space-y-5 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
        <h2 className={`font-semibold ${t.text}`}>Darstellung</h2>
        <div className="space-y-1.5">
          <label className={`block text-sm font-medium ${t.muted}`}>Design</label>
          <div className="grid grid-cols-3 gap-2">
            {(['light', 'dark', 'ultra-dark'] as ThemeMode[]).map((m) => (
              <button key={m} onClick={() => setTheme(m)}
                className={`rounded-xl border px-3 py-2 text-sm font-medium transition-all ${
                  theme === m ? '' : `opacity-40 hover:opacity-70`
                } ${t.border}`}
                style={theme === m ? { borderColor: accent, color: accent, backgroundColor: `${accent}12` } : {}}>
                {m === 'light' ? 'Hell' : m === 'dark' ? 'Dunkel' : 'Ultra-Dark'}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <label className={`block text-sm font-medium ${t.muted}`}>Akzentfarbe</label>
          <ColorPicker value={accent} onChange={setAccent} t={t} />
        </div>
      </section>

      {/* Widgets */}
      <section className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
        <div className="flex items-center justify-between">
          <h2 className={`font-semibold ${t.text}`}>Widgets</h2>
          {!showWidgetForm && (
            <Btn accent={accent} size="sm" onClick={() => setShowWidgetForm(true)}>+ Widget</Btn>
          )}
        </div>

        {showWidgetForm && (
          <div className={`rounded-xl border p-4 ${t.border}`} style={{ borderColor: `${accent}25` }}>
            <WidgetForm onSave={saveWidget} onCancel={() => setShowWidgetForm(false)} devices={devices} t={t} accent={accent} />
          </div>
        )}

        {widgets.length === 0 && !showWidgetForm && (
          <p className={`text-sm ${t.muted}`}>Noch keine Widgets. Füge ein Widget hinzu, um es auf dem Home-Tab anzuzeigen.</p>
        )}
        <div className="space-y-2">
          {widgets.map((w) => (
            <div key={w.id} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${t.border}`}>
              <div className="flex items-center gap-3">
                <span className="text-lg">{
                  w.config.type === 'clock' ? '🕐' :
                  w.config.type === 'weather' ? '🌤' :
                  w.config.type === 'device_toggle' ? '🔌' :
                  w.config.type === 'wol_button' ? '⚡' :
                  w.config.type === 'proxmox_vms' ? '🖥' : '📝'
                }</span>
                <div>
                  <p className={`text-sm font-medium ${t.text}`}>
                    {WIDGET_TYPE_OPTIONS.find((o) => o.value === w.config.type)?.label.replace(/^\S+\s/, '') ?? w.config.type}
                  </p>
                  <p className={`text-xs ${t.muted}`}>{w.layout.w}×{w.layout.h} Einheiten</p>
                </div>
              </div>
              <Btn accent={accent} variant="danger" size="sm" onClick={() => deleteWidget(w.id)}>×</Btn>
            </div>
          ))}
        </div>
      </section>

      {/* Devices (admin only) */}
      {canAdmin && (
        <section className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
          <div className="flex items-center justify-between">
            <h2 className={`font-semibold ${t.text}`}>Geräte verwalten</h2>
            {!showDeviceForm && !editDevice && (
              <Btn accent={accent} size="sm" onClick={() => setShowDeviceForm(true)}>+ Gerät</Btn>
            )}
          </div>

          {devStatus && <StatusMsg msg={devStatus} t={t} />}

          {(showDeviceForm || editDevice) && (
            <div className={`rounded-xl border p-4 ${t.border}`} style={{ borderColor: `${accent}25` }}>
              <p className={`mb-4 text-sm font-medium ${t.text}`}>{editDevice ? 'Gerät bearbeiten' : 'Neues Gerät'}</p>
              <DeviceForm
                initial={editDevice ?? undefined}
                onSave={saveDevice}
                onCancel={() => { setShowDeviceForm(false); setEditDevice(null); setDevStatus(''); }}
                t={t} accent={accent}
              />
            </div>
          )}

          {devices.length === 0 && !showDeviceForm && (
            <p className={`text-sm ${t.muted}`}>Noch keine Geräte konfiguriert.</p>
          )}
          <div className="space-y-2">
            {devices.map((d) => (
              <div key={d.id} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${t.border}`}>
                <div className="flex items-center gap-3">
                  <span className="text-xl">{d.icon ?? deviceTypeIcon(d.config.type)}</span>
                  <div>
                    <p className={`text-sm font-medium ${t.text}`}>{d.name}</p>
                    <p className={`text-xs ${t.muted}`}>{d.room ? `${d.room} · ` : ''}{DEVICE_TYPE_OPTIONS.find((o) => o.value === d.config.type)?.label.replace(/^\S+\s/, '') ?? d.config.type}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Btn accent={accent} variant="secondary" size="sm" onClick={() => { setEditDevice(d); setShowDeviceForm(false); }}>✎</Btn>
                  <Btn accent={accent} variant="danger" size="sm" onClick={() => deleteDevice(d.id)}>×</Btn>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Devices tab ───────────────────────────────────────────────────────────────

function DevicesTab({ devices, t, accent }: { devices: Device[]; t: ReturnType<typeof tok>; accent: string }) {
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  const doAction = async (device: Device, action: string) => {
    setActionStatus((prev) => ({ ...prev, [device.id]: '…' }));
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action }),
      });
      if (r.ok) {
        const data = await r.json() as any;
        if (data.url) { window.open(data.url, '_blank'); }
        setActionStatus((prev) => ({ ...prev, [device.id]: data.ok ? '✓' : data.error ?? '?' }));
      } else {
        const e = await readErr(r, 'Fehler');
        setActionStatus((prev) => ({ ...prev, [device.id]: `✗ ${e}` }));
      }
    } catch { setActionStatus((prev) => ({ ...prev, [device.id]: '✗ Netzwerkfehler' })); }
    setTimeout(() => setActionStatus((prev) => { const n = { ...prev }; delete n[device.id]; return n; }), 3000);
  };

  if (devices.length === 0) {
    return (
      <div className="animate-slide-right">
        <h1 className={`text-xl font-semibold ${t.text}`}>Geräte</h1>
        <p className={`mt-1 text-sm ${t.muted}`}>Verbundene Geräte und Steuerung.</p>
        <div className={`mt-6 rounded-2xl border p-12 text-center ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
          <p className="text-4xl mb-3">📱</p>
          <p className={`font-medium ${t.text}`}>Noch keine Geräte</p>
          <p className={`mt-1 text-sm ${t.muted}`}>Geräte können in den Einstellungen hinzugefügt werden.</p>
        </div>
      </div>
    );
  }

  const rooms = [...new Set(devices.map((d) => d.room ?? 'Allgemein'))];

  return (
    <div className="animate-slide-right space-y-5">
      <div>
        <h1 className={`text-xl font-semibold ${t.text}`}>Geräte</h1>
        <p className={`text-sm ${t.muted}`}>{devices.length} Gerät{devices.length !== 1 ? 'e' : ''} konfiguriert</p>
      </div>

      {rooms.map((room) => (
        <div key={room}>
          <p className={`mb-2 text-xs font-semibold uppercase tracking-widest ${t.muted}`} style={{ color: `${accent}AA` }}>{room}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {devices.filter((d) => (d.room ?? 'Allgemein') === room).map((device, i) => (
              <div key={device.id}
                className={`rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-px ${t.border} ${t.inputBg}`}
                style={{ ...panelStyle(accent, t), animationDelay: `${i * 40}ms` }}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className={`font-medium ${t.text}`}>{device.name}</p>
                    <p className={`text-xs ${t.muted}`}>{DEVICE_TYPE_OPTIONS.find((o) => o.value === device.config.type)?.label.replace(/^\S+\s/, '')}</p>
                  </div>
                  <span className="text-2xl">{device.icon ?? deviceTypeIcon(device.config.type)}</span>
                </div>

                {actionStatus[device.id] && (
                  <p className={`text-xs mb-2 ${actionStatus[device.id].startsWith('✗') ? 'text-red-500' : 'text-green-500'}`}>
                    {actionStatus[device.id]}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {(device.config.type === 'shelly_plug' || device.config.type === 'shelly_light') && (
                    <>
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'on')}>Ein</Btn>
                      <Btn accent={accent} variant="secondary" size="sm" onClick={() => doAction(device, 'off')}>Aus</Btn>
                      <Btn accent={accent} variant="ghost" size="sm" onClick={() => doAction(device, 'status')}>Status</Btn>
                    </>
                  )}
                  {device.config.type === 'wol' && (
                    <Btn accent={accent} size="sm" onClick={() => doAction(device, 'wake')}>⚡ Aufwecken</Btn>
                  )}
                  {device.config.type === 'proxmox' && (
                    <Btn accent={accent} size="sm" onClick={() => doAction(device, 'list_vms')}>VMs laden</Btn>
                  )}
                  {(device.config.type === 'rdp' || device.config.type === 'ssh') && (
                    <Btn accent={accent} size="sm" onClick={() => doAction(device, 'connect')}>🔗 Verbinden</Btn>
                  )}
                  {device.config.type === 'http' && (
                    <>
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'on')}>Ein</Btn>
                      <Btn accent={accent} variant="secondary" size="sm" onClick={() => doAction(device, 'off')}>Aus</Btn>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Admin tab ─────────────────────────────────────────────────────────────────

function AdminTab({ t, accent }: { t: ReturnType<typeof tok>; accent: string }) {
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('user');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [userPerms, setUserPerms] = useState<PermissionFlag[]>([]);
  const [permsLoading, setPermsLoading] = useState(false);

  useEffect(() => { void loadUsers(); }, []);

  const loadUsers = async () => {
    const r = await fetch('/api/admin/users', { credentials: 'include' });
    if (r.ok) setAdminUsers((await r.json() as { users: AdminUser[] }).users);
  };

  const loadUserPerms = async (u: AdminUser) => {
    setSelectedUser(u);
    setPermsLoading(true);
    const r = await fetch(`/api/admin/users/${u.id}/permissions`, { credentials: 'include' });
    if (r.ok) setUserPerms((await r.json() as { permissions: PermissionFlag[] }).permissions);
    setPermsLoading(false);
  };

  const savePerms = async () => {
    if (!selectedUser) return;
    const r = await fetch(`/api/admin/users/${selectedUser.id}/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ permissions: userPerms }),
    });
    if (r.ok) setStatus('✓ Berechtigungen gespeichert');
    else setStatus(`✗ ${await readErr(r, 'Fehler')}`);
    setTimeout(() => setStatus(''), 2500);
  };

  const togglePerm = (p: PermissionFlag) =>
    setUserPerms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);

  const createInvite = async () => {
    setInviteLoading(true); setStatus('');
    const r = await fetch('/api/admin/invites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (!r.ok) setStatus(`✗ ${await readErr(r, 'Einladung fehlgeschlagen')}`);
    else setInviteUrl((await r.json() as { inviteUrl: string }).inviteUrl);
    setInviteLoading(false);
  };

  return (
    <div className="animate-slide-right space-y-6">
      <h1 className={`text-xl font-semibold ${t.text}`}>Administration</h1>

      {/* Invite */}
      <section className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
        <div>
          <h2 className={`font-semibold ${t.text}`}>Nutzer einladen</h2>
          <p className={`mt-0.5 text-sm ${t.muted}`}>Generiere einen Einladungslink.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input value={inviteEmail} onChange={setInviteEmail}
            placeholder="neu@beispiel.de" type="email" t={t} accent={accent} />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}
            className={`focus-accent rounded-xl px-3.5 py-2.5 text-sm outline-none transition-all
              ${t.inputBg} ${t.inputText} ${t.inputBorder}`}
            style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}>
            <option value="admin">Admin</option>
            <option value="user">User</option>
            <option value="readonly">Lesend</option>
          </select>
          <Btn accent={accent} onClick={createInvite} loading={inviteLoading}
            disabled={!inviteEmail.includes('@')}>
            Einladung erstellen
          </Btn>
        </div>
        {status && <StatusMsg msg={status} t={t} />}
        {inviteUrl && (
          <div className={`rounded-xl border p-3 ${t.border}`} style={{ borderColor: `${accent}30`, backgroundColor: `${accent}08` }}>
            <p className={`mb-1 text-xs font-medium ${t.muted}`}>Einladungslink</p>
            <p className="break-all font-mono text-xs" style={{ color: accent }}>{inviteUrl}</p>
          </div>
        )}
      </section>

      {/* Users + Permissions */}
      <section className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
        <h2 className={`font-semibold ${t.text}`}>Nutzer & Berechtigungen</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {/* User list */}
          <div className="space-y-2">
            {adminUsers.map((u) => (
              <button key={u.id}
                onClick={() => loadUserPerms(u)}
                className={`w-full flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-all ${t.border} ${t.navHover} ${selectedUser?.id === u.id ? t.navActive : ''}`}
                style={selectedUser?.id === u.id ? { borderColor: `${accent}30` } : {}}>
                <div>
                  <span className={t.text}>{u.email}</span>
                  <p className={`text-xs capitalize ${t.muted}`}>{u.role}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    u.hasPasskey ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'
                  }`}>{u.hasPasskey ? 'Passkey' : 'Kein Passkey'}</span>
                  <span className={`text-xs ${t.muted}`}>›</span>
                </div>
              </button>
            ))}
          </div>

          {/* Permission editor */}
          {selectedUser && (
            <div className={`rounded-xl border p-4 space-y-3 ${t.border}`} style={{ borderColor: `${accent}20` }}>
              <p className={`text-sm font-medium ${t.text}`}>Berechtigungen für {selectedUser.email.split('@')[0]}</p>
              {permsLoading ? (
                <Spinner size={20} color={accent} />
              ) : (
                <div className="space-y-1.5">
                  {ALL_PERMISSIONS.map(({ flag, label, desc }) => (
                    <label key={flag} className={`flex items-start gap-2.5 cursor-pointer rounded-lg px-3 py-2 text-sm transition-all ${t.navHover}`}>
                      <input type="checkbox" checked={userPerms.includes(flag)} onChange={() => togglePerm(flag)}
                        className="mt-0.5 rounded flex-shrink-0" />
                      <div>
                        <p className={t.text}>{label}</p>
                        <p className={`text-xs ${t.muted}`}>{desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              <Btn accent={accent} size="sm" className="w-full" onClick={savePerms}>Speichern</Btn>
              {status && <StatusMsg msg={status} t={t} />}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Dashboard shell ───────────────────────────────────────────────────────────

function Dashboard({ user, setup, onSignOut }: {
  user: SessionUser; setup: SetupStatus; onSignOut: () => void;
}) {
  const [theme, setTheme] = useState<ThemeMode>(setup.theme);
  const [accent, setAccent] = useState(setup.accent);
  const t = tok(theme);
  const [tab, setTab] = useState<Tab>('home');
  const [profileOpen, setProfileOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [showAddWidget, setShowAddWidget] = useState(false);

  const canAdmin = user.role === 'root' || user.role === 'admin';
  const visibleNav = NAV.filter((n) => n.key !== 'admin' || canAdmin);

  useEffect(() => {
    void fetch('/api/devices', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { devices: [] })
      .then((d: { devices: Device[] }) => setDevices(d.devices));
    void fetch('/api/widgets', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { widgets: [] })
      .then((d: { widgets: Widget[] }) => setWidgets(d.widgets));
  }, []);

  const goTab = (k: Tab) => { setTab(k); setProfileOpen(false); };

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    onSignOut();
  };

  const addWidget = async (data: Omit<Widget, 'id' | 'userId'>) => {
    const r = await fetch('/api/widgets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify(data),
    });
    if (r.ok) {
      const { widget } = await r.json() as { widget: Widget };
      setWidgets((prev) => [...prev, widget]);
    }
    setShowAddWidget(false);
  };

  const removeWidget = async (id: string) => {
    const r = await fetch(`/api/widgets/${id}`, { method: 'DELETE', credentials: 'include' });
    if (r.ok) setWidgets((prev) => prev.filter((w) => w.id !== id));
  };

  return (
    <div className={`min-h-screen transition-colors duration-300 ${t.page} p-3 md:p-4 animate-fade-in`}
      style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}>
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1800px] gap-3 md:gap-4">

        {/* Sidebar */}
        <aside className={`flex w-[220px] shrink-0 flex-col rounded-2xl border backdrop-blur-xl
          transition-shadow duration-300 ${t.card} ${t.border}`}
          style={{ boxShadow: `${t.shadowSm}, inset 0 1px 0 0 ${accent}15`, borderColor: `${accent}1A` }}>
          <div className={`border-b px-4 py-4 ${t.divider}`}>
            <div className="flex items-center gap-2.5">
              <img src="/logo.svg" alt="Logo" className="h-8 w-8 rounded-xl"
                style={{ boxShadow: `0 2px 8px ${accent}44` }} />
              <span className={`text-sm font-semibold ${t.text}`}>{setup.dashboardName}</span>
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-0.5 p-2">
            {visibleNav.map((item) => (
              <button key={item.key} onClick={() => goTab(item.key)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-all
                  ${tab === item.key ? t.navActive : t.navHover} ${t.text}`}
                style={tab === item.key ? { color: accent } : {}}>
                <span className="text-base leading-none">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className={`border-t p-2 ${t.divider}`}>
            <div className="relative">
              <button onClick={() => setProfileOpen((v) => !v)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all ${t.navHover}`}>
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: accent }}>
                  {user.email[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className={`truncate text-xs font-medium ${t.text}`}>{user.email}</p>
                  <p className={`text-[10px] capitalize ${t.muted}`}>{user.role}</p>
                </div>
              </button>
              {profileOpen && (
                <div className={`absolute bottom-full left-0 mb-1 w-full rounded-xl border p-1
                  ${t.card} ${t.border} animate-slide-up`} style={{ boxShadow: t.shadow }}>
                  <button onClick={() => goTab('settings')}
                    className={`block w-full rounded-lg px-3 py-2 text-left text-xs transition-all ${t.navHover} ${t.text}`}>
                    Einstellungen
                  </button>
                  <button onClick={signOut}
                    className="block w-full rounded-lg px-3 py-2 text-left text-xs text-red-500 transition-all hover:bg-red-500/10">
                    Abmelden
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Content */}
        <main className={`min-w-0 flex-1 rounded-2xl border backdrop-blur-xl p-5 md:p-6
          transition-shadow duration-300 ${t.card} ${t.border}`}
          style={{ boxShadow: `${t.shadowSm}, inset 0 1px 0 0 ${accent}12`, borderColor: `${accent}18` }}>

          {tab === 'home' && (
            <div className="animate-slide-right space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className={`text-xl font-semibold ${t.text}`}>Übersicht</h1>
                  <p className={`text-sm ${t.muted}`}>Guten Tag, {user.email.split('@')[0]}</p>
                </div>
                <Btn accent={accent} size="sm" variant="secondary" onClick={() => setShowAddWidget(true)}>+ Widget</Btn>
              </div>

              {showAddWidget && (
                <div className={`rounded-2xl border p-5 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
                  <p className={`mb-4 font-medium ${t.text}`}>Widget hinzufügen</p>
                  <WidgetForm onSave={addWidget} onCancel={() => setShowAddWidget(false)} devices={devices} t={t} accent={accent} />
                </div>
              )}

              {widgets.length === 0 && !showAddWidget && (
                <div className={`rounded-2xl border border-dashed p-12 text-center ${t.border}`}>
                  <p className="text-4xl mb-3">🧩</p>
                  <p className={`font-medium ${t.text}`}>Keine Widgets</p>
                  <p className={`mt-1 text-sm ${t.muted}`}>Klicke auf „+ Widget" um dein Dashboard anzupassen.</p>
                </div>
              )}

              <div className="grid grid-cols-12 gap-4">
                {widgets.map((widget, i) => {
                  const colSpan = Math.min(12, Math.max(2, widget.layout.w * 3));
                  const rowH = widget.layout.h === 1 ? 'h-32' : widget.layout.h === 2 ? 'h-44' : 'h-64';
                  return (
                    <div key={widget.id}
                      className={`col-span-12 md:col-span-${colSpan} animate-slide-up`}
                      style={{ animationDelay: `${i * 40}ms` }}>
                      <div className={rowH}>
                        <WidgetRenderer widget={widget} devices={devices} t={t} accent={accent}
                          onRemove={() => removeWidget(widget.id)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'devices' && (
            <DevicesTab devices={devices} t={t} accent={accent} />
          )}

          {tab === 'settings' && (
            <SettingsPanel
              user={user} theme={theme} setTheme={setTheme}
              accent={accent} setAccent={setAccent}
              devices={devices} setDevices={setDevices}
              widgets={widgets} setWidgets={setWidgets}
              t={t}
            />
          )}

          {tab === 'admin' && canAdmin && (
            <AdminTab t={t} accent={accent} />
          )}
        </main>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [inviteToken, setInviteToken] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [initStep, setInitStep] = useState(1);

  useEffect(() => { void (async () => {
    const params = new URLSearchParams(window.location.search);
    const inv = params.get('invite') ?? '';
    if (inv) { setInviteToken(inv); setInviteEmail(params.get('email') ?? ''); }

    const res = await fetch('/api/setup/status');
    const data = (await res.json()) as SetupStatus;
    setSetup(data);
    if (data.setupStarted && !data.completed) setInitStep(2);

    if (data.completed) {
      const me = await fetch('/api/auth/me', { credentials: 'include' });
      if (me.ok) setUser((await me.json() as { user: SessionUser }).user);
    }
  })(); }, []);

  if (!setup) return (
    <div className="min-h-screen bg-[#1C1C1E] flex items-center justify-center">
      <Spinner size={28} color="#007AFF" />
    </div>
  );

  if (!setup.completed) {
    return <SetupWizard initStep={initStep} initEmail={setup.rootEmail ?? ''} onDone={() => window.location.reload()} />;
  }
  if (!user && inviteToken) {
    return <InvitePage setup={setup} inviteToken={inviteToken} initEmail={inviteEmail} />;
  }
  if (!user) {
    return <LoginPage setup={setup} onLogin={setUser} />;
  }
  return <Dashboard user={user} setup={setup} onSignOut={() => setUser(null)} />;
}
