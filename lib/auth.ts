import { cookies, headers } from 'next/headers';
import crypto from 'crypto';
import { prisma } from './prisma';
import { env } from './env';
import { AuditStatus, Role } from '@prisma/client';

const SESSION_COOKIE = 'sd_session';

export function hashToken(token: string) {
  return crypto.createHmac('sha256', env.sessionSecret).update(token).digest('hex');
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
  const h = await headers();
  await prisma.session.create({ data: { userId, tokenHash, expiresAt, ip: h.get('x-forwarded-for'), userAgent: h.get('user-agent') } });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', expires: expiresAt });
}

export async function getSessionUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

export async function requireUser(roles?: Role[]) {
  const user = await getSessionUser();
  if (!user || user.disabled || (roles && !roles.includes(user.role))) throw new Error('Unauthorized');
  return user;
}

export async function clearSession() {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  c.delete(SESSION_COOKIE);
}

export async function writeAudit(action: string, status: AuditStatus, opts: { userId?: string; target?: string; metadata?: any } = {}) {
  const h = await headers();
  await prisma.auditLog.create({ data: { action, status, userId: opts.userId, target: opts.target, metadata: opts.metadata, ip: h.get('x-forwarded-for'), userAgent: h.get('user-agent') } });
}
