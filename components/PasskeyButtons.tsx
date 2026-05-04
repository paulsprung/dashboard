'use client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export function LoginPasskeyButton() {
  const run = async () => {
    const o = await fetch('/api/auth/login/options', { method: 'POST' }).then((r) => r.json());
    const credential = await startAuthentication({ optionsJSON: o });
    const v = await fetch('/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credential) });
    if (v.ok) location.href = '/dashboard'; else alert('Login failed');
  };
  return <button className="px-4 py-2 rounded bg-accent text-black font-semibold" onClick={run}>Login with Passkey</button>;
}

export function SetupPasskeyButton({ username, displayName }: { username: string; displayName: string }) {
  const run = async () => {
    const o = await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName }) }).then((r) => r.json());
    const credential = await startRegistration({ optionsJSON: o });
    const v = await fetch('/api/auth/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, username, displayName }) });
    if (v.ok) location.href = '/dashboard'; else alert('Setup failed');
  };
  return <button className="px-4 py-2 rounded bg-accent text-black font-semibold" onClick={run}>Create Owner & Register Passkey</button>;
}
