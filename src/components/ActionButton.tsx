'use client';

type ActionButtonProps = {
  label: string;
  hint: string;
  intent?: 'primary' | 'danger';
  actionId: string;
};

export function ActionButton({ label, hint, intent, actionId }: ActionButtonProps) {
  const style =
    intent === 'danger'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
      : intent === 'primary'
        ? 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/20'
        : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10';

  const handleAction = () => {
    console.info(`[mock-action] ${actionId}`);
  };

  return (
    <button onClick={handleAction} className={`w-full rounded-xl border px-3 py-2 text-left transition ${style}`}>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-slate-400">{hint}</p>
    </button>
  );
}
