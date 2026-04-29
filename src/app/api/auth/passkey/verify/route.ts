import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { passkeyVerifySchema, verifyPasskeyAuthentication } from '@/lib/auth';
import { createSessionToken, sessionCookie } from '@/lib/session';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = passkeyVerifySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const challenge = (await cookies()).get('pk_challenge')?.value;

  if (!challenge) {
    return NextResponse.json({ error: 'Missing challenge' }, { status: 400 });
  }

  const ok = await verifyPasskeyAuthentication(parsed.data.response, challenge);

  if (!ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const username = process.env.ADMIN_USER ?? 'admin';
  const token = await createSessionToken({ sub: username, username, authMethods: ['passkey'] });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, token, sessionCookie.options);
  response.cookies.set('pk_challenge', '', { path: '/', maxAge: 0 });
  return response;
}
