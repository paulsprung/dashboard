import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { env } from './env';
import { prisma } from './prisma';

export async function saveChallenge(type: 'REGISTRATION' | 'AUTHENTICATION', challenge: string, userId?: string) {
  await prisma.challenge.create({ data: { type, challenge, userId, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
}

export async function consumeChallenge(type: 'REGISTRATION' | 'AUTHENTICATION', challenge: string, userId?: string) {
  const c = await prisma.challenge.findFirst({ where: { type, challenge, userId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  if (!c) return null;
  await prisma.challenge.delete({ where: { id: c.id } });
  return c;
}

export { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, env };
