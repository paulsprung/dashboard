import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env, generateRegistrationOptions, saveChallenge } from '@/lib/webauthn';

export async function POST(req: Request) {
  const existing = await prisma.user.count();
  if (existing > 0) return NextResponse.json({ error: 'Setup disabled' }, { status: 403 });
  const { username, displayName } = await req.json();
  const opts = await generateRegistrationOptions({ rpName: env.rpName, rpID: env.rpID, userName: username, userDisplayName: displayName, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
  await saveChallenge('REGISTRATION', opts.challenge);
  return NextResponse.json(opts);
}
