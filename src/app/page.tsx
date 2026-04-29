import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/DashboardShell';
import { sessionCookie, verifySessionToken } from '@/lib/session';

export default async function DashboardPage() {
  const token = (await cookies()).get(sessionCookie.name)?.value;

  if (!token) {
    redirect('/login');
  }

  const session = await verifySessionToken(token);

  if (!session) {
    redirect('/login');
  }

  return <DashboardShell username={session.username} />;
}
