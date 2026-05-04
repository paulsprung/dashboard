import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env, generateAuthenticationOptions, saveChallenge } from '@/lib/webauthn';

export async function POST() {
  const passkeys = await prisma.passkey.findMany();
  const options = await generateAuthenticationOptions({ rpID: env.rpID, userVerification: 'required', allowCredentials: passkeys.map((p) => ({ id: p.credentialId, type: 'public-key' as const })) });
  await saveChallenge('AUTHENTICATION', options.challenge);
  return NextResponse.json(options);
}
