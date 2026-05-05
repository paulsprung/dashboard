import 'dotenv/config';
import crypto, { webcrypto } from 'node:crypto';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
type AuthenticationResponseJSON = { id: string } & Record<string, unknown>;
type RegistrationResponseJSON = Record<string, any>;
type AuthenticatorTransportFuture = string;
type AuthenticatorDevice = string;
type Base64URLString = string;

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

const app = express();
app.use(cors());
app.use(express.json());

const rpName = process.env.RP_NAME ?? 'SM Dashboard';
const port = Number(process.env.PORT ?? 3001);
const sessionCookieName = 'sm_session';
const requireUserVerification = process.env.REQUIRE_USER_VERIFICATION === 'true';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');


const sanitizeRPID = (value: string) => value.replace(/^https?:\/\//, '').replace(/\/$/, '');

const getEffectiveOrigin = (req: express.Request): string => {
  if (process.env.ORIGIN) return process.env.ORIGIN;
  const headerOrigin = req.headers.origin;
  if (typeof headerOrigin === 'string' && headerOrigin.length > 0) return headerOrigin;
  return 'http://localhost:5173';
};

const getEffectiveRPID = (req: express.Request, originValue: string): string => {
  if (process.env.RP_ID) return sanitizeRPID(process.env.RP_ID.trim());
  const host = new URL(originValue).hostname;
  return sanitizeRPID(host);
};

type StoredAuthenticator = {
  credentialID: Base64URLString;
  credentialPublicKey: Uint8Array<ArrayBufferLike>;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType?: AuthenticatorDevice;
  backedUp?: boolean;
};

type UserRecord = {
  id: Uint8Array<ArrayBufferLike>;
  email: string;
  currentChallenge?: string;
  authenticators: StoredAuthenticator[];
};

const usersByEmail = new Map<string, UserRecord>();
const sessions = new Map<string, string>();


const parseCookies = (cookieHeader?: string): Record<string, string> => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rawValue.join('='));
    return acc;
  }, {});
};

const createSession = (userId: string) => {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, userId);
  return token;
};

const getCurrentUserFromSession = (req: express.Request): UserRecord | undefined => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName];
  if (!token) return undefined;
  const userId = sessions.get(token);
  if (!userId) return undefined;
  return [...usersByEmail.values()].find((user) => Buffer.from(user.id).toString('base64url') === userId);
};

const getOrCreateUser = (email: string): UserRecord => {
  const existing = usersByEmail.get(email);
  if (existing) return existing;

  const created: UserRecord = {
    id: crypto.randomBytes(32),
    email,
    authenticators: [],
  };
  usersByEmail.set(email, created);
  return created;
};

app.post('/api/auth/passkey/registration-options', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = getOrCreateUser(email);
  const effectiveOrigin = getEffectiveOrigin(req);
  const effectiveRPID = getEffectiveRPID(req, effectiveOrigin);

  const options = await generateRegistrationOptions({
    rpID: effectiveRPID,
    rpName,
    userName: user.email,
    userID: user.id,
    attestationType: 'none',
    excludeCredentials: user.authenticators.map((authenticator) => ({
      id: authenticator.credentialID,
      transports: authenticator.transports,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: requireUserVerification ? 'required' : 'preferred',
    },
  });

  user.currentChallenge = options.challenge;
  return res.json(options);
});

app.post('/api/auth/passkey/verify-registration', async (req, res) => {
  const { email, registrationResponse } = req.body as {
    email?: string;
    registrationResponse?: RegistrationResponseJSON;
  };

  if (!email || !registrationResponse) {
    return res.status(400).json({ error: 'Email and registrationResponse are required' });
  }

  const user = usersByEmail.get(email);
  if (!user || !user.currentChallenge) {
    return res.status(400).json({ error: 'Registration challenge not found for user' });
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getEffectiveOrigin(req),
      expectedRPID: getEffectiveRPID(req, getEffectiveOrigin(req)),
      requireUserVerification,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown registration verification error';
    console.error('verify-registration failed', { message, origin: getEffectiveOrigin(req), rpID: getEffectiveRPID(req, getEffectiveOrigin(req)) });
    return res.status(400).json({ error: message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ verified: false });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const alreadyRegistered = user.authenticators.some(
    (item) => item.credentialID === credential.id,
  );

  if (!alreadyRegistered) {
    user.authenticators.push({
      credentialID: credential.id,
      credentialPublicKey: credential.publicKey,
      counter: credential.counter ?? 0,
      transports: registrationResponse.response.transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });
  }

  user.currentChallenge = undefined;
  return res.json({ verified: true });
});

app.post('/api/auth/passkey/authentication-options', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = usersByEmail.get(email);
  if (!user || user.authenticators.length === 0) {
    return res.status(404).json({ error: 'No passkey found for this account yet. Register one first.' });
  }

  const effectiveOrigin = getEffectiveOrigin(req);
  const effectiveRPID = getEffectiveRPID(req, effectiveOrigin);

  const options = await generateAuthenticationOptions({
    rpID: effectiveRPID,
    allowCredentials: user.authenticators.map((authenticator) => ({
      id: authenticator.credentialID,
      transports: authenticator.transports,
    })),
    userVerification: requireUserVerification ? 'required' : 'preferred',
  });

  user.currentChallenge = options.challenge;
  return res.json(options);
});

app.post('/api/auth/passkey/verify-authentication', async (req, res) => {
  const body = req.body as AuthenticationResponseJSON;

  const user = [...usersByEmail.values()].find((candidate) =>
    candidate.authenticators.some((authenticator) => authenticator.credentialID === body.id),
  );

  if (!user || !user.currentChallenge) {
    return res.status(400).json({ error: 'Could not validate this login request' });
  }

  const authenticator = user.authenticators.find(
    (item) => item.credentialID === body.id,
  );

  if (!authenticator) {
    return res.status(400).json({ error: 'Authenticator not registered for this user' });
  }

  const authenticatorForVerification = {
    credentialID: authenticator.credentialID,
    credentialPublicKey: authenticator.credentialPublicKey,
    counter: authenticator.counter ?? 0,
    transports: authenticator.transports,
  };

  const credentialForVerification = {
    id: authenticator.credentialID,
    publicKey: authenticator.credentialPublicKey,
    counter: authenticator.counter ?? 0,
    transports: authenticator.transports,
  };

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getEffectiveOrigin(req),
      expectedRPID: getEffectiveRPID(req, getEffectiveOrigin(req)),
      authenticator: authenticatorForVerification,
      credential: credentialForVerification,
      requireUserVerification,
    } as Parameters<typeof verifyAuthenticationResponse>[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verification error';
    const normalized = message.toLowerCase();
    const hint = normalized.includes('user verification was required')
      ? 'User verification is currently required. Use a passkey with Face ID/Touch ID/PIN verification or set REQUIRE_USER_VERIFICATION=false.'
      : message;
    console.error('verify-authentication failed', { message, origin: getEffectiveOrigin(req), rpID: getEffectiveRPID(req, getEffectiveOrigin(req)), requireUserVerification });
    return res.status(400).json({ error: hint });
  }

  if (!verification.verified) {
    return res.status(401).json({ verified: false });
  }

  authenticator.counter = verification.authenticationInfo.newCounter;
  user.currentChallenge = undefined;

  const userId = Buffer.from(user.id).toString('base64url');
  const sessionToken = createSession(userId);
  const isSecure = !getEffectiveOrigin(req).startsWith('http://localhost');
  res.setHeader('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${isSecure ? '; Secure' : ''}`);

  return res.json({
    verified: true,
    user: { id: userId, email: user.email },
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getCurrentUserFromSession(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  return res.json({ user: { id: Buffer.from(user.id).toString('base64url'), email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res.json({ ok: true });
});

app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(distDir, 'index.html'));
});

app.get('/api/auth/health', (req, res) => {
  const effectiveOrigin = getEffectiveOrigin(req);
  const effectiveRPID = getEffectiveRPID(req, effectiveOrigin);
  res.json({ ok: true, rpID: effectiveRPID, rpName, origin: effectiveOrigin, message: 'Passkey auth server is running' });
});

const server = app.listen(port, () => {
  console.log(`Passkey auth API listening on http://localhost:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other process or set PORT to a free port.`);
    process.exit(1);
  }

  console.error('Server failed to start', error);
  process.exit(1);
});
