import { DashboardPanel } from '@/lib/panels';
import { StatusPill } from './StatusPill';

export function PanelCard({ panel }: { panel: DashboardPanel }) {
  return (
    <article className="panel-glass p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{panel.title}</h3>
        <StatusPill status={panel.status} />
      </div>
      <p className="text-sm text-slate-300">{panel.description}</p>
      <p className="mt-3 text-lg font-semibold text-accent">{panel.metric}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {panel.tags.map((tag) => (
          <span key={tag} className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300">
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}
