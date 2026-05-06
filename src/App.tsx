import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, registrationResponse }),
      });
      if (!verifyResponse.ok) throw new Error(await readErrorMessage(verifyResponse, 'Passkey registration failed'));
      setStatus('✅ Passkey registered. You can now sign in.');
    } catch (error) {
      setStatus(`❌ ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
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
      setStatus('✅ Login successful.');
    } catch (error) {
      setStatus(`❌ ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setStatus('');
  };

  if (user) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <section className="mx-auto max-w-4xl rounded-2xl border border-slate-700 bg-slate-900 p-8">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-cyan-300">Dashboard</p>
              <h1 className="mt-2 text-2xl font-semibold">Hallo, {user.email}</h1>
            </div>
            <button className="rounded-lg border border-slate-600 px-4 py-2 hover:bg-slate-800" onClick={logout} type="button">Logout</button>
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
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-xl">
        <h1 className="text-2xl font-semibold">Sign in with Passkey</h1>
        <p className="mt-2 text-sm text-slate-400">Clean, passwordless login for your dashboard.</p>

        <form className="mt-6 space-y-4" onSubmit={(event) => event.preventDefault()}>
          <label className="block">
            <span className="mb-2 block text-sm text-slate-300">Email</span>
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 outline-none ring-cyan-400 transition focus:ring"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@domain.com"
              type="email"
              value={email}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <button className="rounded-lg border border-slate-600 px-4 py-3 font-medium hover:bg-slate-800 disabled:opacity-60" disabled={isBusy || !email} onClick={registerPasskey} type="button">
              {isBusy ? 'Processing…' : 'Register passkey'}
            </button>
            <button className="rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900 hover:bg-cyan-300 disabled:opacity-60" disabled={isBusy || !email} onClick={loginWithPasskey} type="button">
              {isBusy ? 'Processing…' : 'Sign in'}
            </button>
          </div>

          {status && <p className="text-sm text-slate-300">{status}</p>}
        </form>
      </section>
    </main>
  );
}
