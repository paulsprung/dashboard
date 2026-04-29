import { SignJWT, jwtVerify } from 'jose';

const SESSION_COOKIE_NAME = 'sm_session';
const TOKEN_ISSUER = 'shyy.dev';
const TOKEN_AUDIENCE = 'sm-dashboard';
const TOKEN_TTL = '12h';

export type SessionPayload = {
  sub: string;
  username: string;
  authMethods: string[];
};

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime(TOKEN_TTL)
    .sign(getJwtSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE
    });

    return {
      sub: String(payload.sub),
      username: String(payload.username),
      authMethods: Array.isArray(payload.authMethods)
        ? payload.authMethods.map((item) => String(item))
        : []
    };
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: SESSION_COOKIE_NAME,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 12
  }
};
