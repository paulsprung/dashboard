import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Role = 'root' | 'admin' | 'user' | 'readonly';
type Accent = 'blue' | 'cyan' | 'violet' | 'emerald' | 'rose';
type SessionUser = { id: string; email: string; role: Role; avatarUrl?: string };
type ThemeMode = 'light' | 'dark' | 'ultra-dark';
type SetupStatus = { completed: boolean; dashboardName: string; theme: ThemeMode; accent: Accent; setupStarted: boolean; backupPasswordAccepted: boolean };
type AdminUser = { id: string; email: string; role: Role; hasPasskey: boolean; avatarUrl?: string };
type InvitePayload = { inviteUrl: string };

const readErrorMessage = async (response: Response, fallback: string) => {
  try { return ((await response.json()) as { error?: string }).error ?? fallback; } catch { return fallback; }
};

export default function App() {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [email, setEmail] = useState('');
  const [dashboardName, setDashboardName] = useState('SM Dashboard');
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [accent, setAccent] = useState<Accent>('blue');
  const [status, setStatus] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [step, setStep] = useState(1);
  const [tab, setTab] = useState<'home' | 'devices' | 'passwords' | 'drive' | 'admin' | 'settings'>('home');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<Role>('user');
  const [inviteUrl, setInviteUrl] = useState('');

  useEffect(() => { void (async () => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite') ?? '';
    if (invite) { setInviteToken(invite); setEmail(params.get('email') ?? ''); }

    const setupRes = await fetch('/api/setup/status');
    const setupData = (await setupRes.json()) as SetupStatus;
    setSetup(setupData); setDashboardName(setupData.dashboardName); setTheme(setupData.theme); setAccent(setupData.accent);
    if (setupData.setupStarted && !setupData.completed) setStep(2);

    if (setupData.completed) {
      const me = await fetch('/api/auth/me', { credentials: 'include' });
      if (me.ok) setUser((await me.json() as { user: SessionUser }).user);
    }
  })(); }, []);

  const startSetup = async () => {
    const r = await fetch('/api/setup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootEmail: email }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Setup start failed')}`);
    setStep(2);
  };
  const registerRootPasskey = async () => {
    const options = await fetch('/api/setup/root/registration-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!options.ok) return setStatus(`❌ ${await readErrorMessage(options, 'Failed to load registration options')}`);
    const registrationResponse = await startRegistration({ optionsJSON: await options.json() });
    const verify = await fetch('/api/setup/root/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse }) });
    if (!verify.ok) return setStatus(`❌ ${await readErrorMessage(verify, 'Registration failed')}`);
    setStep(3);
  };
  const generateBackup = async () => {
    const r = await fetch('/api/setup/generate-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Backup failed')}`);
    setBackupPassword((await r.json() as { rootBackupPassword: string }).rootBackupPassword); setStep(4);
  };
  const acknowledgeBackup = async () => {
    const r = await fetch('/api/setup/acknowledge-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted: true }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Acknowledge failed')}`);
    setStep(5);
  };
  const finishSetup = async () => {
    const r = await fetch('/api/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, dashboardName, theme, accent }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Finish setup failed')}`);
    setSetup({ completed: true, setupStarted: true, backupPasswordAccepted: true, dashboardName, theme, accent });
  };

  const registerViaInvite = async () => {
    const options = await fetch('/api/auth/passkey/registration-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, inviteToken }) });
    if (!options.ok) return setStatus(`❌ ${await readErrorMessage(options, 'Failed to load registration options')}`);
    const registrationResponse = await startRegistration({ optionsJSON: await options.json() });
    const verify = await fetch('/api/auth/passkey/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse, inviteToken }) });
    if (!verify.ok) return setStatus(`❌ ${await readErrorMessage(verify, 'Invite registration failed')}`);
    setInviteToken('');
    window.history.replaceState({}, '', window.location.pathname);
    setStatus('✅ Passkey registered. Please sign in.');
  };

  const signIn = async () => {
    const challenge = await fetch('/api/auth/passkey/authentication-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!challenge.ok) return setStatus(`❌ ${await readErrorMessage(challenge, 'Failed to load authentication options')}`);
    const assertion = await startAuthentication({ optionsJSON: await challenge.json() });
    const verify = await fetch('/api/auth/passkey/verify-authentication', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(assertion) });
    if (!verify.ok) return setStatus(`❌ ${await readErrorMessage(verify, 'Sign in failed')}`);
    setUser((await verify.json() as { user: SessionUser }).user);
  };

  const loadUsers = async () => { const r = await fetch('/api/admin/users', { credentials: 'include' }); if (r.ok) setAdminUsers((await r.json() as { users: AdminUser[] }).users); };
  const createInvite = async () => {
    const r = await fetch('/api/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: newUserEmail, role: newUserRole }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Invite failed')}`);
    setInviteUrl((await r.json() as InvitePayload).inviteUrl);
  };
  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setProfileMenuOpen(false);
    setTab('home');
  };

  const accentPalette: Record<Accent, { glow: string; text: string; button: string }> = {
    blue: { glow: 'from-blue-600/30 to-blue-300/10', text: 'text-blue-200', button: 'bg-blue-400 hover:bg-blue-300 text-slate-900' },
    cyan: { glow: 'from-cyan-500/30 to-cyan-300/10', text: 'text-cyan-200', button: 'bg-cyan-400 hover:bg-cyan-300 text-slate-900' },
    violet: { glow: 'from-violet-500/30 to-violet-300/10', text: 'text-violet-200', button: 'bg-violet-400 hover:bg-violet-300 text-slate-900' },
    emerald: { glow: 'from-emerald-500/30 to-emerald-300/10', text: 'text-emerald-200', button: 'bg-emerald-400 hover:bg-emerald-300 text-slate-900' },
    rose: { glow: 'from-rose-500/30 to-rose-300/10', text: 'text-rose-200', button: 'bg-rose-400 hover:bg-rose-300 text-slate-900' },
  };
  const pal = accentPalette[accent];
  const shell = theme === 'light' ? 'bg-gradient-to-br from-slate-100 to-white text-slate-900' : theme === 'dark' ? 'bg-gradient-to-br from-black via-slate-950 to-slate-900 text-slate-100' : 'bg-black text-slate-100';
  const glass = theme === 'light' ? 'bg-white/80 border-slate-200' : theme === 'dark' ? 'bg-slate-900/70 border-white/10' : 'bg-black/90 border-slate-700';

  if (!setup) return <main className={`min-h-screen ${shell} p-8`}>Loading…</main>;

  const setupStepButtons = [
    { step: 1, label: 'Create root user', action: startSetup },
    { step: 2, label: 'Register root passkey', action: registerRootPasskey },
    { step: 3, label: 'Generate backup password', action: generateBackup },
    { step: 4, label: 'I saved the password', action: acknowledgeBackup },
    { step: 5, label: 'Finish setup', action: finishSetup },
  ];

  if (!setup.completed) return (
    <main className={`min-h-screen ${shell} flex items-center justify-center p-8`}>
      <section className={`w-full max-w-xl rounded-[30px] border ${glass} p-8 shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-3xl`}>
        <h1 className="text-3xl font-semibold">Setup</h1>
        <p className="mt-1 opacity-70">Root onboarding • step {step}/5</p>
        <div className="mt-5 space-y-3">
          <input className="w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="root@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {step === 5 && (
            <>
              <input className="w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="Dashboard name" value={dashboardName} onChange={(e) => setDashboardName(e.target.value)} />
            </>
          )}
          {step === 4 && backupPassword && <p className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">Backup password: <strong>{backupPassword}</strong></p>}
          <button className={`w-full rounded-2xl px-4 py-3 font-semibold ${pal.button}`} onClick={setupStepButtons[step - 1].action}>{setupStepButtons[step - 1].label}</button>
          {status && <p className="text-sm">{status}</p>}
        </div>
      </section>
    </main>
  );

  if (!user && inviteToken) return (
    <main className={`min-h-screen ${shell} flex items-center justify-center p-8`}>
      <section className={`w-full max-w-md rounded-[30px] border ${glass} p-8 shadow-2xl backdrop-blur-3xl`}>
        <h1 className="text-2xl font-semibold">Join dashboard</h1>
        <p className="mt-1 text-sm opacity-80">Register your passkey via invite</p>
        <input className="mt-4 w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className={`mt-3 w-full rounded-2xl px-4 py-3 font-semibold ${pal.button}`} onClick={registerViaInvite}>Register passkey</button>
        {status && <p className="mt-2 text-sm">{status}</p>}
      </section>
    </main>
  );

  if (!user) return (
    <main className={`min-h-screen ${shell} flex items-center justify-center p-8`}>
      <section className={`w-full max-w-md rounded-[30px] border ${glass} p-8 shadow-2xl backdrop-blur-3xl`}>
        <h1 className="text-3xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm opacity-80">Passkey login</p>
        <input className="mt-4 w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className={`mt-3 w-full rounded-2xl px-4 py-3 font-semibold ${pal.button}`} onClick={signIn}>Sign in</button>
        {status && <p className="mt-2 text-sm">{status}</p>}
      </section>
    </main>
  );

  const navItems = ([
    { key: 'home', icon: '⌂', label: 'Home' },
    { key: 'devices', icon: '◫', label: 'Devices' },
    { key: 'passwords', icon: '⟐', label: 'Passwords' },
    { key: 'drive', icon: '◉', label: 'Drive' },
    { key: 'admin', icon: '⚙', label: 'Admin' },
  ] as const).filter((item) => item.key !== 'admin' || user.role === 'root' || user.role === 'admin');

  return (
    <main className={`min-h-screen ${shell} p-3 md:p-5`}>
      <div className="pointer-events-none absolute inset-0 opacity-25">
        <div className={`absolute left-8 top-8 h-56 w-56 rounded-full bg-gradient-to-br ${pal.glow} blur-3xl`} />
      </div>
      <div className="relative mx-auto flex min-h-[calc(100vh-1.5rem)] w-full max-w-[1800px] gap-4 md:min-h-[calc(100vh-2.5rem)]">
        <aside className={`w-[250px] shrink-0 rounded-[28px] border ${glass} p-4 shadow-2xl backdrop-blur-2xl`}>
          <div className="mb-4 border-b border-white/10 pb-3">
            <div className="flex items-center gap-2"><img src="/logo.svg" alt="Dashboard logo" className="h-7 w-7 rounded-md" /><p className="text-lg font-semibold">{dashboardName}</p></div>
          </div>
          <nav className="flex h-[calc(100%-5rem)] flex-col">
            <div className="space-y-1">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    setTab(item.key as 'home' | 'devices' | 'passwords' | 'drive' | 'admin');
                    setProfileMenuOpen(false);
                    if (item.key === 'admin') void loadUsers();
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${tab === item.key ? 'bg-white/15 text-white' : 'hover:bg-white/10'}`}
                >
                  <span className="text-base">{item.icon}</span><span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="mt-auto">
              <div className="relative">
                <button onClick={() => setProfileMenuOpen((v) => !v)} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 hover:bg-white/10">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 font-semibold text-white">{user.email.slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0 text-left"><p className="truncate text-sm font-medium">{user.email}</p><p className="text-xs opacity-70">{user.role}</p></div>
                </button>
                {profileMenuOpen && (
                  <div className="absolute bottom-12 left-0 z-20 w-full rounded-xl border border-white/15 bg-slate-900/95 p-1 shadow-xl">
                    <button onClick={() => { setTab('settings'); setProfileMenuOpen(false); }} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">User settings</button>
                    <button onClick={signOut} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Sign out</button>
                  </div>
                )}
              </div>
            </div>
          </nav>
        </aside>

        <section className={`min-w-0 flex-1 rounded-[28px] border ${glass} p-4 md:p-6`}>
            {tab === 'home' && (
              <div className="grid grid-cols-12 gap-4">
                <article className="col-span-12 rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl md:col-span-8"><p className="text-xs uppercase tracking-[0.2em] opacity-60">Living Area</p><div className="mt-4 h-64 rounded-2xl border border-white/10 bg-white/5" /></article>
                <article className="col-span-12 rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl md:col-span-4"><p className="text-xs uppercase tracking-[0.2em] opacity-60">Climate</p><div className="mt-4 h-64 rounded-2xl border border-white/10 bg-white/5" /></article>
                <article className="col-span-12 rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl md:col-span-4"><p className="text-xs uppercase tracking-[0.2em] opacity-60">Energy</p><div className="mt-3 h-36 rounded-2xl border border-white/10 bg-white/5" /></article>
                <article className="col-span-12 rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl md:col-span-4"><p className="text-xs uppercase tracking-[0.2em] opacity-60">Security</p><div className="mt-3 h-36 rounded-2xl border border-white/10 bg-white/5" /></article>
                <article className="col-span-12 rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl md:col-span-4"><p className="text-xs uppercase tracking-[0.2em] opacity-60">Scenes</p><div className="mt-3 h-36 rounded-2xl border border-white/10 bg-white/5" /></article>
              </div>
            )}

            {tab === 'devices' && (
              <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                <h2 className="text-xl font-semibold">Devices</h2>
                <p className="mt-2 text-sm opacity-80">Manage connected rooms, sensors, and automations.</p>
              </div>
            )}

            {tab === 'passwords' && (
              <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                <h2 className="text-xl font-semibold">Passwords</h2>
                <p className="mt-2 text-sm opacity-80">Store recovery secrets and backup credentials securely.</p>
              </div>
            )}

            {tab === 'drive' && (
              <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                <h2 className="text-xl font-semibold">Drive</h2>
                <p className="mt-2 text-sm opacity-80">Browse dashboard exports and shared files.</p>
              </div>
            )}

            {tab === 'settings' && (
              <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                <h2 className="text-xl font-semibold">User settings</h2>
                <p className="mt-2 opacity-80">{user.email} • {user.role}</p>
                <p className="mt-4 text-sm opacity-70">Edit your profile preferences and security options here.</p>
                <div className="mt-4"><label className="mb-2 block text-sm opacity-80">Theme</label><select className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2" value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}><option value="light">Light</option><option value="dark">Dark</option><option value="ultra-dark">Ultra dark</option></select></div>
              </div>
            )}

            {tab === 'admin' && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                  <h2 className="text-xl font-semibold">Admin settings • Theme</h2>
                  <p className="mb-3 mt-2 text-sm opacity-80">Accent palette</p>
                  <div className="mb-4 grid grid-cols-5 gap-2">
                    {([{ key: 'blue', hex: '#3B82F6' }, { key: 'cyan', hex: '#22D3EE' }, { key: 'violet', hex: '#A78BFA' }, { key: 'emerald', hex: '#34D399' }, { key: 'rose', hex: '#FB7185' }] as const).map((c) => (
                      <button key={c.key} onClick={() => setAccent(c.key)} className={`h-10 rounded-lg border-2 ${accent === c.key ? 'border-white' : 'border-transparent'}`} style={{ backgroundColor: c.hex }} />
                    ))}
                  </div>
                  <select className="rounded-2xl border border-white/20 bg-white/5 px-3 py-2" value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}>
                    <option value="light">Light</option><option value="dark">Dark</option><option value="ultra-dark">Ultra dark</option>
                  </select>
                </div>

                <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                  <h2 className="text-xl font-semibold">Admin settings • User management</h2>
                  <div className="mt-4 grid gap-2 md:grid-cols-3">
                    <input className="rounded-2xl border border-white/20 bg-white/5 px-3 py-2" placeholder="user@email.com" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} />
                    <select className="rounded-2xl border border-white/20 bg-white/5 px-3 py-2" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as Role)}><option value="admin">Admin</option><option value="user">User</option><option value="readonly">Read-only</option></select>
                    <button className={`rounded-2xl px-3 py-2 font-semibold ${pal.button}`} onClick={createInvite}>Create invite</button>
                  </div>
                  {inviteUrl && <p className="mt-3 break-all rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs">{inviteUrl}</p>}
                </div>

                <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                  <h2 className="text-xl font-semibold">Admin settings • Widget management</h2>
                  <p className="mt-2 text-sm opacity-80">Setup for the home screen widgets will be configured here.</p>
                </div>

                <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                  <h2 className="text-xl font-semibold">Users</h2>
                  <ul className="mt-3 space-y-2">
                    {adminUsers.map((u) => (
                      <li key={u.id} className="rounded-2xl border border-white/10 bg-white/5 p-3 text-sm">
                        {u.email} • {u.role} • {u.hasPasskey ? 'passkey' : 'no passkey'}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>
      </div>
    </main>
  );

}
