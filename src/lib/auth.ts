import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

export type LoginInput = z.infer<typeof loginSchema>;

function normalizeBcryptHash(rawHash: string): string {
  const trimmed = rawHash.trim();

  if (trimmed.startsWith('$2a$') || trimmed.startsWith('$2b$') || trimmed.startsWith('$2y$')) {
    return trimmed;
  }

  // Fallback for .env loaders that expanded "$2a$12$..." by interpreting "$..." segments.
  // If only the 53-char bcrypt payload remains, restore a safe default prefix.
  if (/^[./A-Za-z0-9]{53}$/.test(trimmed)) {
    return `$2a$12$${trimmed}`;
  }

  return trimmed;
}

export async function verifyCredentials(input: LoginInput): Promise<boolean> {
  const adminUser = process.env.ADMIN_USER;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !passwordHash) {
    throw new Error('Missing ADMIN_USER or ADMIN_PASSWORD_HASH environment configuration');
  }

  const expectedUser = adminUser.trim();
  const expectedHash = normalizeBcryptHash(passwordHash);
  const providedUser = input.username.trim();

  if (providedUser !== expectedUser) {
    return false;
  }

  return await bcrypt.compare(input.password, expectedHash);
}
