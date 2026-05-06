import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Role = 'root' | 'admin' | 'user' | 'readonly';
type Accent = 'cyan' | 'violet' | 'emerald' | 'rose';
type SessionUser = { id: string; email: string; role: Role; avatarUrl?: string };
type SetupStatus = { completed: boolean; dashboardName: string; theme: 'dark' | 'light'; accent: Accent; setupStarted: boolean; backupPasswordAccepted: boolean };
type AdminUser = { id: string; email: string; role: Role; hasPasskey: boolean; avatarUrl?: string };
type InvitePayload = { token: string; inviteUrl: string };

const readErrorMessage = async (response: Response, fallback: string) => {
  try { const payload = (await response.json()) as { error?: string }; return payload.error ?? fallback; } catch { return fallback; }
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
  const [activeTab, setActiveTab] = useState<'dashboard' | 'admin' | 'settings'>('dashboard');
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<Role>('user');
  const [inviteUrl, setInviteUrl] = useState('');

  useEffect(() => { void (async () => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite') ?? '';
    const invitedEmail = params.get('email') ?? '';
    if (invite) { setInviteToken(invite); if (invitedEmail) setEmail(invitedEmail); }

    const setupRes = await fetch('/api/setup/status');
    const setupPayload = (await setupRes.json()) as SetupStatus;
    setSetup(setupPayload); setDashboardName(setupPayload.dashboardName); setTheme(setupPayload.theme); setAccent(setupPayload.accent ?? 'cyan');
    if (setupPayload.setupStarted && !setupPayload.completed) setStep(2);
    if (setupPayload.completed) {
      const me = await fetch('/api/auth/me', { credentials: 'include' });
      if (me.ok) setUser((await me.json() as { user: SessionUser }).user);
    }
  })(); }, []);

  const startSetup = async () => {
    const r = await fetch('/api/setup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootEmail: email }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Setup start failed')}`);
    setStep(2); setStatus('✅ Root user created. Next: register root passkey.');
  };

  const registerRootPasskey = async () => {
    const optionsResponse = await fetch('/api/auth/passkey/registration-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!optionsResponse.ok) return setStatus(`❌ ${await readErrorMessage(optionsResponse, 'Failed to load registration options')}`);
    const registrationResponse = await startRegistration({ optionsJSON: await optionsResponse.json() });
    const verifyResponse = await fetch('/api/auth/passkey/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse }) });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Passkey registration failed')}`);
    setStep(3);
  };

  const generateBackupPassword = async () => {
    const r = await fetch('/api/setup/generate-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to generate backup password')}`);
    setBackupPassword((await r.json() as { rootBackupPassword: string }).rootBackupPassword); setStep(4);
  };

  const acknowledgePassword = async () => {
    const r = await fetch('/api/setup/acknowledge-backup-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted: true }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to acknowledge password')}`);
    setStep(5);
  };

  const completeSetup = async () => {
    const r = await fetch('/api/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, dashboardName, theme, accent }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to complete setup')}`);
    setSetup({ completed: true, dashboardName, theme, accent, setupStarted: true, backupPasswordAccepted: true });
    setStatus('✅ Setup complete. Please sign in.');
  };

  const registerViaInvite = async () => {
    const optionsResponse = await fetch('/api/auth/passkey/registration-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, inviteToken }) });
    if (!optionsResponse.ok) return setStatus(`❌ ${await readErrorMessage(optionsResponse, 'Failed to load registration options')}`);
    const registrationResponse = await startRegistration({ optionsJSON: await optionsResponse.json() });
    const verifyResponse = await fetch('/api/auth/passkey/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse, inviteToken }) });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Invite registration failed')}`);
    setInviteToken('');
    const url = new URL(window.location.href); url.search = ''; window.history.replaceState({}, '', url.toString());
    setStatus('✅ Passkey registered. Sign in now.');
  };

  const loginWithPasskey = async () => {
    const challenge = await fetch('/api/auth/passkey/authentication-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!challenge.ok) return setStatus(`❌ ${await readErrorMessage(challenge, 'Failed to load authentication options')}`);
    const assertion = await startAuthentication({ optionsJSON: await challenge.json() });
    const verify = await fetch('/api/auth/passkey/verify-authentication', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(assertion) });
    if (!verify.ok) return setStatus(`❌ ${await readErrorMessage(verify, 'Passkey verification failed')}`);
    setUser((await verify.json() as { user: SessionUser }).user);
  };

  const loadAdminUsers = async () => { const r = await fetch('/api/admin/users', { credentials: 'include' }); if (r.ok) setAdminUsers((await r.json() as { users: AdminUser[] }).users); };
  const createAdminUser = async () => { const r = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: newUserEmail, role: newUserRole }) }); if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to create user')}`); setNewUserEmail(''); await loadAdminUsers(); };
  const createInvite = async () => { const r = await fetch('/api/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: newUserEmail, role: newUserRole, ttlMinutes: 120 }) }); if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to create invite')}`); setInviteUrl((await r.json() as InvitePayload).inviteUrl); };

  const accent = {
    cyan: { chip: 'bg-cyan-400/20 text-cyan-200', btn: 'bg-cyan-400 text-slate-900 hover:bg-cyan-300', border: 'border-cyan-400/40' },
    violet: { chip: 'bg-violet-400/20 text-violet-200', btn: 'bg-violet-400 text-slate-900 hover:bg-violet-300', border: 'border-violet-400/40' },
    emerald: { chip: 'bg-emerald-400/20 text-emerald-200', btn: 'bg-emerald-400 text-slate-900 hover:bg-emerald-300', border: 'border-emerald-400/40' },
    rose: { chip: 'bg-rose-400/20 text-rose-200', btn: 'bg-rose-400 text-slate-900 hover:bg-rose-300', border: 'border-rose-400/40' },
  }[accent];

  const shellBg = theme === 'light' ? 'bg-gradient-to-br from-violet-200 to-slate-100 text-slate-900' : 'bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100';
  const glass = theme === 'light' ? 'bg-white/65 border-slate-200' : 'bg-white/5 border-white/10';

  if (!setup) return <main className={`min-h-screen ${shellBg} p-10`}>Loading…</main>;

  if (!setup.completed) return <main className={`min-h-screen ${shellBg} p-8`}><section className={`mx-auto max-w-xl rounded-3xl border p-8 shadow-2xl backdrop-blur-2xl ${glass}`}><h1 className="text-3xl font-semibold">Setup Wizard</h1><p className="mt-2 text-sm opacity-80">Step {step}/5</p><div className="mt-6 space-y-3">{/* simplified existing flow */}<input className="w-full rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" placeholder="Root email" value={email} onChange={(e)=>setEmail(e.target.value)} />{step===1&&<button className={`w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={startSetup}>Create root user</button>}{step===2&&<button className={`w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={registerRootPasskey}>Register root passkey</button>}{step===3&&<button className={`w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={generateBackupPassword}>Generate backup password</button>}{step===4&&<><p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">Save this password: <strong>{backupPassword}</strong></p><button className={`w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={acknowledgePassword}>I saved it</button></>}{step===5&&<><input className="w-full rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" placeholder="Dashboard name" value={dashboardName} onChange={(e)=>setDashboardName(e.target.value)} /><div className="grid grid-cols-2 gap-2"><select className="rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" value={theme} onChange={(e)=>setTheme(e.target.value as 'dark'|'light')}><option value="dark">Dark</option><option value="light">Light</option></select><select className="rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" value={accent} onChange={(e)=>setAccent(e.target.value as Accent)}><option value="cyan">Cyan</option><option value="violet">Violet</option><option value="emerald">Emerald</option><option value="rose">Rose</option></select></div><button className={`w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={completeSetup}>Finish setup</button></>}{status && <p className="text-sm">{status}</p>}</div></section></main>;

  if (!user && inviteToken) return <main className={`min-h-screen ${shellBg} flex items-center justify-center p-8`}><section className={`w-full max-w-md rounded-3xl border p-8 shadow-2xl backdrop-blur-2xl ${glass}`}><h1 className="text-2xl font-semibold">Accept invite</h1><p className="mt-2 text-sm opacity-80">Register your passkey to activate your account.</p><input className="mt-4 w-full rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" value={email} onChange={(e)=>setEmail(e.target.value)} /><button className={`mt-4 w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={registerViaInvite}>Register passkey</button>{status&&<p className="mt-3 text-sm">{status}</p>}</section></main>;

  if (!user) return <main className={`min-h-screen ${shellBg} flex items-center justify-center p-8`}><section className={`w-full max-w-md rounded-3xl border p-8 shadow-2xl backdrop-blur-2xl ${glass}`}><h1 className="text-3xl font-semibold">Sign in</h1><p className="mt-2 text-sm opacity-80">Use your passkey.</p><input className="mt-4 w-full rounded-xl border border-slate-400/30 bg-transparent px-4 py-3" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="you@domain.com" /><button className={`mt-4 w-full rounded-xl px-4 py-3 font-semibold ${accent.btn}`} onClick={loginWithPasskey}>Sign in</button>{status&&<p className="mt-3 text-sm">{status}</p>}</section></main>;

  return (
    <main className={`min-h-screen ${shellBg} p-6`}>
      <div className={`mx-auto max-w-7xl rounded-3xl border p-4 shadow-2xl backdrop-blur-2xl ${glass}`}>
        <header className="mb-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-xl">
          <h1 className="text-2xl font-semibold">{dashboardName}</h1>
          <button onClick={()=>setActiveTab('settings')} className="h-11 w-11 overflow-hidden rounded-full border border-white/20 bg-white/10">{user.avatarUrl ? <img src={user.avatarUrl} alt="avatar" /> : <span>{user.email[0].toUpperCase()}</span>}</button>
        </header>
        <div className="grid grid-cols-12 gap-4">
          <aside className="col-span-12 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-xl md:col-span-2">
            {(['dashboard','admin','settings'] as const).filter(t=>t!=='admin'||user.role==='root'||user.role==='admin').map((t)=><button key={t} className={`mb-2 w-full rounded-xl px-3 py-2 text-left ${activeTab===t ? accent.chip : 'hover:bg-white/10'}`} onClick={()=>{setActiveTab(t); if (t==='admin') void loadAdminUsers();}}>{t[0].toUpperCase()+t.slice(1)}</button>)}
          </aside>
          <section className="col-span-12 md:col-span-10">
            {activeTab==='dashboard' && <div className="grid gap-4 md:grid-cols-3">{['Weather','Energy','Devices','Scenes','Security','Music'].map((k)=><div key={k} className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-xl"><p className="text-sm opacity-70">{k}</p><p className="mt-3 text-2xl font-semibold">Demo</p></div>)}</div>}
            {activeTab==='settings' && <div className="rounded-2xl border border-white/10 bg-white/10 p-5 backdrop-blur-xl"><h2 className="text-xl font-semibold">User Settings</h2><p className="mt-2 text-sm opacity-80">{user.email} • {user.role}</p></div>}
            {activeTab==='admin' && <div className="space-y-4"><div className="rounded-2xl border border-white/10 bg-white/10 p-5 backdrop-blur-xl"><h2 className="text-xl font-semibold">Add user</h2><div className="mt-3 grid gap-2 md:grid-cols-4"><input className="rounded-xl border border-white/20 bg-transparent px-3 py-2" placeholder="user@email.com" value={newUserEmail} onChange={(e)=>setNewUserEmail(e.target.value)} /><select className="rounded-xl border border-white/20 bg-transparent px-3 py-2" value={newUserRole} onChange={(e)=>setNewUserRole(e.target.value as Role)}><option value="admin">Admin</option><option value="user">User</option><option value="readonly">Readonly</option></select><button className={`rounded-xl px-3 py-2 font-semibold ${accent.btn}`} onClick={createAdminUser}>Create direct</button><button className="rounded-xl border border-white/20 px-3 py-2" onClick={createInvite}>Create invite</button></div>{inviteUrl&&<p className="mt-3 break-all rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-2 text-xs">{inviteUrl}</p>}</div><div className="rounded-2xl border border-white/10 bg-white/10 p-5 backdrop-blur-xl"><h2 className="text-xl font-semibold">Users</h2><ul className="mt-3 space-y-2">{adminUsers.map(u=><li key={u.id} className="rounded-xl border border-white/10 bg-white/5 p-2 text-sm">{u.email} • {u.role} • {u.hasPasskey?'passkey':'no passkey'}</li>)}</ul></div></div>}
          </section>
        </div>
      </div>
    </main>
  );
}
