import { useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type Mode = 'password+passkey' | 'passkey-only';

export default function App() {
  const [mode, setMode] = useState<Mode>('password+passkey');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const registerPasskey = async () => {
    setStatus('Creating registration challenge...');
    setIsBusy(true);

    try {
      const optionsResponse = await fetch('/api/auth/passkey/registration-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!optionsResponse.ok) throw new Error('Failed to load registration options');

      const options = await optionsResponse.json();
      const registrationResponse = await startRegistration({ optionsJSON: options });

      const verifyResponse = await fetch('/api/auth/passkey/verify-registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, registrationResponse }),
      });
      if (!verifyResponse.ok) throw new Error('Passkey registration failed');

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!challengeResponse.ok) {
        throw new Error('Failed to load authentication options');
      }

      const options = await challengeResponse.json();
      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyResponse = await fetch('/api/auth/passkey/verify-authentication', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion),
      });

      if (!verifyResponse.ok) {
        throw new Error('Passkey verification failed');
      }

      setStatus('✅ Login successful. Dashboard access granted.');
    } catch (error) {
      setStatus(`❌ ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-6 text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-grid bg-[size:45px_45px]" />
      <div className="pointer-events-none absolute -top-1/3 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-cyan-500/20 blur-3xl" />

      <section className="relative w-full max-w-md rounded-2xl border border-cyan-300/20 bg-slate-900/70 p-8 shadow-glow backdrop-blur-xl">
        <p className="mb-2 text-xs uppercase tracking-[0.35em] text-cyan-300/80">Personal dashboard</p>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mb-8 text-sm text-slate-300">Register one passkey, then sign in securely.</p>

        <div className="mb-6 flex rounded-lg bg-slate-800 p-1 text-xs">
          <button className={`flex-1 rounded-md px-3 py-2 transition ${mode === 'password+passkey' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400'}`} onClick={() => setMode('password+passkey')} type="button">Password + Passkey</button>
          <button className={`flex-1 rounded-md px-3 py-2 transition ${mode === 'passkey-only' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400'}`} onClick={() => setMode('passkey-only')} type="button">Passkey only</button>
        </div>

        <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
          <label className="block">
            <span className="mb-2 block text-sm text-slate-300">Email</span>
            <input className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 outline-none ring-cyan-400 transition focus:ring" onChange={(event) => setEmail(event.target.value)} placeholder="you@domain.com" type="email" value={email} />
          </label>

          {mode === 'password+passkey' && (
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Password (optional for now)</span>
              <input className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 outline-none ring-cyan-400 transition focus:ring" placeholder="••••••••" type="password" />
            </label>
          )}

          <button className="w-full rounded-lg border border-cyan-400/40 px-4 py-3 font-medium text-cyan-200 transition hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-60" disabled={isBusy || !email} onClick={registerPasskey} type="button">{isBusy ? 'Processing…' : 'Register passkey'}</button>

          <button className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-medium text-slate-900 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60" disabled={isBusy || !email} onClick={loginWithPasskey} type="button">{isBusy ? 'Processing…' : 'Sign in with passkey'}</button>

          {status && <p className="text-sm text-slate-300">{status}</p>}
        </form>
      </section>
    </main>
  );
}
