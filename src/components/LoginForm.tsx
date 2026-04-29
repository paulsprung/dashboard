'use client';

import { FormEvent, useState } from 'react';

export function LoginForm() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const payload = {
      username: String(formData.get('username') ?? ''),
      password: String(formData.get('password') ?? '')
    };

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      setError('Invalid credentials. Please check your secure vault entry and try again.');
      setLoading(false);
      return;
    }

    window.location.href = '/';
  };

  return (
    <form onSubmit={onSubmit} className="panel-glass w-full max-w-md space-y-4 p-6">
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-accent">shyy.dev</p>
        <h1 className="mt-2 text-2xl font-semibold">Secure vault login</h1>
        <p className="mt-2 text-sm text-slate-300">Password manager ready. Passkey/WebAuthn expansion hooks are prepared for future rollout.</p>
      </div>

      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-widest text-slate-400">Username</span>
        <input name="username" autoComplete="username" required className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none ring-accent/60 transition focus:ring" />
      </label>

      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-widest text-slate-400">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none ring-accent/60 transition focus:ring" />
      </label>

      {error ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p> : null}

      <button disabled={loading} className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:brightness-95 disabled:opacity-70">
        {loading ? 'Verifying…' : 'Sign in'}
      </button>
    </form>
  );
}
