import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

export type LoginInput = z.infer<typeof loginSchema>;

export async function verifyCredentials(input: LoginInput): Promise<boolean> {
  const adminUser = process.env.ADMIN_USER;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUser || !passwordHash) {
    throw new Error('Missing ADMIN_USER or ADMIN_PASSWORD_HASH environment configuration');
  }

  const expectedUser = adminUser.trim();
  const expectedHash = passwordHash.trim();
  const providedUser = input.username.trim();

  if (providedUser !== expectedUser) {
    return false;
  }

  return await bcrypt.compare(input.password, expectedHash);
}
