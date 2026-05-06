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

const allowedOrigin = process.env.ORIGIN;
app.use(cors({
  origin: allowedOrigin ? [allowedOrigin] : true,
  credentials: true,
}));
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));

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

type UserRole = 'root' | 'admin' | 'user' | 'readonly';

type UserRecord = {
  id: Uint8Array<ArrayBufferLike>;
  email: string;
  role: UserRole;
  avatarUrl?: string;
  currentChallenge?: string;
  authenticators: StoredAuthenticator[];
};

const usersByEmail = new Map<string, UserRecord>();
const sessions = new Map<string, string>();

type InviteRecord = { email: string; role: UserRole; expiresAt: number; used: boolean };
const invites = new Map<string, InviteRecord>();


type SetupState = {
  completed: boolean;
  dashboardName: string;
  theme: 'dark' | 'light';
  accent: 'cyan' | 'violet' | 'emerald' | 'rose';
  rootEmail?: string;
  rootBackupPassword?: string;
  backupPasswordAccepted?: boolean;
};

const setupState: SetupState = {
  completed: false,
  dashboardName: 'SM Dashboard',
  theme: 'dark',
  accent: 'cyan',
};

const generateBackupPassword = () => crypto.randomBytes(18).toString('base64url');


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


const getSessionUser = (req: express.Request): UserRecord | undefined => getCurrentUserFromSession(req);
const isAdmin = (req: express.Request) => {
  const user = getSessionUser(req);
  return Boolean(user && setupState.rootEmail && user.email === setupState.rootEmail);
};

const getOrCreateUser = (email: string): UserRecord => {
  const existing = usersByEmail.get(email);
  if (existing) return existing;

  const created: UserRecord = {
    id: crypto.randomBytes(32),
    email,
    role: setupState.rootEmail && email === setupState.rootEmail ? 'root' : 'user',
    authenticators: [],
  };
  usersByEmail.set(email, created);
  return created;
};


app.get('/api/setup/status', (_req, res) => {
  return res.json({ completed: setupState.completed, dashboardName: setupState.dashboardName, theme: setupState.theme, accent: setupState.accent, setupStarted: Boolean(setupState.rootEmail), backupPasswordAccepted: Boolean(setupState.backupPasswordAccepted) });
});

app.post('/api/setup/start', (req, res) => {
  if (setupState.completed) return res.status(403).json({ error: 'Setup already completed' });
  const { rootEmail } = req.body as { rootEmail?: string };
  if (!rootEmail) return res.status(400).json({ error: 'rootEmail is required' });

  setupState.rootEmail = rootEmail.trim().toLowerCase();
  setupState.backupPasswordAccepted = false;
  getOrCreateUser(setupState.rootEmail);

  return res.json({ ok: true });
});


app.post('/api/setup/generate-backup-password', (req, res) => {
  if (setupState.completed) return res.status(403).json({ error: 'Setup already completed' });
  const { email, inviteToken } = req.body as { email?: string; inviteToken?: string };
  if (!setupState.rootEmail || email?.toLowerCase() !== setupState.rootEmail) return res.status(400).json({ error: 'Root account mismatch' });
  const root = usersByEmail.get(setupState.rootEmail);
  if (!root || root.authenticators.length === 0) return res.status(400).json({ error: 'Register a root passkey first' });

  setupState.rootBackupPassword = generateBackupPassword();
  setupState.backupPasswordAccepted = false;
  return res.json({ rootBackupPassword: setupState.rootBackupPassword });
});

app.post('/api/setup/acknowledge-backup-password', (req, res) => {
  if (setupState.completed) return res.status(403).json({ error: 'Setup already completed' });
  const { accepted } = req.body as { accepted?: boolean };
  if (!accepted) return res.status(400).json({ error: 'Backup password must be acknowledged' });
  setupState.backupPasswordAccepted = true;
  return res.json({ ok: true });
});

app.post('/api/setup/complete', (req, res) => {
  if (setupState.completed) return res.status(403).json({ error: 'Setup already completed' });
  const { email, inviteToken } = req.body as { email?: string; inviteToken?: string };
  if (!setupState.rootEmail || email?.toLowerCase() !== setupState.rootEmail) return res.status(400).json({ error: 'Root account mismatch' });
  const root = usersByEmail.get(setupState.rootEmail);
  if (!root || root.authenticators.length === 0) return res.status(400).json({ error: 'Register a root passkey first' });

  if (!setupState.backupPasswordAccepted) return res.status(400).json({ error: 'Acknowledge backup password first' });
  setupState.dashboardName = body.dashboardName?.trim() || setupState.dashboardName;
  setupState.theme = body.theme === 'light' ? 'light' : 'dark';
  setupState.accent = body.accent && ['cyan', 'violet', 'emerald', 'rose'].includes(body.accent) ? body.accent : 'cyan';
  setupState.completed = true;
  return res.json({ ok: true });
});

app.post('/api/auth/passkey/registration-options', async (req, res) => {
  const { email, inviteToken } = req.body as { email?: string; inviteToken?: string };
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = email.trim().toLowerCase();

  if (!setupState.completed) {
    if (!setupState.rootEmail || normalizedEmail !== setupState.rootEmail) {
      return res.status(403).json({ error: 'During setup, only root user can register a passkey' });
    }
  } else {
    const invite = inviteToken ? invites.get(inviteToken) : undefined;
    if (!invite || invite.used || invite.expiresAt < Date.now() || invite.email !== normalizedEmail) {
      return res.status(403).json({ error: 'A valid invite token is required for passkey registration' });
    }
  }

  const user = getOrCreateUser(normalizedEmail);
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
      residentKey: 'preferred',
      userVerification: requireUserVerification ? 'required' : 'preferred',
    },
  });

  user.currentChallenge = options.challenge;
  return res.json(options);
});

app.post('/api/auth/passkey/verify-registration', async (req, res) => {
  const { email, registrationResponse, inviteToken } = req.body as {
    email?: string;
    registrationResponse?: RegistrationResponseJSON;
    inviteToken?: string;
  };

  if (!email || !registrationResponse) {
    return res.status(400).json({ error: 'Email and registrationResponse are required' });
  }


  const user = usersByEmail.get(email.trim().toLowerCase());
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


  if (setupState.completed && inviteToken) {
    const invite = invites.get(inviteToken);
    if (invite && invite.email === email.trim().toLowerCase()) {
      user.role = invite.role;
      invite.used = true;
    }
  }

  user.currentChallenge = undefined;
  return res.json({ verified: true });
});

app.post('/api/auth/passkey/authentication-options', async (req, res) => {
  const { email, inviteToken } = req.body as { email?: string; inviteToken?: string };
  if (!email) return res.status(400).json({ error: 'Email is required' });


  const user = usersByEmail.get(email.trim().toLowerCase());
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
    user: { id: userId, email: user.email, role: user.role, avatarUrl: user.avatarUrl },
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getCurrentUserFromSession(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ user: { id: Buffer.from(user.id).toString('base64url'), email: user.email, role: user.role, avatarUrl: user.avatarUrl }, setup: { dashboardName: setupState.dashboardName, theme: setupState.theme, accent: setupState.accent, isAdmin: isAdmin(req) } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName];
  if (token) sessions.delete(token);
  const isSecure = !getEffectiveOrigin(req).startsWith('http://localhost');
  res.setHeader('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`);
  return res.json({ ok: true });
});

app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(distDir, 'index.html'));
});


app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const users = [...usersByEmail.values()].map((u) => ({ id: Buffer.from(u.id).toString('base64url'), email: u.email, role: u.role, hasPasskey: u.authenticators.length > 0, avatarUrl: u.avatarUrl }));
  return res.json({ users });
});

app.post('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  return res.status(410).json({ error: 'Direct user creation is disabled. Use invite links.' });
});


app.post('/api/admin/invites', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { email, role, ttlMinutes } = req.body as { email?: string; role?: UserRole; ttlMinutes?: number };
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = email.trim().toLowerCase();
  const safeRole: UserRole = role && ['admin', 'user', 'readonly'].includes(role) ? role : 'user';
  const token = crypto.randomBytes(24).toString('base64url');
  invites.set(token, { email: normalizedEmail, role: safeRole, expiresAt: Date.now() + Math.max(5, ttlMinutes ?? 60) * 60_000, used: false });
  return res.json({ ok: true, token, inviteUrl: `${getEffectiveOrigin(req)}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}` });
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
