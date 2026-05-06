import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Role = 'root' | 'admin' | 'user' | 'readonly';
type SessionUser = { id: string; email: string; role: Role; avatarUrl?: string };
type Accent = 'cyan' | 'violet' | 'emerald' | 'rose';
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
    if (invite) {
      setInviteToken(invite);
      if (invitedEmail) setEmail(invitedEmail);
    }

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
    const options = await optionsResponse.json();
    const registrationResponse = await startRegistration({ optionsJSON: options });
    const verifyResponse = await fetch('/api/auth/passkey/verify-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse }) });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Passkey registration failed')}`);
    setStep(3); setStatus('✅ Root passkey registered.');
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
    if (!inviteToken) return;
    const optionsResponse = await fetch('/api/auth/passkey/registration-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, inviteToken }),
    });
    if (!optionsResponse.ok) return setStatus(`❌ ${await readErrorMessage(optionsResponse, 'Failed to load registration options')}`);
    const options = await optionsResponse.json();
    const registrationResponse = await startRegistration({ optionsJSON: options });
    const verifyResponse = await fetch('/api/auth/passkey/verify-registration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse, inviteToken }),
    });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Invite registration failed')}`);
    setStatus('✅ Passkey registered. You can sign in now.');
    setInviteToken('');
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState({}, '', url.toString());
  };

  const loginWithPasskey = async () => {
    const challenge = await fetch('/api/auth/passkey/authentication-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!challenge.ok) return setStatus(`❌ ${await readErrorMessage(challenge, 'Failed to load authentication options')}`);
    const assertion = await startAuthentication({ optionsJSON: await challenge.json() });
    const verify = await fetch('/api/auth/passkey/verify-authentication', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(assertion) });
    if (!verify.ok) return setStatus(`❌ ${await readErrorMessage(verify, 'Passkey verification failed')}`);
    setUser((await verify.json() as { user: SessionUser }).user);
  };

  const loadAdminUsers = async () => {
    const r = await fetch('/api/admin/users', { credentials: 'include' });
    if (r.ok) setAdminUsers((await r.json() as { users: AdminUser[] }).users);
  };

  const createAdminUser = async () => {
    const r = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: newUserEmail, role: newUserRole }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to create user')}`);
    setNewUserEmail(''); setNewUserRole('user'); await loadAdminUsers();
  };


  const createInvite = async () => {
    const r = await fetch('/api/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: newUserEmail, role: newUserRole, ttlMinutes: 120 }) });
    if (!r.ok) return setStatus(`❌ ${await readErrorMessage(r, 'Failed to create invite')}`);
    const payload = (await r.json()) as InvitePayload;
    setInviteUrl(payload.inviteUrl);
  };

  if (!setup) return <main className="min-h-screen bg-slate-950 p-8 text-slate-100">Loading...</main>;

  if (!setup.completed) return <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><section className="mx-auto max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-8"><h1 className="text-2xl font-semibold">Setup Wizard</h1><p className="mt-2 text-slate-400">Step {step}/5</p><div className="mt-4 space-y-3">{step===1&&<><input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="Root email" value={email} onChange={(e)=>setEmail(e.target.value)} /><button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={startSetup}>Create root user</button></>}{step===2&&<button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={registerRootPasskey}>Register root passkey</button>}{step===3&&<button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={generateBackupPassword}>Generate backup password</button>}{step===4&&<><p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">Save this now: <strong>{backupPassword}</strong></p><button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={acknowledgePassword}>I stored it safely</button></>}{step===5&&<><input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="Dashboard name" value={dashboardName} onChange={(e)=>setDashboardName(e.target.value)} /><select className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" value={theme} onChange={(e)=>setTheme(e.target.value as 'dark'|'light')}><option value="dark">Dark</option><option value="light">Light</option></select><select className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" value={accent} onChange={(e)=>setAccent(e.target.value as Accent)}><option value="cyan">Cyan (soft)</option><option value="violet">Violet (soft)</option><option value="emerald">Emerald (soft)</option><option value="rose">Rose (soft)</option></select><button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={completeSetup}>Finish setup</button></>}</div>{status&&<p className="mt-4 text-sm text-slate-300">{status}</p>}</section></main>;


  if (!user && inviteToken) return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-slate-100"><section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8"><h1 className="text-2xl font-semibold">Complete account setup</h1><p className="mt-2 text-sm text-slate-400">You were invited. Register your passkey to activate your account.</p><input className="mt-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="you@domain.com" value={email} onChange={(e)=>setEmail(e.target.value)} /><button className="mt-3 w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={registerViaInvite}>Register passkey</button>{status&&<p className="mt-3 text-sm">{status}</p>}</section></main>;

  if (!user) return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-slate-100"><section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8"><h1 className="text-2xl font-semibold">Sign in</h1><input className="mt-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="you@domain.com" value={email} onChange={(e)=>setEmail(e.target.value)} /><button className="mt-3 w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={loginWithPasskey}>Sign in</button>{status&&<p className="mt-3 text-sm">{status}</p>}</section></main>;

  const accentClasses: Record<Accent, string> = { cyan: 'text-cyan-300', violet: 'text-violet-300', emerald: 'text-emerald-300', rose: 'text-rose-300' };
  const accentBgClasses: Record<Accent, string> = { cyan: 'bg-cyan-400 text-slate-900', violet: 'bg-violet-400 text-slate-900', emerald: 'bg-emerald-400 text-slate-900', rose: 'bg-rose-400 text-slate-900' };

  return (
    <main className={`min-h-screen ${theme === 'light' ? 'bg-slate-100 text-slate-900' : 'bg-slate-950 text-slate-100'}`}>
      <header className={`flex items-center justify-between border-b px-6 py-4 ${theme === 'light' ? 'border-slate-300 bg-white/70' : 'border-slate-800'}`}><h1 className={`text-xl font-semibold ${accentClasses[accent]}`}>{dashboardName}</h1><button onClick={()=>setActiveTab('settings')} className="h-10 w-10 overflow-hidden rounded-full border border-slate-600">{user.avatarUrl ? <img alt="avatar" src={user.avatarUrl} /> : <span className="text-sm">{user.email.slice(0,1).toUpperCase()}</span>}</button></header>
      <div className="flex"><aside className={`w-56 border-r p-4 ${theme === 'light' ? 'border-slate-300 bg-white/70' : 'border-slate-800'}`}><button className="mb-2 block w-full rounded px-3 py-2 text-left hover:bg-slate-800" onClick={()=>setActiveTab('dashboard')}>Dashboard</button>{(user.role==='root'||user.role==='admin')&&<button className="mb-2 block w-full rounded px-3 py-2 text-left hover:bg-slate-800" onClick={()=>{setActiveTab('admin'); void loadAdminUsers();}}>Admin</button>}<button className="block w-full rounded px-3 py-2 text-left hover:bg-slate-800" onClick={()=>setActiveTab('settings')}>User Settings</button></aside>
      <section className="flex-1 p-6">{activeTab==='dashboard'&&<div className="grid gap-4 md:grid-cols-3">{['Umsatz','Aktive Nutzer','System Status'].map((c)=><div key={c} className="rounded-xl border border-slate-700 bg-slate-900 p-4"><p className="text-slate-400">{c}</p><p className="mt-2 text-2xl font-semibold text-cyan-200">Demo</p></div>)}</div>}{activeTab==='settings'&&<div className="rounded-xl border border-slate-700 bg-slate-900 p-4"><h2 className="text-lg font-semibold">User Settings</h2><p className="mt-2 text-sm text-slate-400">Email: {user.email}</p><p className="text-sm text-slate-400">Role: {user.role}</p></div>}{activeTab==='admin'&&<div className="space-y-4"><div className="rounded-xl border border-slate-700 bg-slate-900 p-4"><h2 className="text-lg font-semibold">Create User</h2><div className="mt-3 grid gap-2 md:grid-cols-3"><input className="rounded border border-slate-700 bg-slate-950 px-3 py-2" placeholder="user@email.com" value={newUserEmail} onChange={(e)=>setNewUserEmail(e.target.value)} /><select className="rounded border border-slate-700 bg-slate-950 px-3 py-2" value={newUserRole} onChange={(e)=>setNewUserRole(e.target.value as Role)}><option value="admin">Admin</option><option value="user">User</option><option value="readonly">Readonly</option></select><div className="flex gap-2"><button className={`rounded px-3 py-2 font-medium ${accentBgClasses[accent]}`} onClick={createAdminUser}>Create direct</button><button className="rounded border border-slate-600 px-3 py-2" onClick={createInvite}>Create invite</button></div>{inviteUrl && <p className="mt-3 rounded border border-emerald-600/40 bg-emerald-600/10 p-2 text-xs break-all">Invite link: {inviteUrl}</p>}</div></div><div className="rounded-xl border border-slate-700 bg-slate-900 p-4"><h2 className="text-lg font-semibold">Users</h2><ul className="mt-2 space-y-2">{adminUsers.map((u)=><li key={u.id} className="rounded border border-slate-700 p-2 text-sm">{u.email} — {u.role} {u.hasPasskey ? '• passkey' : '• no passkey'}</li>)}</ul></div></div>}</section></div>
    </main>
  );
}
