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
  | 'view:proxmox' | 'control:proxmox' | 'view:rdp' | 'view:ssh' | 'control:http'
  | 'control:tasmota' | 'view:docker' | 'control:docker' | 'view:tailscale';

const ALL_PERMISSIONS: { flag: PermissionFlag; label: string; desc: string }[] = [
  { flag: 'control:plugs',    label: 'Steckdosen',      desc: 'Smart Plugs ein/ausschalten' },
  { flag: 'control:lights',   label: 'Licht',            desc: 'Lichter steuern' },
  { flag: 'control:wol',      label: 'Wake-on-LAN',      desc: 'Geräte per WOL aufwecken' },
  { flag: 'view:proxmox',     label: 'Proxmox (lesen)',  desc: 'VMs einsehen' },
  { flag: 'control:proxmox',  label: 'Proxmox (ctrl)',   desc: 'VMs starten/stoppen' },
  { flag: 'view:rdp',         label: 'RDP anzeigen',     desc: 'RDP-Verbindungsdaten sehen' },
  { flag: 'view:ssh',         label: 'SSH anzeigen',     desc: 'SSH-Verbindungsdaten sehen' },
  { flag: 'control:http',     label: 'HTTP-Geräte',      desc: 'HTTP-Gerätebefehle senden' },
  { flag: 'control:tasmota',  label: 'Tasmota-Geräte',   desc: 'Tasmota Steckdosen steuern' },
  { flag: 'view:docker',      label: 'Docker (lesen)',   desc: 'Container-Status einsehen' },
  { flag: 'control:docker',   label: 'Docker (ctrl)',    desc: 'Container starten/stoppen' },
  { flag: 'view:tailscale',   label: 'Tailscale',        desc: 'Netzwerk-Peers einsehen' },
];

type DeviceConfig =
  | { type: 'shelly_plug';  ip: string; channel?: number }
  | { type: 'shelly_light'; ip: string; channel?: number }
  | { type: 'wol';  mac: string; broadcastIp?: string; port?: number }
  | { type: 'proxmox'; ip: string; port?: number; tokenId: string; tokenSecret: string; allowSelfSigned?: boolean; node?: string }
  | { type: 'rdp'; ip: string; port?: number; username?: string }
  | { type: 'ssh'; ip: string; port?: number; username?: string }
  | { type: 'http'; ip: string; onPath: string; offPath?: string; method?: string }
  | { type: 'tasmota'; ip: string; channels?: number }
  | { type: 'docker'; ip: string; port?: number }
  | { type: 'tailscale'; apiKey: string; tailnet: string };

type Device = {
  id: string; name: string; type: string; room?: string; icon?: string;
  config?: DeviceConfig; // absent in zero-knowledge mode (Pi Agent configured)
  requiredPermissions: PermissionFlag[];
};

type MonitorStatus = { deviceId: string; online: boolean; latencyMs: number | null; lastCheck: number };

type DiscoveredDevice = {
  ip: string;
  mac?: string;
  hostname?: string;
  type: 'shelly_plug' | 'shelly_light' | 'tasmota' | 'proxmox' | 'docker' | 'http' | 'unknown';
  via: 'arp' | 'mdns';
  discoveredAt: number;
};

type AuditEntry = {
  ts: number;
  kind: 'action' | 'config_create' | 'config_update' | 'config_delete' | 'agent_register' | 'agent_ip_change' | 'discovery' | 'auth_fail';
  ok: boolean;
  actor?: string;
  deviceId?: string;
  deviceType?: string;
  action?: string;
  target?: string;
  statusCode?: number;
  latencyMs?: number;
  message?: string;
};

type WidgetLayout = { col: number; row: number; w: number; h: number };
type WidgetConfig =
  | { type: 'clock';              format?: '12h' | '24h'; showSeconds?: boolean; showDate?: boolean }
  | { type: 'weather';            location?: string; unit?: 'C' | 'F' }
  | { type: 'device_toggle';      deviceId: string }
  | { type: 'wol_button';         deviceId: string; label?: string }
  | { type: 'proxmox_vms';        deviceId: string }
  | { type: 'note';               content: string; title?: string }
  | { type: 'quick_actions';      deviceIds: string[] }
  | { type: 'energy';             deviceId: string }
  | { type: 'docker_containers';  deviceId: string }
  | { type: 'tailscale_peers';    deviceId: string }
  | { type: 'monitor';            deviceIds?: string[] };

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
      page:        'bg-[#F2F2F7]',
      card:        'bg-white/88',
      cardSolid:   'bg-white',
      border:      'border-black/[0.06]',
      text:        'text-[#1D1D1F]',
      label:       'text-[#3C3C43]',
      muted:       'text-[#8E8E93]',
      inputBg:     'bg-[#F2F2F7]',
      inputText:   'text-[#1D1D1F] placeholder:text-[#C7C7CC]',
      inputBorder: '',
      divider:     'border-black/[0.055]',
      navHover:    'hover:bg-black/[0.042] active:bg-black/[0.07]',
      navActive:   'font-semibold',
      userCard:    'bg-black/[0.04]',
      shadow:      '0 4px 24px rgba(0,0,0,0.09), 0 1px 3px rgba(0,0,0,0.05)',
      shadowSm:    '0 2px 10px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04)',
      shadowLg:    '0 20px 60px rgba(0,0,0,0.13), 0 6px 16px rgba(0,0,0,0.06)',
    },
    dark: {
      page:        'bg-black',
      card:        'bg-[#1C1C1E]/88',
      cardSolid:   'bg-[#1C1C1E]',
      border:      'border-white/[0.1]',
      text:        'text-[#F5F5F7]',
      label:       'text-[#EBEBF5CC]',
      muted:       'text-[#98989F]',
      inputBg:     'bg-[#2C2C2E]',
      inputText:   'text-[#F5F5F7] placeholder:text-[#48484A]',
      inputBorder: '',
      divider:     'border-white/[0.07]',
      navHover:    'hover:bg-white/[0.06] active:bg-white/[0.1]',
      navActive:   'font-semibold',
      userCard:    'bg-white/[0.05]',
      shadow:      '0 4px 28px rgba(0,0,0,0.55), 0 1px 4px rgba(0,0,0,0.3)',
      shadowSm:    '0 2px 14px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.22)',
      shadowLg:    '0 24px 80px rgba(0,0,0,0.75), 0 8px 24px rgba(0,0,0,0.45)',
    },
    'ultra-dark': {
      page:        'bg-[#050505]',
      card:        'bg-[#111111]/92',
      cardSolid:   'bg-[#111111]',
      border:      'border-white/[0.07]',
      text:        'text-[#F5F5F7]',
      label:       'text-[#EBEBF5B3]',
      muted:       'text-[#6E6E73]',
      inputBg:     'bg-[#1C1C1E]',
      inputText:   'text-[#F5F5F7] placeholder:text-[#3A3A3C]',
      inputBorder: '',
      divider:     'border-white/[0.06]',
      navHover:    'hover:bg-white/[0.05] active:bg-white/[0.08]',
      navActive:   'font-semibold',
      userCard:    'bg-white/[0.04]',
      shadow:      '0 4px 32px rgba(0,0,0,0.75), 0 1px 4px rgba(0,0,0,0.5)',
      shadowSm:    '0 2px 16px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.42)',
      shadowLg:    '0 28px 100px rgba(0,0,0,0.92), 0 10px 32px rgba(0,0,0,0.65)',
    },
  } as const;
  return t[theme];
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

// ── SF Symbol-inspired icons ──────────────────────────────────

function IcHome({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M9.293 2.293a1 1 0 0 1 1.414 0l7 7A1 1 0 0 1 17 11h-1v7a1 1 0 0 1-1 1h-3.5a1 1 0 0 1-1-1v-3.5h-3V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7H2a1 1 0 0 1-.707-1.707l8-8z"/>
    </svg>
  );
}

function IcGrid({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <rect x="2" y="2" width="7" height="7" rx="1.5"/>
      <rect x="11" y="2" width="7" height="7" rx="1.5"/>
      <rect x="2" y="11" width="7" height="7" rx="1.5"/>
      <rect x="11" y="11" width="7" height="7" rx="1.5"/>
    </svg>
  );
}

function IcRadar({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="8"/>
      <circle cx="10" cy="10" r="4.5"/>
      <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/>
      <line x1="10" y1="2" x2="10" y2="5.5" strokeLinecap="round"/>
    </svg>
  );
}

function IcPerson({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <circle cx="10" cy="6.5" r="3.5"/>
      <path d="M2.5 18c0-3.866 3.358-7 7.5-7s7.5 3.134 7.5 7H2.5z"/>
    </svg>
  );
}

function IcGear({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 0 1-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 0 1 .947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 0 1 2.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 0 1 2.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 0 1 .947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 0 1-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 0 1-2.287-.947zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
    </svg>
  );
}

function FaceIDIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <path d="M7 3H4a1 1 0 0 0-1 1v3M17 3h3a1 1 0 0 1 1 1v3M7 21H4a1 1 0 0 1-1-1v-3M17 21h3a1 1 0 0 0 1-1v-3"/>
      <path d="M9 9v1M15 9v1"/>
      <path d="M9.5 15.5a3.5 3.5 0 0 0 5 0"/>
      <path d="M12 9v3.5"/>
    </svg>
  );
}

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
  const pad = size === 'sm' ? 'px-3.5 py-[7px] text-[13px]' : 'px-4 py-[10px] text-[14px]';
  const base = `inline-flex items-center justify-center gap-2 font-medium select-none cursor-pointer
    transition-all duration-150 ease-out
    active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none
    ${size === 'sm' ? 'rounded-[10px]' : 'rounded-[12px]'} ${pad}`;
  if (variant === 'primary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-white ${className}`}
      style={{ backgroundColor: accent, boxShadow: `0 2px 10px ${accent}60, 0 1px 2px ${accent}30` }}>
      {loading ? <Spinner size={15} color="white" /> : children}
    </button>
  );
  if (variant === 'danger') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-white bg-[#FF3B30] ${className}`}
      style={{ boxShadow: '0 2px 8px rgba(255,59,48,0.4)' }}>
      {loading ? <Spinner size={15} color="white" /> : children}
    </button>
  );
  if (variant === 'secondary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} border ${className}`}
      style={{
        color: accent,
        borderColor: `${accent}30`,
        backgroundColor: `${accent}0F`,
      }}>
      {loading ? <Spinner size={15} color={accent} /> : children}
    </button>
  );
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} bg-white/[0.07] border border-white/[0.1] text-[#F5F5F7]/70 hover:text-[#F5F5F7] hover:bg-white/[0.1] ${className}`}>
      {loading ? <Spinner size={15} color="currentColor" /> : children}
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
      {label && (
        <label className={`block text-[13px] font-medium ${t.muted}`}>{label}</label>
      )}
      <input
        ref={ref}
        type={type} value={value} placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`focus-accent w-full rounded-[12px] px-4 py-3 text-[15px] leading-snug outline-none transition-all
          ${t.inputBg} ${t.inputText} disabled:opacity-50`}
        style={{ '--accent-ring': `${accent}45` } as React.CSSProperties}
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
  { value: 'tasmota',      label: '🔌 Tasmota Gerät (NOUS, Sonoff…)' },
  { value: 'wol',          label: '⚡ Wake-on-LAN' },
  { value: 'proxmox',      label: '🖥  Proxmox Server' },
  { value: 'docker',       label: '🐳 Docker Host' },
  { value: 'rdp',          label: '🪟 Windows RDP' },
  { value: 'ssh',          label: '🐧 SSH / Linux' },
  { value: 'tailscale',    label: '🔒 Tailscale Netzwerk' },
  { value: 'http',         label: '🌐 HTTP Gerät' },
];

const deviceTypeIcon = (type: string) => {
  const map: Record<string, string> = {
    shelly_plug: '🔌', shelly_light: '💡', tasmota: '🔌',
    wol: '⚡', proxmox: '🖥', docker: '🐳',
    rdp: '🪟', ssh: '🐧', tailscale: '🔒', http: '🌐',
  };
  return map[type] ?? '📱';
};

const deviceTypePermission = (type: string): PermissionFlag | null => {
  const map: Record<string, PermissionFlag> = {
    shelly_plug: 'control:plugs', shelly_light: 'control:lights',
    tasmota: 'control:tasmota', wol: 'control:wol',
    proxmox: 'view:proxmox', docker: 'view:docker',
    rdp: 'view:rdp', ssh: 'view:ssh',
    tailscale: 'view:tailscale', http: 'control:http',
  };
  return map[type] ?? null;
};

// ── Device Form (add/edit) ────────────────────────────────────────────────────

function DeviceForm({
  initial, onSave, onCancel, t, accent,
}: {
  initial?: Partial<Device>;
  onSave: (d: Omit<Device, 'id'> & { config: DeviceConfig }) => Promise<void>;
  onCancel: () => void;
  t: ReturnType<typeof tok>;
  accent: string;
}) {
  const isEdit = Boolean(initial?.id);
  const [name, setName] = useState(initial?.name ?? '');
  const [room, setRoom] = useState(initial?.room ?? '');
  const [type, setType] = useState<string>(initial?.type ?? initial?.config?.type ?? 'shelly_plug');
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
  const [tasmotaChannels, setTasmotaChannels] = useState(String((initial?.config as any)?.channels ?? '1'));
  const [dockerPort, setDockerPort] = useState(String((initial?.config as any)?.port ?? ''));
  const [tailscaleApiKey, setTailscaleApiKey] = useState((initial?.config as any)?.apiKey ?? '');
  const [tailscaleTailnet, setTailscaleTailnet] = useState((initial?.config as any)?.tailnet ?? '');
  const [perms, setPerms] = useState<PermissionFlag[]>(initial?.requiredPermissions ?? []);
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);

  // When editing an existing device, load the sensitive config from server (Pi Agent)
  useEffect(() => {
    if (!isEdit || !initial?.id || initial.config) return; // config already available
    setConfigLoading(true);
    fetch(`/api/devices/${initial.id}/config`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { config: any } | null) => {
        if (!d?.config) return;
        const c = d.config;
        if (c.ip) setIp(c.ip);
        if (c.mac) setMac(c.mac);
        if (c.broadcastIp) setBroadcastIp(c.broadcastIp);
        if (c.tokenId) setTokenId(c.tokenId);
        if (c.tokenSecret) setTokenSecret(c.tokenSecret);
        if (c.node) setPxNode(c.node);
        if (c.allowSelfSigned !== undefined) setAllowSelfSigned(c.allowSelfSigned);
        if (c.username) setUsername(c.username);
        if (c.port) setPort(String(c.port));
        if (c.onPath) setOnPath(c.onPath);
        if (c.offPath) setOffPath(c.offPath);
        if (c.channels) setTasmotaChannels(String(c.channels));
        if (c.apiKey) setTailscaleApiKey(c.apiKey);
        if (c.tailnet) setTailscaleTailnet(c.tailnet);
      })
      .finally(() => setConfigLoading(false));
  }, [isEdit, initial?.id]);

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
    if (type === 'tasmota') return { type, ip, channels: Number(tasmotaChannels) || 1 };
    if (type === 'docker') return { type, ip, port: dockerPort ? Number(dockerPort) : undefined };
    if (type === 'tailscale') { if (!tailscaleApiKey || !tailscaleTailnet) return null; return { type, apiKey: tailscaleApiKey, tailnet: tailscaleTailnet }; }
    return null;
  };

  const save = async () => {
    const config = buildConfig();
    if (!name || !config) return;
    setLoading(true);
    await onSave({ name, type: config.type, room: room || undefined, config, requiredPermissions: perms });
    setLoading(false);
  };

  const togglePerm = (p: PermissionFlag) =>
    setPerms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);

  return (
    <div className="space-y-4">
      {configLoading && (
        <div className={`flex items-center gap-2 text-sm ${t.muted}`}>
          <Spinner size={14} /> Konfiguration wird geladen…
        </div>
      )}
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
      {type === 'tasmota' && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.100" t={t} accent={accent} />
          <Input label="Anzahl Kanäle" value={tasmotaChannels} onChange={setTasmotaChannels} placeholder="1" t={t} accent={accent} hint="1 = Einzel-Plug, 4 = Mehrfachstecker" />
        </div>
      )}
      {type === 'docker' && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="IP-Adresse" value={ip} onChange={setIp} placeholder="192.168.1.10" t={t} accent={accent} />
          <Input label="Port (opt.)" value={dockerPort} onChange={setDockerPort} placeholder="2375" t={t} accent={accent} hint="Docker TCP API aktivieren: dockerd -H tcp://0.0.0.0:2375" />
        </div>
      )}
      {type === 'tailscale' && (
        <div className="space-y-3">
          <Input label="API Key" value={tailscaleApiKey} onChange={setTailscaleApiKey} placeholder="tskey-api-..." t={t} accent={accent} hint="Erstelle unter tailscale.com/admin/settings/keys" />
          <Input label="Tailnet" value={tailscaleTailnet} onChange={setTailscaleTailnet} placeholder="deine-organisation.ts.net" t={t} accent={accent} />
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
          disabled={!name || (type === 'wol' && !mac) || (type === 'tailscale' && (!tailscaleApiKey || !tailscaleTailnet)) || (!ip && !['wol','tailscale'].includes(type))}>
          Speichern
        </Btn>
        <Btn accent={accent} variant="secondary" onClick={onCancel}>Abbrechen</Btn>
      </div>
    </div>
  );
}

// ── Widget Form (add widget) ──────────────────────────────────────────────────

const WIDGET_TYPE_OPTIONS = [
  { value: 'clock',               label: '🕐 Uhr' },
  { value: 'weather',             label: '🌤 Wetter' },
  { value: 'device_toggle',       label: '🔌 Gerät schalten' },
  { value: 'wol_button',          label: '⚡ Wake-on-LAN' },
  { value: 'proxmox_vms',         label: '🖥  Proxmox VMs' },
  { value: 'energy',              label: '⚡ Energie (Tasmota)' },
  { value: 'docker_containers',   label: '🐳 Docker Container' },
  { value: 'tailscale_peers',     label: '🔒 Tailscale Peers' },
  { value: 'monitor',             label: '📡 Service Monitor' },
  { value: 'note',                label: '📝 Notiz' },
];

const WIDGET_DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  clock: { w: 4, h: 2 }, weather: { w: 4, h: 2 }, device_toggle: { w: 3, h: 2 },
  wol_button: { w: 3, h: 2 }, proxmox_vms: { w: 6, h: 3 }, note: { w: 4, h: 2 },
  energy: { w: 4, h: 2 }, docker_containers: { w: 6, h: 3 },
  tailscale_peers: { w: 5, h: 3 }, monitor: { w: 6, h: 3 },
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
    if (wtype === 'energy') { if (!deviceId) return null; return { type: 'energy', deviceId }; }
    if (wtype === 'docker_containers') { if (!deviceId) return null; return { type: 'docker_containers', deviceId }; }
    if (wtype === 'tailscale_peers') { if (!deviceId) return null; return { type: 'tailscale_peers', deviceId }; }
    if (wtype === 'monitor') return { type: 'monitor' };
    return null;
  };

  const save = async () => {
    const config = buildConfig();
    if (!config) return;
    setLoading(true);
    await onSave({ layout: { col: 1, row: 1, w: def.w, h: def.h }, config });
    setLoading(false);
  };

  const deviceOptions = devices.map((d) => ({ value: d.id, label: `${deviceTypeIcon(d.type)} ${d.name}${d.room ? ` (${d.room})` : ''}` }));

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
                options={deviceOptions.filter((d) => devices.find((dev) => dev.id === d.value)?.type === 'wol')}
                t={t} accent={accent} />
            : <p className={`text-sm ${t.muted}`}>Kein WOL-Gerät vorhanden.</p>}
          <Input label="Beschriftung (opt.)" value={wolLabel} onChange={setWolLabel} placeholder="Server aufwecken" t={t} accent={accent} />
        </div>
      )}
      {(wtype === 'energy') && (
        <Select label="Tasmota-Gerät" value={deviceId} onChange={setDeviceId}
          options={deviceOptions.filter((d) => devices.find((dev) => dev.id === d.value)?.type === 'tasmota')}
          t={t} accent={accent} />
      )}
      {wtype === 'docker_containers' && (
        <Select label="Docker-Host" value={deviceId} onChange={setDeviceId}
          options={deviceOptions.filter((d) => devices.find((dev) => dev.id === d.value)?.type === 'docker')}
          t={t} accent={accent} />
      )}
      {wtype === 'tailscale_peers' && (
        <Select label="Tailscale-Konfiguration" value={deviceId} onChange={setDeviceId}
          options={deviceOptions.filter((d) => devices.find((dev) => dev.id === d.value)?.type === 'tailscale')}
          t={t} accent={accent} />
      )}
      {wtype === 'monitor' && (
        <p className={`text-sm ${t.muted}`}>Zeigt den Status aller erreichbaren Geräte.</p>
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
        <span className="text-2xl">{device.icon ?? deviceTypeIcon(device.type)}</span>
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

function EnergyWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'energy' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!device) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'energy' }),
      });
      if (r.ok) setData(await r.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { void load(); }, [config.deviceId]);

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;
  const sns = data?.StatusSNS?.ENERGY;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className={`text-sm font-medium ${t.text}`}>{device.name}</p>
        <button onClick={() => void load()} className={`text-xs ${t.muted} opacity-60 hover:opacity-100`}>↻</button>
      </div>
      {loading && <div className="flex flex-1 items-center justify-center"><Spinner size={18} color={accent} /></div>}
      {sns ? (
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'Leistung', val: `${sns.Power ?? '—'} W` },
            { label: 'Spannung', val: `${sns.Voltage ?? '—'} V` },
            { label: 'Strom',    val: `${sns.Current ?? '—'} A` },
            { label: 'Gesamt',   val: `${sns.Today ?? '—'} kWh` },
          ].map(({ label, val }) => (
            <div key={label} className={`rounded-xl p-2.5 ${t.inputBg}`}>
              <p className={`text-[10px] ${t.muted}`}>{label}</p>
              <p className="text-sm font-semibold tabular-nums" style={{ color: accent }}>{val}</p>
            </div>
          ))}
        </div>
      ) : !loading && (
        <p className={`text-xs ${t.muted}`}>Keine Energiedaten</p>
      )}
    </div>
  );
}

function DockerWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'docker_containers' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [containers, setContainers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    if (!device) return;
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'list_containers' }),
      });
      if (!r.ok) { setErr('Docker API Fehler'); } else { setContainers(await r.json()); }
    } catch { setErr('Netzwerkfehler'); }
    setLoading(false);
  };

  const containerAction = async (id: string, action: string) => {
    if (!device) return;
    setActing(id);
    await fetch(`/api/devices/${device.id}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'container_ctrl', containerId: id, containerAction: action }),
    });
    setTimeout(() => { void load(); setActing(null); }, 800);
  };

  useEffect(() => { void load(); }, [config.deviceId]);

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className={`text-sm font-medium ${t.text}`}>{device.name}</p>
        <button onClick={() => void load()} className={`text-xs ${t.muted} opacity-60 hover:opacity-100`}>↻</button>
      </div>
      {loading && <div className="flex flex-1 items-center justify-center"><Spinner size={18} color={accent} /></div>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex flex-col gap-1 overflow-auto">
        {containers.map((c) => {
          const running = c.State === 'running';
          const name = (c.Names?.[0] ?? c.Id?.slice(0, 12) ?? '?').replace(/^\//, '');
          return (
            <div key={c.Id} className={`flex items-center justify-between rounded-lg px-2.5 py-2 ${t.inputBg}`}>
              <div className="flex items-center gap-2 min-w-0">
                <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${running ? 'bg-green-500' : 'bg-red-500/70'}`} />
                <div className="min-w-0">
                  <p className={`text-xs font-medium truncate ${t.text}`}>{name}</p>
                  <p className={`text-[10px] truncate ${t.muted}`}>{c.Image?.split(':')[0]}</p>
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {running ? (
                  <button onClick={() => containerAction(c.Id, 'stop')} disabled={acting === c.Id}
                    className={`rounded-lg px-2 py-1 text-[10px] font-medium transition-all text-red-400 ${t.inputBg} hover:bg-red-500/20`}>
                    {acting === c.Id ? '…' : 'Stop'}
                  </button>
                ) : (
                  <button onClick={() => containerAction(c.Id, 'start')} disabled={acting === c.Id}
                    className={`rounded-lg px-2 py-1 text-[10px] font-medium transition-all ${t.inputBg}`}
                    style={{ color: accent }}>
                    {acting === c.Id ? '…' : 'Start'}
                  </button>
                )}
                <button onClick={() => containerAction(c.Id, 'restart')} disabled={acting === c.Id}
                  className={`rounded-lg px-2 py-1 text-[10px] ${t.muted} ${t.inputBg} hover:opacity-100 opacity-60`}>↺</button>
              </div>
            </div>
          );
        })}
        {!loading && containers.length === 0 && !err && (
          <p className={`text-xs ${t.muted}`}>Keine Container gefunden</p>
        )}
      </div>
    </div>
  );
}

function TailscaleWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'tailscale_peers' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [peers, setPeers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    if (!device) return;
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'list_devices' }),
      });
      if (!r.ok) { setErr('Tailscale API Fehler'); }
      else {
        const data = await r.json() as any;
        setPeers((data.devices ?? []).slice(0, 12));
      }
    } catch { setErr('Netzwerkfehler'); }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [config.deviceId]);

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className={`text-sm font-medium ${t.text}`}>Tailscale Peers</p>
        <button onClick={() => void load()} className={`text-xs ${t.muted} opacity-60 hover:opacity-100`}>↻</button>
      </div>
      {loading && <div className="flex flex-1 items-center justify-center"><Spinner size={18} color={accent} /></div>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex flex-col gap-1 overflow-auto">
        {peers.map((p) => {
          const lastSeen = p.lastSeen ? new Date(p.lastSeen) : null;
          const minsAgo = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 60_000) : null;
          const online = minsAgo !== null && minsAgo < 5;
          return (
            <div key={p.id} className={`flex items-center justify-between rounded-lg px-2.5 py-2 ${t.inputBg}`}>
              <div className="flex items-center gap-2 min-w-0">
                <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${online ? 'bg-green-500' : 'bg-yellow-500/70'}`} />
                <div className="min-w-0">
                  <p className={`text-xs font-medium truncate ${t.text}`}>{p.hostname ?? p.name}</p>
                  <p className={`text-[10px] ${t.muted}`}>{(p.addresses ?? [])[0] ?? '—'}</p>
                </div>
              </div>
              <span className={`text-[10px] ${t.muted} flex-shrink-0`}>
                {online ? 'online' : minsAgo !== null ? `${minsAgo}m` : '—'}
              </span>
            </div>
          );
        })}
        {!loading && peers.length === 0 && !err && <p className={`text-xs ${t.muted}`}>Keine Peers</p>}
      </div>
    </div>
  );
}

function MonitorWidget({ devices, t, accent, statuses }: {
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
  statuses: Record<string, MonitorStatus>;
}) {
  const monitorable = devices.filter((d) => d.type !== 'wol' && d.type !== 'tailscale');

  return (
    <div className="flex h-full flex-col gap-2">
      <p className={`text-sm font-medium ${t.text}`}>Service Monitor</p>
      <div className="flex flex-col gap-1 overflow-auto">
        {monitorable.length === 0 && <p className={`text-xs ${t.muted}`}>Keine überwachbaren Geräte</p>}
        {monitorable.map((d) => {
          const s = statuses[d.id];
          const online = s?.online;
          const checked = s?.lastCheck;
          return (
            <div key={d.id} className={`flex items-center justify-between rounded-lg px-2.5 py-2 ${t.inputBg}`}>
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full flex-shrink-0 ${
                  !s ? 'bg-white/20' : online ? 'bg-green-500' : 'bg-red-500'
                }`} />
                <div>
                  <p className={`text-xs font-medium ${t.text}`}>{d.name}</p>
                  {d.room && <p className={`text-[10px] ${t.muted}`}>{d.room}</p>}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                {s?.latencyMs != null && (
                  <p className="text-xs tabular-nums" style={{ color: accent }}>{s.latencyMs}ms</p>
                )}
                <p className={`text-[10px] ${t.muted}`}>
                  {!s ? 'ausstehend' : online ? 'online' : 'offline'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Enhanced Proxmox widget with VM controls
function ProxmoxVmsWidget({ config, devices, t, accent }: {
  config: Extract<WidgetConfig, { type: 'proxmox_vms' }>;
  devices: Device[]; t: ReturnType<typeof tok>; accent: string;
}) {
  const device = devices.find((d) => d.id === config.deviceId);
  const [vms, setVms] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    if (!device) return;
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/devices/${device.id}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'list_vms' }),
      });
      if (!r.ok) { setErr('Proxmox API Fehler'); }
      else { setVms((await r.json() as any).data ?? []); }
    } catch { setErr('Netzwerkfehler'); }
    setLoading(false);
  };

  const vmAction = async (vmid: string, vmAct: string) => {
    if (!device) return;
    setActing(vmid);
    await fetch(`/api/devices/${device.id}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'vm_ctrl', vmId: vmid, vmAction: vmAct }),
    });
    setTimeout(() => { void load(); setActing(null); }, 1200);
  };

  useEffect(() => { void load(); }, [config.deviceId]);

  if (!device) return <p className={`text-xs ${t.muted}`}>Gerät nicht gefunden</p>;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className={`text-sm font-medium ${t.text}`}>{device.name}</p>
        <button onClick={() => void load()} className={`text-xs ${t.muted} opacity-60 hover:opacity-100`}>↻</button>
      </div>
      {loading && <div className="flex flex-1 items-center justify-center"><Spinner size={18} color={accent} /></div>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex flex-col gap-1.5 overflow-auto">
        {vms.map((vm) => {
          const running = vm.status === 'running';
          const cpu = vm.cpu ? `${(vm.cpu * 100).toFixed(1)}%` : null;
          const mem = vm.mem && vm.maxmem ? `${Math.round((vm.mem / vm.maxmem) * 100)}%` : null;
          return (
            <div key={vm.vmid} className={`rounded-xl border p-2.5 ${t.border}`}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <div className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-green-500' : 'bg-red-500/60'}`} />
                  <p className={`text-xs font-medium ${t.text}`}>{vm.name ?? `VM ${vm.vmid}`}</p>
                  <span className={`text-[10px] ${t.muted}`}>#{vm.vmid}</span>
                </div>
                <div className="flex gap-1">
                  {running ? (
                    <>
                      <button onClick={() => vmAction(vm.vmid, 'shutdown')} disabled={acting === vm.vmid}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 ${t.inputBg} hover:bg-red-500/20`}>
                        {acting === vm.vmid ? '…' : 'Stop'}
                      </button>
                      <button onClick={() => vmAction(vm.vmid, 'reboot')} disabled={acting === vm.vmid}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${t.muted} ${t.inputBg} hover:opacity-100 opacity-70`}>↺</button>
                    </>
                  ) : (
                    <button onClick={() => vmAction(vm.vmid, 'start')} disabled={acting === vm.vmid}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${t.inputBg}`} style={{ color: accent }}>
                      {acting === vm.vmid ? '…' : 'Start'}
                    </button>
                  )}
                </div>
              </div>
              {(cpu || mem) && (
                <div className="flex gap-3">
                  {cpu && <div className="flex items-center gap-1"><span className={`text-[10px] ${t.muted}`}>CPU</span><span className="text-[10px] tabular-nums" style={{ color: accent }}>{cpu}</span></div>}
                  {mem && <div className="flex items-center gap-1"><span className={`text-[10px] ${t.muted}`}>RAM</span><span className="text-[10px] tabular-nums" style={{ color: accent }}>{mem}</span></div>}
                </div>
              )}
            </div>
          );
        })}
        {!loading && vms.length === 0 && !err && <p className={`text-xs ${t.muted}`}>Keine VMs gefunden</p>}
      </div>
    </div>
  );
}

function WidgetRenderer({ widget, devices, t, accent, onRemove, statuses = {} }: {
  widget: Widget; devices: Device[];
  t: ReturnType<typeof tok>; accent: string;
  onRemove?: () => void;
  statuses?: Record<string, MonitorStatus>;
}) {
  const c = widget.config;
  return (
    <div className={`group relative h-full rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-px ${t.inputBg} ${t.border}`}
      style={panelStyle(accent, t)}>
      {onRemove && (
        <button onClick={onRemove}
          className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-full bg-red-500/80 text-white text-xs group-hover:flex z-10">
          ×
        </button>
      )}
      {c.type === 'clock'              && <ClockWidget config={c} t={t} accent={accent} />}
      {c.type === 'weather'            && <WeatherWidget config={c} t={t} accent={accent} />}
      {c.type === 'device_toggle'      && <DeviceToggleWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'wol_button'         && <WolButtonWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'proxmox_vms'        && <ProxmoxVmsWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'note'               && <NoteWidget config={c} t={t} />}
      {c.type === 'energy'             && <EnergyWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'docker_containers'  && <DockerWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'tailscale_peers'    && <TailscaleWidget config={c} devices={devices} t={t} accent={accent} />}
      {c.type === 'monitor'            && <MonitorWidget devices={devices} t={t} accent={accent} statuses={statuses} />}
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

// ── Auth pages ───────────────────────────────────────────────

function AuthPage({ title, sub, children, accent, t }: {
  title: string; sub: string; children: React.ReactNode;
  accent: string; t: ReturnType<typeof tok>;
}) {
  return (
    <div className={`min-h-screen ${t.page} flex flex-col items-center justify-center p-6 relative overflow-hidden`}
      style={{ '--accent-ring': `${accent}45` } as React.CSSProperties}>

      {/* Ambient radial glow */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: `radial-gradient(ellipse 90% 55% at 50% -5%, ${accent}22 0%, transparent 65%)`,
      }} />
      <div style={{
        position: 'fixed', bottom: '-20%', left: '50%', transform: 'translateX(-50%)',
        width: '60%', height: '40%', pointerEvents: 'none', zIndex: 0,
        background: `radial-gradient(ellipse at center, ${accent}10 0%, transparent 70%)`,
        filter: 'blur(40px)',
      }} />

      {/* Logo + title */}
      <div className="relative z-10 mb-8 flex flex-col items-center animate-spring-in">
        <div className="mb-5 flex items-center justify-center w-[76px] h-[76px] rounded-[22px]"
          style={{
            background: `linear-gradient(145deg, ${accent}EE 0%, ${accent}BB 100%)`,
            boxShadow: `0 8px 32px ${accent}55, 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25)`,
          }}>
          <img src="/logo.svg" alt="Logo" className="w-[44px] h-[44px]" />
        </div>
        <h1 className={`text-[28px] font-semibold tracking-[-0.5px] ${t.text}`}>{title}</h1>
        <p className={`mt-1 text-[15px] ${t.muted}`}>{sub}</p>
      </div>

      {/* Card */}
      <div className="relative z-10 w-full max-w-[360px] animate-spring-in delay-2">
        <div className={`rounded-[24px] border backdrop-blur-2xl px-7 py-7 ${t.card} ${t.border}`}
          style={{
            boxShadow: `0 20px 60px rgba(0,0,0,0.35), 0 4px 12px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08)`,
            borderColor: `${accent}20`,
          }}>
          {children}
        </div>
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
      <div className="space-y-3">
        <input
          type="email" value={email} autoFocus
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && signIn()}
          placeholder="E-Mail Adresse"
          className={`focus-accent w-full rounded-[14px] px-4 py-3.5 text-[15px] outline-none transition-all ${t.inputBg} ${t.inputText}`}
          style={{ '--accent-ring': `${accent}45` } as React.CSSProperties}
        />
        <StatusMsg msg={status} t={t} />
        <button
          onClick={signIn}
          disabled={!email.includes('@') || loading}
          className="w-full flex items-center justify-center gap-2.5 rounded-[16px] py-[14px] text-[15px] font-semibold text-white transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
          style={{ backgroundColor: accent, boxShadow: `0 4px 20px ${accent}60, 0 1px 4px ${accent}40` }}>
          {loading ? <Spinner size={18} color="white" /> : (
            <>
              <FaceIDIcon size={20} />
              Mit Passkey anmelden
            </>
          )}
        </button>
        <p className={`text-center text-[12px] pt-1 ${t.muted}`}>
          Touch ID · Face ID · Sicherheitsschlüssel
        </p>
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
            <p className={`font-semibold ${t.text}`}>Passkey erstellt</p>
            <p className={`mt-1 text-[13px] ${t.muted}`}>Du kannst dich jetzt anmelden.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Input label="E-Mail" value={email} onChange={setEmail} t={t} accent={accent} />
          <StatusMsg msg={status} t={t} />
          <button
            onClick={register}
            disabled={!email.includes('@') || loading}
            className="w-full flex items-center justify-center gap-2.5 rounded-[16px] py-[14px] text-[15px] font-semibold text-white transition-all duration-150 active:scale-[0.97] disabled:opacity-40"
            style={{ backgroundColor: accent, boxShadow: `0 4px 20px ${accent}60` }}>
            {loading ? <Spinner size={18} color="white" /> : 'Passkey erstellen'}
          </button>
        </div>
      )}
    </AuthPage>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

type Tab = 'home' | 'devices' | 'discovery' | 'admin' | 'settings';

const ADMIN_ONLY_TABS: Tab[] = ['admin', 'discovery'];

const NAV: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'home',      label: 'Home',      icon: <IcHome /> },
  { key: 'devices',   label: 'Geräte',   icon: <IcGrid /> },
  { key: 'discovery', label: 'Discovery', icon: <IcRadar /> },
  { key: 'admin',     label: 'Admin',     icon: <IcPerson /> },
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
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [discoverConfigured, setDiscoverConfigured] = useState(true);
  const [prefill, setPrefill] = useState<Partial<Device> | null>(null);

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

  // Ask the Pi Agent to scan the LAN, then load the results.
  const runDiscovery = async () => {
    setDiscovering(true);
    setDevStatus('');
    try {
      const start = await fetch('/api/pi-agent/discover', { method: 'POST', credentials: 'include' });
      if (start.status === 400) { setDiscoverConfigured(false); setDevStatus('✗ Kein Pi Agent konfiguriert'); return; }
      // The scan runs in the background on the Pi — give it a few seconds, then pull results
      await new Promise((r) => setTimeout(r, 6000));
      await loadDiscovered();
    } catch {
      setDevStatus('✗ Pi Agent nicht erreichbar');
    } finally {
      setDiscovering(false);
    }
  };

  const loadDiscovered = async () => {
    const r = await fetch('/api/pi-agent/discovered', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json() as { devices: DiscoveredDevice[]; configured: boolean };
    setDiscoverConfigured(d.configured);
    // Hide devices already configured (match by — best effort — type+hostname)
    setDiscovered(d.devices ?? []);
  };

  // Pre-fill the device form from a discovered entry
  const addDiscovered = (dd: DiscoveredDevice) => {
    const type = dd.type === 'unknown' ? 'http' : dd.type;
    setPrefill({
      name: dd.hostname || `${type} ${dd.ip}`,
      type,
      config: { type, ip: dd.ip } as DeviceConfig,
    });
    setShowDeviceForm(true);
    setEditDevice(null);
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
              <div className="flex gap-2">
                <Btn accent={accent} variant="secondary" size="sm" onClick={runDiscovery} loading={discovering}>
                  🔍 Geräte suchen
                </Btn>
                <Btn accent={accent} size="sm" onClick={() => { setPrefill(null); setShowDeviceForm(true); }}>+ Gerät</Btn>
              </div>
            )}
          </div>

          {devStatus && <StatusMsg msg={devStatus} t={t} />}

          {/* Discovery results */}
          {discovered.length > 0 && !showDeviceForm && !editDevice && (
            <div className={`rounded-xl border p-3 space-y-2 ${t.border}`} style={{ borderColor: `${accent}25`, backgroundColor: `${accent}06` }}>
              <p className={`text-xs font-medium ${t.muted}`}>{discovered.length} Gerät(e) im Netzwerk gefunden</p>
              {discovered.map((dd, i) => (
                <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-2 ${t.inputBg}`}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-lg flex-shrink-0">{deviceTypeIcon(dd.type === 'unknown' ? 'http' : dd.type)}</span>
                    <div className="min-w-0">
                      <p className={`text-sm truncate ${t.text}`}>{dd.hostname || dd.ip}</p>
                      <p className={`text-xs ${t.muted}`}>
                        {dd.ip}{dd.mac ? ` · ${dd.mac}` : ''} · {dd.type === 'unknown' ? 'unbekannt' : dd.type} · {dd.via}
                      </p>
                    </div>
                  </div>
                  <Btn accent={accent} size="sm" onClick={() => addDiscovered(dd)}>+ Hinzufügen</Btn>
                </div>
              ))}
            </div>
          )}
          {!discoverConfigured && (
            <p className={`text-xs ${t.muted}`}>Geräte-Suche benötigt einen konfigurierten Pi Agent (PI_AGENT_URL).</p>
          )}

          {(showDeviceForm || editDevice) && (
            <div className={`rounded-xl border p-4 ${t.border}`} style={{ borderColor: `${accent}25` }}>
              <p className={`mb-4 text-sm font-medium ${t.text}`}>{editDevice ? 'Gerät bearbeiten' : 'Neues Gerät'}</p>
              <DeviceForm
                initial={editDevice ?? prefill ?? undefined}
                onSave={async (data) => { await saveDevice(data); setPrefill(null); }}
                onCancel={() => { setShowDeviceForm(false); setEditDevice(null); setPrefill(null); setDevStatus(''); }}
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
                  <span className="text-xl">{d.icon ?? deviceTypeIcon(d.type)}</span>
                  <div>
                    <p className={`text-sm font-medium ${t.text}`}>{d.name}</p>
                    <p className={`text-xs ${t.muted}`}>{d.room ? `${d.room} · ` : ''}{DEVICE_TYPE_OPTIONS.find((o) => o.value === d.type)?.label.replace(/^\S+\s/, '') ?? d.type}</p>
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

function DevicesTab({ devices, t, accent, statuses }: { devices: Device[]; t: ReturnType<typeof tok>; accent: string; statuses: Record<string, MonitorStatus> }) {
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
        <h1 className={`text-[22px] font-semibold tracking-[-0.4px] ${t.text}`}>Geräte</h1>
        <p className={`mt-1 text-[14px] ${t.muted}`}>Verbundene Geräte und Steuerung.</p>
        <div className={`mt-6 rounded-[18px] border border-dashed p-16 text-center ${t.border}`}
          style={{ borderColor: `${accent}25` }}>
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[18px]"
            style={{ backgroundColor: `${accent}15` }}>
            <IcGrid size={24} />
          </div>
          <p className={`font-semibold ${t.text}`}>Noch keine Geräte</p>
          <p className={`mt-1 text-[13px] ${t.muted}`}>Geräte können in den Einstellungen hinzugefügt werden.</p>
        </div>
      </div>
    );
  }

  const rooms = [...new Set(devices.map((d) => d.room ?? 'Allgemein'))];

  return (
    <div className="animate-slide-right space-y-6">
      <div>
        <h1 className={`text-[22px] font-semibold tracking-[-0.4px] ${t.text}`}>Geräte</h1>
        <p className={`text-[14px] ${t.muted}`}>{devices.length} Gerät{devices.length !== 1 ? 'e' : ''} konfiguriert</p>
      </div>

      {rooms.map((room) => (
        <div key={room}>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: `${accent}CC` }}>{room}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {devices.filter((d) => (d.room ?? 'Allgemein') === room).map((device, i) => {
              const st = statuses[device.id];
              return (
                <div key={device.id}
                  className={`group rounded-[18px] border p-4 transition-all duration-200
                    hover:shadow-lg hover:-translate-y-0.5 animate-float-in ${t.border} ${t.inputBg} delay-${Math.min(i, 6)}`}
                  style={{ borderColor: `${accent}18` }}>

                  {/* Header row */}
                  <div className="flex items-start justify-between mb-4">
                    {/* Icon circle */}
                    <div className="flex h-11 w-11 items-center justify-center rounded-[14px] text-xl shrink-0"
                      style={{
                        background: `linear-gradient(145deg, ${accent}25 0%, ${accent}15 100%)`,
                        boxShadow: `inset 0 1px 0 ${accent}30`,
                      }}>
                      {device.icon ?? deviceTypeIcon(device.type)}
                    </div>

                    {/* Status pill */}
                    {st && (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        st.online ? 'text-[#30D158]' : 'text-[#FF3B30]'
                      }`} style={{ backgroundColor: st.online ? '#30D15820' : '#FF3B3020' }}>
                        <span className={`h-1.5 w-1.5 rounded-full ${st.online ? 'bg-[#30D158]' : 'bg-[#FF3B30]'}`}
                          style={st.online ? { animation: 'statusPulse 2s ease-in-out infinite' } : {}} />
                        {st.online ? (st.latencyMs != null ? `${st.latencyMs}ms` : 'online') : 'offline'}
                      </span>
                    )}
                  </div>

                  {/* Name + type */}
                  <div className="mb-3">
                    <p className={`text-[14px] font-semibold leading-snug ${t.text}`}>{device.name}</p>
                    <p className={`text-[12px] ${t.muted}`}>{DEVICE_TYPE_OPTIONS.find((o) => o.value === device.type)?.label.replace(/^\S+\s/, '')}</p>
                  </div>

                  {/* Action feedback */}
                  {actionStatus[device.id] && (
                    <p className={`text-[12px] mb-2 font-medium ${actionStatus[device.id].startsWith('✗') ? 'text-[#FF3B30]' : 'text-[#30D158]'}`}>
                      {actionStatus[device.id]}
                    </p>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap gap-1.5">
                    {(device.type === 'shelly_plug' || device.type === 'shelly_light') && (
                      <>
                        <Btn accent={accent} size="sm" onClick={() => doAction(device, 'on')}>Ein</Btn>
                        <Btn accent={accent} variant="secondary" size="sm" onClick={() => doAction(device, 'off')}>Aus</Btn>
                        <Btn accent={accent} variant="ghost" size="sm" onClick={() => doAction(device, 'status')}>Status</Btn>
                      </>
                    )}
                    {device.type === 'wol' && (
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'wake')}>⚡ Aufwecken</Btn>
                    )}
                    {device.type === 'proxmox' && (
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'list_vms')}>VMs laden</Btn>
                    )}
                    {(device.type === 'rdp' || device.type === 'ssh') && (
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'connect')}>🔗 Verbinden</Btn>
                    )}
                    {device.type === 'http' && (
                      <>
                        <Btn accent={accent} size="sm" onClick={() => doAction(device, 'on')}>Ein</Btn>
                        <Btn accent={accent} variant="secondary" size="sm" onClick={() => doAction(device, 'off')}>Aus</Btn>
                      </>
                    )}
                    {device.type === 'tasmota' && (
                      <>
                        <Btn accent={accent} size="sm" onClick={() => doAction(device, 'on')}>Ein</Btn>
                        <Btn accent={accent} variant="secondary" size="sm" onClick={() => doAction(device, 'off')}>Aus</Btn>
                        <Btn accent={accent} variant="ghost" size="sm" onClick={() => doAction(device, 'energy')}>⚡ Energie</Btn>
                      </>
                    )}
                    {device.type === 'docker' && (
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'list_containers')}>Container laden</Btn>
                    )}
                    {device.type === 'tailscale' && (
                      <Btn accent={accent} size="sm" onClick={() => doAction(device, 'list_devices')}>Peers laden</Btn>
                    )}
                  </div>
                </div>
              );
            })}
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
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditConfigured, setAuditConfigured] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => { void loadUsers(); void loadAudit(); }, []);

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const r = await fetch('/api/admin/audit?limit=100', { credentials: 'include' });
      if (r.ok) {
        const d = await r.json() as { entries: AuditEntry[]; configured?: boolean };
        setAudit(d.entries ?? []);
        setAuditConfigured(d.configured !== false);
      }
    } finally {
      setAuditLoading(false);
    }
  };

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

      {/* Activity log (from Pi Agent) */}
      <section className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className={`font-semibold ${t.text}`}>Aktivitätsprotokoll</h2>
            <p className={`mt-0.5 text-sm ${t.muted}`}>Interne Vorgänge auf dem Pi Agent (Geräteaktionen, Konfig-Änderungen, Hosts).</p>
          </div>
          <Btn accent={accent} variant="secondary" size="sm" onClick={loadAudit} loading={auditLoading}>↻ Aktualisieren</Btn>
        </div>

        {!auditConfigured ? (
          <p className={`text-sm ${t.muted}`}>Kein Pi Agent konfiguriert — im lokalen Modus wird kein internes Protokoll geführt.</p>
        ) : audit.length === 0 ? (
          <p className={`text-sm ${t.muted}`}>Noch keine Einträge.</p>
        ) : (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {audit.map((e, i) => (
              <div key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-xs ${t.navHover}`}>
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${e.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className={`flex-shrink-0 font-mono ${t.muted}`}>{new Date(e.ts).toLocaleTimeString('de-DE')}</span>
                <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-medium" style={{ backgroundColor: `${accent}15`, color: accent }}>{auditKindLabel(e.kind)}</span>
                <span className={`min-w-0 flex-1 truncate ${t.text}`}>
                  {[e.action, e.deviceType, e.target].filter(Boolean).join(' · ')}
                  {e.message ? ` — ${e.message}` : ''}
                </span>
                {e.actor && <span className={`flex-shrink-0 ${t.muted}`}>{e.actor.split('@')[0]}</span>}
                {typeof e.latencyMs === 'number' && <span className={`flex-shrink-0 font-mono ${t.muted}`}>{e.latencyMs}ms</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const auditKindLabel = (k: AuditEntry['kind']): string => ({
  action: 'Aktion',
  config_create: 'Gerät +',
  config_update: 'Gerät ✎',
  config_delete: 'Gerät ×',
  agent_register: 'Host',
  agent_ip_change: 'IP-Wechsel',
  discovery: 'Scan',
  auth_fail: 'Auth ✗',
}[k] ?? k);

// ── Discovery tab (admin only) ──────────────────────────────────────────────────

type HostAgentInfo = {
  id: string; hostname: string; ip: string; tailscaleIp?: string;
  services: string[]; registeredAt: number; lastSeen: number; online: boolean;
};

function DiscoveryTab({ devices, setDevices, t, accent }: {
  devices: Device[]; setDevices: (d: Device[]) => void;
  t: ReturnType<typeof tok>; accent: string;
}) {
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [agents, setAgents] = useState<HostAgentInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [lastScan, setLastScan] = useState<number | null>(null);

  useEffect(() => { void load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/pi-agent/discovered', { credentials: 'include' });
      if (r.ok) {
        const d = await r.json() as { devices: DiscoveredDevice[]; agents: HostAgentInfo[]; configured: boolean };
        setDiscovered(d.devices ?? []);
        setAgents(d.agents ?? []);
        setConfigured(d.configured);
      }
    } finally {
      setLoading(false);
    }
  };

  const scan = async () => {
    setScanning(true); setStatus('');
    try {
      const r = await fetch('/api/pi-agent/discover', { method: 'POST', credentials: 'include' });
      if (r.status === 400) { setConfigured(false); return; }
      await new Promise((res) => setTimeout(res, 6000)); // Pi scans in the background
      await load();
      setLastScan(Date.now());
    } catch {
      setStatus('✗ Pi Agent nicht erreichbar');
    } finally {
      setScanning(false);
    }
  };

  // A discovered device counts as "known" if we already have a device of the same
  // type whose stored hostname/name matches — best effort, since IPs live on the Pi.
  const isKnown = (dd: DiscoveredDevice) =>
    devices.some((d) => d.type === dd.type && (d.name === dd.hostname || d.name.includes(dd.ip)));

  const addDiscovered = async (dd: DiscoveredDevice) => {
    const type = dd.type === 'unknown' ? 'http' : dd.type;
    const suggested = deviceTypePermission(type);
    const config = type === 'http'
      ? { type, ip: dd.ip, onPath: '/' }
      : { type, ip: dd.ip };
    const r = await fetch('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        name: dd.hostname || `${type} ${dd.ip}`,
        type, config,
        requiredPermissions: suggested ? [suggested] : [],
      }),
    });
    if (r.ok) {
      const { device } = await r.json() as { device: Device };
      setDevices([...devices, device]);
      setStatus(`✓ ${device.name} hinzugefügt${(type === 'proxmox' || type === 'docker') ? ' — Zugangsdaten in Einstellungen ergänzen' : ''}`);
    } else {
      setStatus(`✗ ${await readErr(r, 'Konnte Gerät nicht hinzufügen')}`);
    }
    setTimeout(() => setStatus(''), 4000);
  };

  return (
    <div className="animate-slide-right space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className={`text-xl font-semibold ${t.text}`}>Discovery</h1>
          <p className={`text-sm ${t.muted}`}>Im Heimnetz gefundene Geräte und registrierte Host-Agents.</p>
        </div>
        <Btn accent={accent} onClick={scan} loading={scanning}>🔍 Netzwerk scannen</Btn>
      </div>

      {status && <StatusMsg msg={status} t={t} />}

      {!configured ? (
        <div className={`rounded-2xl border p-12 text-center ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
          <p className="text-4xl mb-3">◎</p>
          <p className={`font-medium ${t.text}`}>Kein Pi Agent konfiguriert</p>
          <p className={`mt-1 text-sm ${t.muted}`}>Setze <code>PI_AGENT_URL</code> in der Dashboard-Konfiguration, um Discovery zu nutzen.</p>
        </div>
      ) : (
        <>
          {/* Discovered devices */}
          <section className={`rounded-2xl border p-5 space-y-3 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
            <div className="flex items-center justify-between">
              <h2 className={`font-semibold ${t.text}`}>Gefundene Geräte</h2>
              <span className={`text-xs ${t.muted}`}>
                {lastScan ? `Zuletzt gescannt: ${new Date(lastScan).toLocaleTimeString('de-DE')}` : `${discovered.length} bekannt`}
              </span>
            </div>
            {loading ? (
              <Spinner size={20} color={accent} />
            ) : discovered.length === 0 ? (
              <p className={`text-sm ${t.muted}`}>Noch nichts gefunden. Starte einen Scan — der Pi durchsucht ARP-Tabelle und mDNS.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {discovered.map((dd, i) => {
                  const known = isKnown(dd);
                  return (
                    <div key={i} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${t.border}`}
                      style={{ borderColor: `${accent}18` }}>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xl flex-shrink-0">{deviceTypeIcon(dd.type === 'unknown' ? 'http' : dd.type)}</span>
                        <div className="min-w-0">
                          <p className={`text-sm font-medium truncate ${t.text}`}>{dd.hostname || dd.ip}</p>
                          <p className={`text-xs ${t.muted}`}>
                            {dd.ip}{dd.mac ? ` · ${dd.mac}` : ''} · {dd.type === 'unknown' ? 'unbekannt' : dd.type}
                            <span className="ml-1 opacity-60">({dd.via})</span>
                          </p>
                        </div>
                      </div>
                      {known
                        ? <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-500/15 text-green-500`}>konfiguriert</span>
                        : <Btn accent={accent} size="sm" onClick={() => addDiscovered(dd)}>+ Hinzufügen</Btn>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Host agents */}
          <section className={`rounded-2xl border p-5 space-y-3 ${t.border} ${t.inputBg}`} style={panelStyle(accent, t)}>
            <h2 className={`font-semibold ${t.text}`}>Host-Agents</h2>
            <p className={`text-sm ${t.muted}`}>Server, die sich selbst beim Pi Agent melden (z. B. Proxmox, Docker-Hosts).</p>
            {agents.length === 0 ? (
              <p className={`text-sm ${t.muted}`}>Keine Host-Agents registriert.</p>
            ) : (
              <div className="space-y-2">
                {agents.map((a) => (
                  <div key={a.id} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${t.border}`}>
                    <div className="flex items-center gap-3">
                      <span className={`h-2 w-2 rounded-full ${a.online ? 'bg-green-500' : 'bg-red-500'}`} />
                      <div>
                        <p className={`text-sm font-medium ${t.text}`}>{a.hostname}</p>
                        <p className={`text-xs ${t.muted}`}>
                          {a.ip}{a.tailscaleIp ? ` · ts: ${a.tailscaleIp}` : ''}
                          {a.services.length ? ` · ${a.services.join(', ')}` : ''}
                        </p>
                      </div>
                    </div>
                    <span className={`text-xs ${t.muted}`}>
                      {a.online ? 'online' : `zuletzt ${new Date(a.lastSeen).toLocaleTimeString('de-DE')}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
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
  const [monitorStatuses, setMonitorStatuses] = useState<Record<string, MonitorStatus>>({});
  const [showAddWidget, setShowAddWidget] = useState(false);

  const canAdmin = user.role === 'root' || user.role === 'admin';
  const visibleNav = NAV.filter((n) => !ADMIN_ONLY_TABS.includes(n.key) || canAdmin);

  useEffect(() => {
    void fetch('/api/devices', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { devices: [] })
      .then((d: { devices: Device[] }) => setDevices(d.devices));
    void fetch('/api/widgets', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { widgets: [] })
      .then((d: { widgets: Widget[] }) => setWidgets(d.widgets));
    const loadStatuses = () => fetch('/api/monitor/status', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { statuses: {} })
      .then((d: { statuses: Record<string, MonitorStatus> }) => setMonitorStatuses(d.statuses));
    void loadStatuses();
    const interval = setInterval(() => void loadStatuses(), 30_000);
    return () => clearInterval(interval);
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
      style={{ '--accent-ring': `${accent}45`, '--accent-color': accent } as React.CSSProperties}>
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1800px] gap-3 md:gap-4">

        {/* ── Sidebar ────────────────────────────────────── */}
        <aside className={`flex w-[220px] shrink-0 flex-col rounded-[22px] border backdrop-blur-2xl
          transition-all duration-300 ${t.card} ${t.border}`}
          style={{ boxShadow: `${t.shadowSm}, inset 0 1px 0 rgba(255,255,255,0.06)`, borderColor: `${accent}1A` }}>

          {/* Logo + name */}
          <div className={`border-b px-4 pt-5 pb-4 ${t.divider}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-[11px] shrink-0"
                style={{
                  background: `linear-gradient(145deg, ${accent}EE, ${accent}AA)`,
                  boxShadow: `0 3px 10px ${accent}50`,
                }}>
                <img src="/logo.svg" alt="Logo" className="h-5 w-5" />
              </div>
              <span className={`text-[14px] font-semibold tracking-[-0.1px] ${t.text}`}>{setup.dashboardName}</span>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex flex-1 flex-col gap-0.5 p-2">
            {visibleNav.map((item, i) => {
              const active = tab === item.key;
              return (
                <button key={item.key} onClick={() => goTab(item.key)}
                  className={`flex w-full items-center gap-2.5 rounded-[12px] px-3 py-[9px] text-left text-[13.5px] font-medium
                    transition-all duration-150 animate-slide-left delay-${i + 1}`}
                  style={active ? {
                    backgroundColor: accent,
                    color: 'white',
                    boxShadow: `0 3px 10px ${accent}50`,
                  } : { color: 'var(--t-muted)' }}>
                  <span className={`flex-shrink-0 transition-opacity ${active ? 'opacity-100' : 'opacity-55'}`}>
                    {item.icon}
                  </span>
                  <span className={active ? 'text-white' : t.text}>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Settings nav item */}
          <div className={`border-t px-2 pt-1.5 pb-1.5 ${t.divider}`}>
            <button onClick={() => goTab('settings')}
              className={`flex w-full items-center gap-2.5 rounded-[12px] px-3 py-[9px] text-left text-[13.5px] font-medium
                transition-all duration-150`}
              style={tab === 'settings' ? {
                backgroundColor: accent, color: 'white', boxShadow: `0 3px 10px ${accent}50`,
              } : {}}>
              <span className={`flex-shrink-0 transition-opacity ${tab === 'settings' ? 'opacity-100' : 'opacity-55'}`}>
                <IcGear />
              </span>
              <span className={tab === 'settings' ? 'text-white' : t.text}>Einstellungen</span>
            </button>
          </div>

          {/* User */}
          <div className={`border-t p-2 ${t.divider}`}>
            <div className="relative">
              <button onClick={() => setProfileOpen((v) => !v)}
                className={`flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left transition-all duration-150 ${t.navHover}`}>
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
                  style={{
                    background: `linear-gradient(135deg, ${accent} 0%, ${accent}CC 100%)`,
                    boxShadow: `0 2px 6px ${accent}44`,
                  }}>
                  {user.email[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className={`truncate text-[12px] font-medium ${t.text}`}>{user.email}</p>
                  <p className={`text-[11px] capitalize ${t.muted}`}>{user.role}</p>
                </div>
              </button>
              {profileOpen && (
                <div className={`absolute bottom-full left-0 mb-1.5 w-full rounded-[14px] border p-1.5
                  ${t.card} ${t.border} animate-spring-in material-thick`}
                  style={{ boxShadow: t.shadowLg }}>
                  <button onClick={signOut}
                    className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] font-medium text-[#FF3B30] transition-all hover:bg-[#FF3B30]/10">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25z" clipRule="evenodd"/>
                      <path fillRule="evenodd" d="M6 10a.75.75 0 0 1 .75-.75h9.546l-1.048-1.16a.75.75 0 1 1 1.104-1.02l2.5 2.75a.75.75 0 0 1 0 1.02l-2.5 2.75a.75.75 0 1 1-1.104-1.02l1.048-1.16H6.75A.75.75 0 0 1 6 10z" clipRule="evenodd"/>
                    </svg>
                    Abmelden
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ── Content ────────────────────────────────────── */}
        <main className={`min-w-0 flex-1 rounded-[22px] border backdrop-blur-xl p-5 md:p-6
          transition-all duration-300 ${t.card} ${t.border}`}
          style={{ boxShadow: `${t.shadowSm}, inset 0 1px 0 rgba(255,255,255,0.04)`, borderColor: `${accent}18` }}>

          {tab === 'home' && (
            <div className="animate-slide-right space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className={`text-[22px] font-semibold tracking-[-0.4px] ${t.text}`}>Übersicht</h1>
                  <p className={`text-[14px] ${t.muted}`}>Guten Tag, {user.email.split('@')[0]}</p>
                </div>
                <Btn accent={accent} size="sm" variant="secondary" onClick={() => setShowAddWidget(true)}>+ Widget</Btn>
              </div>

              {showAddWidget && (
                <div className={`rounded-[18px] border p-5 ${t.border} ${t.inputBg}`}
                  style={{ borderColor: `${accent}20` }}>
                  <p className={`mb-4 font-semibold ${t.text}`}>Widget hinzufügen</p>
                  <WidgetForm onSave={addWidget} onCancel={() => setShowAddWidget(false)} devices={devices} t={t} accent={accent} />
                </div>
              )}

              {widgets.length === 0 && !showAddWidget && (
                <div className={`rounded-[18px] border border-dashed p-16 text-center ${t.border}`}
                  style={{ borderColor: `${accent}25` }}>
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[18px]"
                    style={{ backgroundColor: `${accent}15` }}>
                    <IcGrid size={24} />
                  </div>
                  <p className={`font-semibold ${t.text}`}>Keine Widgets</p>
                  <p className={`mt-1 text-[13px] ${t.muted}`}>Klicke auf „+ Widget" um dein Dashboard anzupassen.</p>
                </div>
              )}

              <div className="grid grid-cols-12 gap-4">
                {widgets.map((widget, i) => {
                  const colSpan = Math.min(12, Math.max(2, widget.layout.w * 3));
                  const rowH = widget.layout.h === 1 ? 'h-32' : widget.layout.h === 2 ? 'h-44' : 'h-64';
                  return (
                    <div key={widget.id}
                      className={`col-span-12 md:col-span-${colSpan} animate-slide-up delay-${Math.min(i, 6)}`}>
                      <div className={rowH}>
                        <WidgetRenderer widget={widget} devices={devices} t={t} accent={accent}
                          onRemove={() => removeWidget(widget.id)} statuses={monitorStatuses} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'devices' && (
            <DevicesTab devices={devices} t={t} accent={accent} statuses={monitorStatuses} />
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

          {tab === 'discovery' && canAdmin && (
            <DiscoveryTab devices={devices} setDevices={setDevices} t={t} accent={accent} />
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
