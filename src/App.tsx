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

// ── Design tokens ────────────────────────────────────────────────────────────

const APPLE_COLORS = [
  '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#FF3B30',
  '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#32ADE6',
  '#A2845E', '#636366',
];

function tok(theme: ThemeMode) {
  const t = {
    light: {
      page:       'bg-[#F2F2F7]',
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
      page:       'bg-[#1C1C1E]',
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
      page:       'bg-black',
      card:       'bg-[#111111]/98',
      border:     'border-white/[0.05]',
      text:       'text-[#F5F5F7]',
      muted:      'text-[#48484A]',
      inputBg:    'bg-[#1C1C1E]',
      inputText:  'text-[#F5F5F7] placeholder:text-[#48484A]',
      inputBorder:'border border-transparent',
      divider:    'border-white/[0.05]',
      navHover:   'hover:bg-white/[0.04]',
      navActive:  'bg-white/[0.07] font-medium',
      userCard:   'bg-white/[0.03]',
      shadow:     '0 2px 20px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.5)',
      shadowSm:   '0 1px 4px rgba(0,0,0,0.4)',
    },
  } as const;
  return t[theme];
}

// ── Small UI components ──────────────────────────────────────────────────────

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
  variant = 'primary', accent, className = '',
}: {
  children: React.ReactNode; onClick?: () => void; loading?: boolean;
  disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost';
  accent: string; className?: string;
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all active:scale-[0.97] disabled:opacity-40 select-none cursor-pointer';
  if (variant === 'primary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} text-white ${className}`}
      style={{ backgroundColor: accent, boxShadow: `0 2px 8px ${accent}55` }}>
      {loading ? <Spinner size={16} color="white" /> : children}
    </button>
  );
  if (variant === 'secondary') return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} bg-white/10 ${className}`}>
      {loading ? <Spinner size={16} /> : children}
    </button>
  );
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`${base} opacity-60 hover:opacity-100 ${className}`}>
      {loading ? <Spinner size={16} /> : children}
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

function Card({ children, className = '', t }: {
  children: React.ReactNode; className?: string; t: ReturnType<typeof tok>;
}) {
  return (
    <div className={`rounded-2xl border backdrop-blur-xl ${t.card} ${t.border} ${className}`}
      style={{ boxShadow: t.shadow }}>
      {children}
    </div>
  );
}

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
        {/* Header */}
        <div className="text-center animate-slide-up">
          <img src="/logo.svg" alt="Logo" className="mx-auto mb-4 h-12 w-12 rounded-2xl" style={{ boxShadow: `0 4px 16px ${accent}44` }} />
          <h1 className={`text-2xl font-semibold tracking-tight ${t.text}`}>Dashboard einrichten</h1>
          <p className={`mt-1 text-sm ${t.muted}`}>Schritt {Math.min(step, 4)} von 4</p>
        </div>

        {/* Progress bar */}
        <div className={`h-1 w-full rounded-full overflow-hidden ${t.inputBg}`} style={{ animationDelay: '0.1s' }}>
          <div className="h-full rounded-full transition-all duration-500"
            style={{ width: `${(Math.min(step, 4) / 4) * 100}%`, backgroundColor: accent }} />
        </div>

        {/* Step pills */}
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

        {/* Card */}
        <div key={animKey} className="animate-slide-up">
          <Card t={t} className="p-7">
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
                  <p className={`mt-1 text-sm ${t.muted}`}>Dein Gerät generiert einen sicheren Schlüssel mit Face ID, Touch ID oder PIN. Keine Passwörter nötig.</p>
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
                  <div className="flex items-center justify-center py-8">
                    <Spinner size={24} color={accent} />
                  </div>
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
                          theme === m ? `${t.border}` : `${t.border} opacity-40 hover:opacity-70`
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
        <Card t={t} className="p-7">{children}</Card>
      </div>
    </div>
  );
}

function LoginPage({ onLogin, setup }: {
  onLogin: (u: SessionUser) => void;
  setup: SetupStatus;
}) {
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
    } finally {
      setLoading(false);
    }
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

type Tab = 'home' | 'devices' | 'passwords' | 'drive' | 'admin' | 'settings';

const NAV: { key: Tab; label: string; icon: string }[] = [
  { key: 'home',      label: 'Home',      icon: '⌂' },
  { key: 'devices',   label: 'Geräte',    icon: '◫' },
  { key: 'passwords', label: 'Passwörter',icon: '⟐' },
  { key: 'drive',     label: 'Drive',     icon: '◉' },
  { key: 'admin',     label: 'Admin',     icon: '⚙' },
];

function Placeholder({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`rounded-2xl border border-dashed border-white/10 flex items-center justify-center ${className}`}>
      <span className="text-xs opacity-30">{label}</span>
    </div>
  );
}

function Dashboard({ user, setup, onSignOut }: {
  user: SessionUser; setup: SetupStatus; onSignOut: () => void;
}) {
  const [theme, setTheme] = useState<ThemeMode>(setup.theme);
  const [accent, setAccent] = useState(setup.accent);
  const t = tok(theme);
  const [tab, setTab] = useState<Tab>('home');
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('user');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [status, setStatus] = useState('');

  const canAdmin = user.role === 'root' || user.role === 'admin';
  const visibleNav = NAV.filter((n) => n.key !== 'admin' || canAdmin);

  const goTab = (k: Tab) => { setTab(k); setProfileOpen(false); if (k === 'admin') loadUsers(); };

  const loadUsers = async () => {
    const r = await fetch('/api/admin/users', { credentials: 'include' });
    if (r.ok) setAdminUsers((await r.json() as { users: AdminUser[] }).users);
  };

  const createInvite = async () => {
    setInviteLoading(true); setStatus('');
    const r = await fetch('/api/admin/invites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (!r.ok) { setStatus(`✗ ${await readErr(r, 'Einladung fehlgeschlagen')}`); }
    else { setInviteUrl((await r.json() as { inviteUrl: string }).inviteUrl); }
    setInviteLoading(false);
  };

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    onSignOut();
  };

  return (
    <div className={`min-h-screen ${t.page} p-3 md:p-4 animate-fade-in`}
      style={{ '--accent-ring': `${accent}55` } as React.CSSProperties}>
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1800px] gap-3 md:gap-4">

        {/* Sidebar */}
        <aside className={`flex w-[220px] shrink-0 flex-col rounded-2xl border backdrop-blur-xl
          ${t.card} ${t.border}`} style={{ boxShadow: t.shadowSm }}>
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

          {/* User section */}
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
          ${t.card} ${t.border}`} style={{ boxShadow: t.shadowSm }}>

          {tab === 'home' && (
            <div className="animate-slide-right space-y-4">
              <div>
                <h1 className={`text-xl font-semibold ${t.text}`}>Übersicht</h1>
                <p className={`text-sm ${t.muted}`}>Guten Tag, {user.email.split('@')[0]}</p>
              </div>
              <div className="grid grid-cols-12 gap-4">
                <div className={`col-span-12 rounded-2xl border p-5 md:col-span-8 ${t.border} ${t.inputBg}`}>
                  <p className={`text-xs font-medium uppercase tracking-widest ${t.muted}`}>Wohnzimmer</p>
                  <Placeholder label="Gerätesteuerung" className="mt-4 h-56" />
                </div>
                <div className={`col-span-12 rounded-2xl border p-5 md:col-span-4 ${t.border} ${t.inputBg}`}>
                  <p className={`text-xs font-medium uppercase tracking-widest ${t.muted}`}>Klima</p>
                  <Placeholder label="Temperatur" className="mt-4 h-56" />
                </div>
                <div className={`col-span-12 rounded-2xl border p-5 md:col-span-4 ${t.border} ${t.inputBg}`}>
                  <p className={`text-xs font-medium uppercase tracking-widest ${t.muted}`}>Energie</p>
                  <Placeholder label="Verbrauch" className="mt-3 h-32" />
                </div>
                <div className={`col-span-12 rounded-2xl border p-5 md:col-span-4 ${t.border} ${t.inputBg}`}>
                  <p className={`text-xs font-medium uppercase tracking-widest ${t.muted}`}>Sicherheit</p>
                  <Placeholder label="Kameras & Schlösser" className="mt-3 h-32" />
                </div>
                <div className={`col-span-12 rounded-2xl border p-5 md:col-span-4 ${t.border} ${t.inputBg}`}>
                  <p className={`text-xs font-medium uppercase tracking-widest ${t.muted}`}>Szenen</p>
                  <Placeholder label="Automationen" className="mt-3 h-32" />
                </div>
              </div>
            </div>
          )}

          {tab === 'devices' && (
            <div className="animate-slide-right">
              <h1 className={`text-xl font-semibold ${t.text}`}>Geräte</h1>
              <p className={`mt-1 text-sm ${t.muted}`}>Verbundene Geräte, Räume und Automationen.</p>
              <Placeholder label="Geräteverwaltung" className="mt-6 h-72" />
            </div>
          )}

          {tab === 'passwords' && (
            <div className="animate-slide-right">
              <h1 className={`text-xl font-semibold ${t.text}`}>Passwörter</h1>
              <p className={`mt-1 text-sm ${t.muted}`}>Backup-Codes und Zugangsdaten sicher speichern.</p>
              <Placeholder label="Passwortverwaltung" className="mt-6 h-72" />
            </div>
          )}

          {tab === 'drive' && (
            <div className="animate-slide-right">
              <h1 className={`text-xl font-semibold ${t.text}`}>Drive</h1>
              <p className={`mt-1 text-sm ${t.muted}`}>Dashboard-Exporte und freigegebene Dateien.</p>
              <Placeholder label="Dateiverwaltung" className="mt-6 h-72" />
            </div>
          )}

          {tab === 'settings' && (
            <div className="animate-slide-right space-y-6 max-w-lg">
              <h1 className={`text-xl font-semibold ${t.text}`}>Einstellungen</h1>
              <div className="space-y-1.5">
                <label className={`block text-sm font-medium ${t.muted}`}>Design</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['light', 'dark', 'ultra-dark'] as ThemeMode[]).map((m) => (
                    <button key={m} onClick={() => setTheme(m)}
                      className={`rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                        theme === m ? t.border : `${t.border} opacity-40 hover:opacity-70`
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
            </div>
          )}

          {tab === 'admin' && (
            <div className="animate-slide-right space-y-6">
              <h1 className={`text-xl font-semibold ${t.text}`}>Administration</h1>

              {/* Invite */}
              <div className={`rounded-2xl border p-5 space-y-4 ${t.border} ${t.inputBg}`}>
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
                  <div className={`rounded-xl border p-3 ${t.border}`}>
                    <p className={`mb-1 text-xs font-medium ${t.muted}`}>Einladungslink</p>
                    <p className="break-all font-mono text-xs" style={{ color: accent }}>{inviteUrl}</p>
                  </div>
                )}
              </div>

              {/* Users */}
              <div className={`rounded-2xl border p-5 ${t.border} ${t.inputBg}`}>
                <h2 className={`mb-3 font-semibold ${t.text}`}>Nutzer</h2>
                {adminUsers.length === 0 ? (
                  <p className={`text-sm ${t.muted}`}>Keine Nutzer geladen.</p>
                ) : (
                  <ul className="space-y-2">
                    {adminUsers.map((u) => (
                      <li key={u.id} className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${t.border}`}>
                        <span className={t.text}>{u.email}</span>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs capitalize ${t.muted}`}>{u.role}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            u.hasPasskey ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'
                          }`}>{u.hasPasskey ? 'Passkey' : 'Kein Passkey'}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
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
