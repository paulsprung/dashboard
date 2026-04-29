import { PanelStatus } from '@/lib/panels';

const styleByStatus: Record<PanelStatus, string> = {
  online: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/20',
  warning: 'bg-amber-500/20 text-amber-300 border-amber-400/20',
  offline: 'bg-rose-500/20 text-rose-300 border-rose-400/20',
  idle: 'bg-slate-500/20 text-slate-300 border-slate-400/20'
};

export function StatusPill({ status }: { status: PanelStatus }) {
  return <span className={`rounded-full border px-2 py-1 text-xs uppercase tracking-widest ${styleByStatus[status]}`}>{status}</span>;
}
