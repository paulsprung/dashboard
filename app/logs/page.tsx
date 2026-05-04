import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function LogsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const logs = await prisma.auditLog.findMany({ take: 100, orderBy: { createdAt: 'desc' }, include: { user: true } });
  return <main className="p-6"><h1 className="text-2xl font-bold mb-4">Audit Logs</h1><div className="glass rounded-xl p-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Status</th></tr></thead><tbody>{logs.map(l=><tr key={l.id}><td>{l.createdAt.toISOString()}</td><td>{l.user?.username ?? '-'}</td><td>{l.action}</td><td>{l.status}</td></tr>)}</tbody></table></div></main>;
}
