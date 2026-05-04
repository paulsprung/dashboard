import { NextResponse } from 'next/server';
import { env, verifyAuthenticationResponse, consumeChallenge } from '@/lib/webauthn';
import { prisma } from '@/lib/prisma';
import { createSession, writeAudit } from '@/lib/auth';

export async function POST(req: Request) {
  const credential = await req.json();
  const found = await consumeChallenge('AUTHENTICATION', credential.response.clientDataJSON ? JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString()).challenge : '');
  if (!found) return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });
  const passkey = await prisma.passkey.findUnique({ where: { credentialId: credential.id }, include: { user: true } });
  if (!passkey || passkey.user.disabled) return NextResponse.json({ error: 'No passkey' }, { status: 404 });
  const v = await verifyAuthenticationResponse({ response: credential, expectedChallenge: found.challenge, expectedOrigin: env.origin, expectedRPID: env.rpID, credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64'), counter: passkey.counter, transports: passkey.transports as any } });
  if (!v.verified) { await writeAudit('auth.login', 'FAILED', { userId: passkey.userId }); return NextResponse.json({ error: 'verification failed' }, { status: 400 }); }
  await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() } });
  await createSession(passkey.userId);
  await writeAudit('auth.login', 'SUCCESS', { userId: passkey.userId });
  return NextResponse.json({ ok: true });
}
