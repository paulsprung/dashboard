import { NextResponse } from 'next/server';
import { createSessionToken, sessionCookie } from '@/lib/session';
import { loginSchema, verifyCredentials } from '@/lib/auth';

// Ready for future expansion: add passkey assertion verifier in this auth controller.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const isValid = await verifyCredentials(parsed.data);

  if (!isValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await createSessionToken({
    sub: parsed.data.username,
    username: parsed.data.username,
    authMethods: ['password']
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, token, sessionCookie.options);
  return response;
}
