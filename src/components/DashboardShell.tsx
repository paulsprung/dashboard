'use client';

import { useState } from 'react';
import { dashboardPanels, quickActions, activityMock } from '@/lib/panels';
import { PanelCard } from './PanelCard';
import { ActionButton } from './ActionButton';

const sidebarLinks = ['Overview', 'Infrastructure', 'Automation', 'Storage', 'Access'];

export function DashboardShell({ username }: { username: string }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logout = async () => {
    setIsLoggingOut(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px] gap-4 p-4 md:p-6">
      <aside className="panel-glass hidden w-64 shrink-0 p-5 lg:block">
        <p className="text-xs uppercase tracking-[0.3em] text-accent">shyy.dev</p>
        <h1 className="mt-2 text-xl font-semibold">Homelab Control</h1>
        <nav className="mt-8 space-y-2">
          {sidebarLinks.map((item) => (
            <button key={item} className="w-full rounded-xl border border-transparent px-3 py-2 text-left text-sm text-slate-300 transition hover:border-white/15 hover:bg-white/5 hover:text-white">
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 space-y-4">
        <header className="panel-glass flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Control Plane</p>
            <h2 className="text-lg font-semibold">Default Operations Panel</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">All systems monitored</span>
            <span className="text-sm text-slate-300">{username}</span>
            <button onClick={logout} disabled={isLoggingOut} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-sm text-slate-200 transition hover:bg-white/10 disabled:opacity-70">
              {isLoggingOut ? 'Signing out...' : 'Logout'}
            </button>
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="grid gap-4 md:grid-cols-2">
            {dashboardPanels.map((panel) => (
              <PanelCard key={panel.id} panel={panel} />
            ))}
          </div>

          <div className="space-y-4">
            <section className="panel-glass p-5">
              <h3 className="text-sm font-semibold">Quick Actions</h3>
              <p className="mb-4 mt-1 text-xs text-slate-400">Prepared command surface with safe mock actions.</p>
              <div className="space-y-2">
                {quickActions.map((action) => (
                  <ActionButton key={action.id} actionId={action.id} label={action.label} hint={action.hint} intent={action.intent} />
                ))}
              </div>
            </section>

            <section className="panel-glass p-5">
              <h3 className="text-sm font-semibold">Activity / Audit Log</h3>
              <ul className="mt-3 space-y-2 text-sm text-slate-300">
                {activityMock.map((entry) => (
                  <li key={entry} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">{entry}</li>
                ))}
              </ul>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
