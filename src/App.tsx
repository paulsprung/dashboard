import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Role = 'root' | 'admin' | 'user' | 'readonly';
type Accent = 'cyan' | 'violet' | 'emerald' | 'rose';
type SessionUser = { id: string; email: string; role: Role; avatarUrl?: string };
type SetupStatus = { completed: boolean; dashboardName: string; theme: 'dark' | 'light'; accent: Accent; setupStarted: boolean; backupPasswordAccepted: boolean };
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
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [accent, setAccent] = useState<Accent>('cyan');
  const [status, setStatus] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [step, setStep] = useState(1);
  const [tab, setTab] = useState<'dashboard' | 'admin' | 'settings'>('dashboard');
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

  const accentPalette: Record<Accent, { glow: string; text: string; button: string }> = {
    cyan: { glow: 'from-cyan-500/30 to-cyan-300/10', text: 'text-cyan-200', button: 'bg-cyan-400 hover:bg-cyan-300 text-slate-900' },
    violet: { glow: 'from-violet-500/30 to-violet-300/10', text: 'text-violet-200', button: 'bg-violet-400 hover:bg-violet-300 text-slate-900' },
    emerald: { glow: 'from-emerald-500/30 to-emerald-300/10', text: 'text-emerald-200', button: 'bg-emerald-400 hover:bg-emerald-300 text-slate-900' },
    rose: { glow: 'from-rose-500/30 to-rose-300/10', text: 'text-rose-200', button: 'bg-rose-400 hover:bg-rose-300 text-slate-900' },
  };
  const pal = accentPalette[accent];
  const shell = theme === 'light' ? 'bg-gradient-to-br from-purple-100 to-white text-slate-900' : `bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100`;
  const glass = theme === 'light' ? 'bg-white/70 border-slate-200' : 'bg-white/10 border-white/10';

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
      <section className={`w-full max-w-xl rounded-[32px] border ${glass} p-8 shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-3xl`}>
        <h1 className="text-3xl font-semibold">Setup</h1>
        <p className="mt-1 opacity-70">Root onboarding • step {step}/5</p>
        <div className="mt-5 space-y-3">
          <input className="w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="root@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {step === 5 && (
            <>
              <input className="w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="Dashboard name" value={dashboardName} onChange={(e) => setDashboardName(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <select className="rounded-2xl border border-white/20 bg-white/5 px-4 py-3" value={theme} onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}><option value="dark">Dark</option><option value="light">Light</option></select>
                <select className="rounded-2xl border border-white/20 bg-white/5 px-4 py-3" value={accent} onChange={(e) => setAccent(e.target.value as Accent)}><option value="cyan">Cyan</option><option value="violet">Violet</option><option value="emerald">Emerald</option><option value="rose">Rose</option></select>
              </div>
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
      <section className={`w-full max-w-md rounded-[28px] border ${glass} p-8 shadow-2xl backdrop-blur-3xl`}>
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
      <section className={`w-full max-w-md rounded-[28px] border ${glass} p-8 shadow-2xl backdrop-blur-3xl`}>
        <h1 className="text-3xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm opacity-80">Passkey login</p>
        <input className="mt-4 w-full rounded-2xl border border-white/20 bg-white/5 px-4 py-3" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className={`mt-3 w-full rounded-2xl px-4 py-3 font-semibold ${pal.button}`} onClick={signIn}>Sign in</button>
        {status && <p className="mt-2 text-sm">{status}</p>}
      </section>
    </main>
  );

  const navItems = ([
    { key: 'dashboard', icon: '⌂', label: 'Dashboard' },
    { key: 'admin', icon: '⚙', label: 'Admin' },
    { key: 'settings', icon: '◉', label: 'Settings' },
  ] as const).filter((item) => item.key !== 'admin' || user.role === 'root' || user.role === 'admin');

  return (
    <main className={`min-h-screen ${shell} p-6`}>
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className={`absolute left-1/4 top-12 h-56 w-56 rounded-full bg-gradient-to-br ${pal.glow} blur-3xl animate-pulse`} />
        <div className={`absolute right-1/4 bottom-16 h-72 w-72 rounded-full bg-gradient-to-br ${pal.glow} blur-3xl`} />
      </div>

      <div className={`relative mx-auto max-w-7xl rounded-[40px] border ${glass} p-5 shadow-[0_24px_120px_rgba(0,0,0,0.45)] backdrop-blur-3xl`}>
        <header className="mb-5 flex items-center justify-between rounded-3xl border border-white/15 bg-white/5 px-5 py-4 backdrop-blur-xl">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] opacity-60">Smart Home</p>
            <h1 className={`text-2xl font-semibold ${pal.text}`}>{dashboardName}</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs opacity-80 md:block">{theme} • {accent}</div>
            <button onClick={() => setTab('settings')} className="h-12 w-12 overflow-hidden rounded-full border border-white/25 bg-white/15 shadow-inner">
              {user.avatarUrl ? <img src={user.avatarUrl} alt="avatar" /> : <span className="text-sm font-semibold">{user.email.slice(0, 1).toUpperCase()}</span>}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-5">
          <aside className="col-span-12 md:col-span-2">
            <div className="mx-auto flex w-20 flex-row items-center justify-center gap-2 rounded-[28px] border border-white/15 bg-white/10 p-2 backdrop-blur-xl md:min-h-[560px] md:w-20 md:flex-col md:justify-start md:gap-3 md:pt-6">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  aria-label={item.label}
                  onClick={() => {
                    setTab(item.key as 'dashboard' | 'admin' | 'settings');
                    if (item.key === 'admin') void loadUsers();
                  }}
                  className={`h-12 w-12 rounded-2xl text-xl transition ${tab === item.key ? `bg-white/25 ${pal.text} shadow-lg` : 'bg-white/10 hover:bg-white/20'}`}
                >
                  {item.icon}
                </button>
              ))}
            </div>
          </aside>

          <section className="col-span-12 md:col-span-10">
            {tab === 'dashboard' && (
              <div className="grid gap-4 md:grid-cols-3">
                {['Living room', 'Climate', 'Security', 'Energy', 'Scenes', 'Devices'].map((k, index) => (
                  <article key={k} className="rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white/15">
                    <p className="text-xs uppercase tracking-[0.2em] opacity-60">{k}</p>
                    <p className="mt-3 text-3xl font-semibold">{(index + 1) * 12}%</p>
                    <div className="mt-4 h-2 rounded-full bg-white/20"><div className={`h-2 rounded-full bg-gradient-to-r ${pal.glow}`} style={{ width: `${40 + index * 8}%` }} /></div>
                  </article>
                ))}
              </div>
            )}

            {tab === 'settings' && (
              <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                <h2 className="text-xl font-semibold">User settings</h2>
                <p className="mt-2 opacity-80">{user.email} • {user.role}</p>
                <p className="mt-4 text-sm opacity-70">Avatar click in top right opens this view.</p>
              </div>
            )}

            {tab === 'admin' && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
                  <h2 className="text-xl font-semibold">Invite user</h2>
                  <div className="mt-4 grid gap-2 md:grid-cols-3">
                    <input className="rounded-2xl border border-white/20 bg-white/5 px-3 py-2" placeholder="user@email.com" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} />
                    <select className="rounded-2xl border border-white/20 bg-white/5 px-3 py-2" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as Role)}><option value="admin">Admin</option><option value="user">User</option><option value="readonly">Readonly</option></select>
                    <button className={`rounded-2xl px-3 py-2 font-semibold ${pal.button}`} onClick={createInvite}>Create invite</button>
                  </div>
                  {inviteUrl && <p className="mt-3 break-all rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs">{inviteUrl}</p>}
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
      </div>
    </main>
  );

}
