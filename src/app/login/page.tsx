import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { sessionCookie, verifySessionToken } from '@/lib/session';

export default async function LoginPage() {
  const session = (await cookies()).get(sessionCookie.name)?.value;

  if (session && (await verifySessionToken(session))) {
    redirect('/');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
