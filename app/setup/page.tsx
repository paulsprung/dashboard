'use client';
import { useState } from 'react';
import { SetupPasskeyButton } from '@/components/PasskeyButtons';

export default function SetupPage() {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  return <main className="min-h-screen flex items-center justify-center p-6"><div className="glass rounded-2xl p-8 w-full max-w-md space-y-4"><h1 className="text-2xl font-bold">Initial Owner Setup</h1><input className="w-full p-2 rounded bg-zinc-900" placeholder="username" value={username} onChange={(e)=>setUsername(e.target.value)} /><input className="w-full p-2 rounded bg-zinc-900" placeholder="display name" value={displayName} onChange={(e)=>setDisplayName(e.target.value)} /><SetupPasskeyButton username={username} displayName={displayName} /></div></main>;
}
