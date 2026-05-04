import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { LoginPasskeyButton } from '@/components/PasskeyButtons';

export default async function LoginPage() {
  const hasUser = (await prisma.user.count()) > 0;
  return <main className="min-h-screen flex items-center justify-center p-6"><div className="glass rounded-2xl p-8 w-full max-w-md space-y-4"><h1 className="text-2xl font-bold">shyy.dev Dashboard</h1><LoginPasskeyButton />{!hasUser && <Link href="/setup" className="block text-accent">Initial Setup</Link>}</div></main>;
}
