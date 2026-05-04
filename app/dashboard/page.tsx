import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const logs = await prisma.auditLog.findMany({ take: 8, orderBy: { createdAt: 'desc' } });
  const cards = ['TeamSpeak Server', 'Homeserver', 'Proxmox / VMs', 'Cloud Storage'];
  return <main className="p-6 space-y-4"><h1 className="text-3xl font-bold">Dashboard</h1><div className="grid md:grid-cols-2 gap-4">{cards.map((c)=><section key={c} className="glass rounded-xl p-4"><h2 className="text-lg text-accent">{c}</h2><p className="text-sm text-zinc-400">No data yet.</p></section>)}</div><section className="glass rounded-xl p-4"><h2 className="text-lg text-accent">Recent Audit Logs</h2>{logs.length===0 ? <p className="text-zinc-400">No logs yet.</p> : <ul>{logs.map(l=><li key={l.id}>{l.action} - {l.status}</li>)}</ul>}</section></main>;
}
