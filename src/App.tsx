import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Mode = 'password+passkey' | 'passkey-only';
type SessionUser = { id: string; email: string };

const readErrorMessage = async (response: Response, fallback: string) => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
};

export default function App() {
  const [mode, setMode] = useState<Mode>('password+passkey');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    const loadSession = async () => {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      if (!response.ok) return;
      const payload = (await response.json()) as { user: SessionUser };
      setUser(payload.user);
    };

    void loadSession();
  }, []);

  const registerPasskey = async () => {
    setStatus('Creating registration challenge...');
    setIsBusy(true);
    try {
      const optionsResponse = await fetch('/api/auth/passkey/registration-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!optionsResponse.ok) throw new Error(await readErrorMessage(optionsResponse, 'Failed to load registration options'));
      const options = await optionsResponse.json();
      const registrationResponse = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch('/api/auth/passkey/verify-registration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, registrationResponse }),
      });
      if (!verifyResponse.ok) throw new Error(await readErrorMessage(verifyResponse, 'Passkey registration failed'));
      setStatus('✅ Passkey registered. You can now sign in.');
    } catch (error) {
      setStatus(`❌ ${(error as Error).message}`);
    } finally { setIsBusy(false); }
  };

  const loginWithPasskey = async () => {
    setStatus('Requesting login challenge...');
    setIsBusy(true);
    try {
      const challengeResponse = await fetch('/api/auth/passkey/authentication-options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      if (!challengeResponse.ok) throw new Error(await readErrorMessage(challengeResponse, 'Failed to load authentication options'));
      const options = await challengeResponse.json();
      const assertion = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch('/api/auth/passkey/verify-authentication', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(assertion),
      });
      if (!verifyResponse.ok) throw new Error(await readErrorMessage(verifyResponse, 'Passkey verification failed'));
      const payload = (await verifyResponse.json()) as { user: SessionUser };
      setUser(payload.user);
      setStatus('✅ Login successful. Dashboard access granted.');
    } catch (error) {
      setStatus(`❌ ${(error as Error).message}`);
    } finally { setIsBusy(false); }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setStatus('');
  };

  if (user) {
    return (
      <main className="relative min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
        <section className="mx-auto max-w-4xl rounded-2xl border border-cyan-300/20 bg-slate-900/70 p-8 shadow-glow backdrop-blur-xl">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">Personal dashboard</p>
              <h1 className="text-3xl font-semibold tracking-tight">Hallo, {user.email}</h1>
            </div>
            <button className="rounded-lg border border-cyan-400/40 px-4 py-2 text-cyan-200 hover:bg-cyan-400/10" onClick={logout} type="button">Logout</button>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {['Umsatz', 'Aktive Nutzer', 'Server Status'].map((item) => (
              <article className="rounded-xl border border-slate-700 bg-slate-950/70 p-4" key={item}>
                <p className="text-sm text-slate-400">{item}</p>
                <p className="mt-2 text-2xl font-semibold text-cyan-200">Demo</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-6 text-slate-100">
      <section className="relative w-full max-w-md rounded-2xl border border-cyan-300/20 bg-slate-900/70 p-8 shadow-glow backdrop-blur-xl">
        <p className="mb-2 text-xs uppercase tracking-[0.35em] text-cyan-300/80">Personal dashboard</p>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mb-8 text-sm text-slate-300">Register one passkey, then sign in securely.</p>
        <div className="mb-6 flex rounded-lg bg-slate-800 p-1 text-xs">
          <button className={`flex-1 rounded-md px-3 py-2 transition ${mode === 'password+passkey' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400'}`} onClick={() => setMode('password+passkey')} type="button">Password + Passkey</button>
          <button className={`flex-1 rounded-md px-3 py-2 transition ${mode === 'passkey-only' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400'}`} onClick={() => setMode('passkey-only')} type="button">Passkey only</button>
        </div>
        <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
          <input className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 outline-none ring-cyan-400 transition focus:ring" onChange={(event) => setEmail(event.target.value)} placeholder="you@domain.com" type="email" value={email} />
          {mode === 'password+passkey' && <input className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3" placeholder="••••••••" type="password" />}
          <button className="w-full rounded-lg border border-cyan-400/40 px-4 py-3 font-medium text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60" disabled={isBusy || !email} onClick={registerPasskey} type="button">{isBusy ? 'Processing…' : 'Register passkey'}</button>
          <button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900 hover:bg-cyan-300 disabled:opacity-60" disabled={isBusy || !email} onClick={loginWithPasskey} type="button">{isBusy ? 'Processing…' : 'Sign in with passkey'}</button>
          {status && <p className="text-sm text-slate-300">{status}</p>}
        </form>
      </section>
    </main>
  );
}
