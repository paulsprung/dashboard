import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type SessionUser = { id: string; email: string };

type SetupStatus = { completed: boolean; dashboardName: string; theme: 'dark' | 'light' };

const readErrorMessage = async (response: Response, fallback: string) => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
};

export default function App() {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [email, setEmail] = useState('');
  const [dashboardName, setDashboardName] = useState('SM Dashboard');
  const [status, setStatus] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [setupStarted, setSetupStarted] = useState(false);

  useEffect(() => {
    const boot = async () => {
      const setupRes = await fetch('/api/setup/status');
      const setupPayload = (await setupRes.json()) as SetupStatus;
      setSetup(setupPayload);

      if (setupPayload.completed) {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
          const payload = (await response.json()) as { user: SessionUser };
          setUser(payload.user);
        }
      }
    };

    void boot();
  }, []);

  const startSetup = async () => {
    const response = await fetch('/api/setup/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootEmail: email, dashboardName, theme: 'dark' }),
    });
    if (!response.ok) return setStatus(`❌ ${await readErrorMessage(response, 'Setup failed')}`);
    const payload = (await response.json()) as { rootBackupPassword: string };
    setBackupPassword(payload.rootBackupPassword);
    setSetupStarted(true);
    setStatus('✅ Setup initialized. Register your root passkey now.');
  };

  const registerRootPasskey = async () => {
    const optionsResponse = await fetch('/api/auth/passkey/registration-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (!optionsResponse.ok) return setStatus(`❌ ${await readErrorMessage(optionsResponse, 'Failed to load registration options')}`);
    const options = await optionsResponse.json();
    const registrationResponse = await startRegistration({ optionsJSON: options });
    const verifyResponse = await fetch('/api/auth/passkey/verify-registration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse }),
    });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Passkey registration failed')}`);

    const complete = await fetch('/api/setup/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (!complete.ok) return setStatus(`❌ ${await readErrorMessage(complete, 'Failed to complete setup')}`);

    setSetup({ completed: true, dashboardName, theme: 'dark' });
    setStatus('✅ Setup completed. Please sign in.');
  };

  const loginWithPasskey = async () => {
    const challengeResponse = await fetch('/api/auth/passkey/authentication-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (!challengeResponse.ok) return setStatus(`❌ ${await readErrorMessage(challengeResponse, 'Failed to load authentication options')}`);
    const options = await challengeResponse.json();
    const assertion = await startAuthentication({ optionsJSON: options });
    const verifyResponse = await fetch('/api/auth/passkey/verify-authentication', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(assertion),
    });
    if (!verifyResponse.ok) return setStatus(`❌ ${await readErrorMessage(verifyResponse, 'Passkey verification failed')}`);
    const payload = (await verifyResponse.json()) as { user: SessionUser };
    setUser(payload.user);
  };

  if (!setup) return <main className="min-h-screen bg-slate-950 p-8 text-slate-100">Loading...</main>;

  if (!setup.completed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8">
          <h1 className="text-2xl font-semibold">Initial Setup</h1>
          <p className="mt-2 text-sm text-slate-400">Create root admin and register root passkey once.</p>
          <div className="mt-4 space-y-3">
            <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="Root email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="Dashboard name" value={dashboardName} onChange={(e) => setDashboardName(e.target.value)} />
            {!setupStarted ? <button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={startSetup} type="button">Start setup</button> : <button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={registerRootPasskey} type="button">Register root passkey & finish</button>}
            {backupPassword && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">Backup admin password (save now): <strong>{backupPassword}</strong></p>}
            {status && <p className="text-sm text-slate-300">{status}</p>}
          </div>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8">
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-slate-400">Use your passkey to access the dashboard.</p>
          <div className="mt-4 space-y-3">
            <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" placeholder="you@domain.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900" onClick={loginWithPasskey} type="button">Sign in</button>
            {status && <p className="text-sm text-slate-300">{status}</p>}
          </div>
        </section>
      </main>
    );
  }

  return <main className="min-h-screen bg-slate-950 p-8 text-slate-100">Welcome {user.email}. Dashboard ready.</main>;
}
