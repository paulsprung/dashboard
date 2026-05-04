import { NextResponse } from 'next/server';
import { env, verifyRegistrationResponse, consumeChallenge } from '@/lib/webauthn';
import { prisma } from '@/lib/prisma';
import { createSession, writeAudit } from '@/lib/auth';

export async function POST(req: Request) {
  const existing = await prisma.user.count();
  if (existing > 0) return NextResponse.json({ error: 'Setup disabled' }, { status: 403 });
  const { credential, username, displayName } = await req.json();
  const found = await consumeChallenge('REGISTRATION', credential.response.clientDataJSON ? JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString()).challenge : '');
  if (!found) return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });
  const verification = await verifyRegistrationResponse({ response: credential, expectedChallenge: found.challenge, expectedOrigin: env.origin, expectedRPID: env.rpID });
  if (!verification.verified || !verification.registrationInfo) return NextResponse.json({ error: 'verification failed' }, { status: 400 });
  const user = await prisma.user.create({ data: { username, displayName, role: 'OWNER' } });
  await prisma.passkey.create({ data: { userId: user.id, credentialId: verification.registrationInfo.credential.id, publicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64'), counter: verification.registrationInfo.credential.counter, deviceType: verification.registrationInfo.credentialDeviceType, backedUp: verification.registrationInfo.credentialBackedUp, transports: credential.response.transports ?? [] } });
  await createSession(user.id);
  await writeAudit('auth.register', 'SUCCESS', { userId: user.id });
  return NextResponse.json({ ok: true });
}
