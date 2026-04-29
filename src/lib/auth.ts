import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { AuthenticatorDevice } from '@simplewebauthn/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

export const passkeyVerifySchema = z.object({
  response: z.unknown()
});

export type LoginInput = z.infer<typeof loginSchema>;

function getRawHashFromDotEnv(): string | null {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return null;
    const file = fs.readFileSync(envPath, 'utf8');
    const line = file.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('ADMIN_PASSWORD_HASH='));
    if (!line) return null;
    const value = line.slice('ADMIN_PASSWORD_HASH='.length).trim();
    return value.replace(/^['"]|['"]$/g, '');
  } catch {
    return null;
  }
}

function normalizeBcryptHash(rawHash: string): string {
  const trimmed = rawHash.trim();
  if (trimmed.startsWith('$2a$') || trimmed.startsWith('$2b$') || trimmed.startsWith('$2y$')) return trimmed;
  const rawFromFile = getRawHashFromDotEnv();
  if (rawFromFile && (rawFromFile.startsWith('$2a$') || rawFromFile.startsWith('$2b$') || rawFromFile.startsWith('$2y$'))) return rawFromFile;
  if (/^[./A-Za-z0-9]{53}$/.test(trimmed)) return `$2a$12$${trimmed}`;
  return trimmed;
}

export async function verifyCredentials(input: LoginInput): Promise<boolean> {
  const adminUser = process.env.ADMIN_USER;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminUser || !passwordHash) throw new Error('Missing ADMIN_USER or ADMIN_PASSWORD_HASH environment configuration');

  const expectedUser = adminUser.trim();
  const expectedHash = normalizeBcryptHash(passwordHash);
  const providedUser = input.username.trim();

  if (providedUser !== expectedUser) return false;
  return await bcrypt.compare(input.password, expectedHash);
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function getPasskeyConfig() {
  const rpID = process.env.PASSKEY_RP_ID;
  const origin = process.env.PASSKEY_RP_ORIGIN;
  const credentialID = process.env.PASSKEY_CREDENTIAL_ID_B64URL;
  const publicKey = process.env.PASSKEY_PUBLIC_KEY_B64URL;
  const counter = Number(process.env.PASSKEY_COUNTER ?? '0');

  if (!rpID || !origin || !credentialID || !publicKey) {
    throw new Error('Passkey env vars are missing');
  }

  const authenticator: AuthenticatorDevice = {
    credentialID: decodeBase64Url(credentialID),
    credentialPublicKey: decodeBase64Url(publicKey),
    counter,
    transports: ['internal']
  };

  return { rpID, origin, authenticator };
}

export async function createPasskeyOptions() {
  const { rpID, authenticator } = getPasskeyConfig();

  return await generateAuthenticationOptions({
    rpID,
    allowCredentials: [{ id: authenticator.credentialID, type: 'public-key', transports: authenticator.transports }],
    userVerification: 'preferred'
  });
}

export async function verifyPasskeyAuthentication(response: unknown, expectedChallenge: string): Promise<boolean> {
  const { rpID, origin, authenticator } = getPasskeyConfig();

  const verification = await verifyAuthenticationResponse({
    response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    authenticator
  });

  return verification.verified;
}
