'use client';

import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

export function LoginForm() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onPasskeyLogin = async () => {
    setError('');
    setLoading(true);

    try {
      const optionsResponse = await fetch('/api/auth/passkey/options', { method: 'POST' });
      if (!optionsResponse.ok) throw new Error('Could not initialize passkey challenge');
      const options = await optionsResponse.json();
      const credential = await startAuthentication(options);

      const verifyResponse = await fetch('/api/auth/passkey/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: credential })
      });

      if (!verifyResponse.ok) {
        throw new Error('Passkey verification failed');
      }

      window.location.href = '/';
    } catch {
      setError('Passkey login failed. Check your registered authenticator and try again.');
      setLoading(false);
    }
  };

  return (
    <div className="panel-glass w-full max-w-md space-y-4 p-6">
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-accent">shyy.dev</p>
        <h1 className="mt-2 text-2xl font-semibold">Secure vault login</h1>
        <p className="mt-2 text-sm text-slate-300">Passkey-first authentication is enabled. Password manager readiness is kept for emergency fallback workflows.</p>
      </div>

      {error ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p> : null}

      <button onClick={onPasskeyLogin} disabled={loading} className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:brightness-95 disabled:opacity-70">
        {loading ? 'Waiting for authenticator…' : 'Sign in with Passkey'}
      </button>
    </div>
  );
}
