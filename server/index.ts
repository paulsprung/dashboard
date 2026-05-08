import 'dotenv/config';
import crypto, { webcrypto } from 'node:crypto';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
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

if (!process.env.ORIGIN) {
  console.error('ORIGIN environment variable is required (e.g. https://dashboard.example.com). Refusing to start.');
  process.exit(1);
}

const origin = process.env.ORIGIN;

const app = express();

// Trust one proxy hop (Cloudflare → this server)
app.set('trust proxy', 1);

app.use(cors({ origin, credentials: true }));

app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  next();
});

app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/auth/', authLimiter);
app.use('/api/setup/', authLimiter);

const rpName = process.env.RP_NAME ?? 'SM Dashboard';
const port = Number(process.env.PORT ?? 3001);
const sessionCookieName = 'sm_session';
const requireUserVerification = process.env.REQUIRE_USER_VERIFICATION === 'true';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');

const sanitizeRPID = (value: string) => value.replace(/^https?:\/\//, '').replace(/\/$/, '');

const getEffectiveOrigin = (): string => origin;

const getEffectiveRPID = (): string => {
  if (process.env.RP_ID) return sanitizeRPID(process.env.RP_ID.trim());
  return sanitizeRPID(new URL(origin).hostname);
};

const isValidEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

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

type SessionEntry = { userId: string; expiresAt: number };
const sessions = new Map<string, SessionEntry>();

type InviteRecord = { email: string; role: UserRole; expiresAt: number; used: boolean };
const invites = new Map<string, InviteRecord>();

type SetupState = {
  completed: boolean;
  dashboardName: string;
  theme: 'dark' | 'light' | 'ultra-dark';
  accent: string; // hex color e.g. #007AFF
  rootEmail?: string;
  rootBackupPasswordHash?: string;
  backupPasswordAccepted?: boolean;
};

const setupState: SetupState = {
  completed: false,
  dashboardName: 'SM Dashboard',
  theme: 'dark',
  accent: '#007AFF',
};

const isValidHex = (color: string) => /^#[0-9A-Fa-f]{6}$/.test(color);

const databaseUrl = process.env.DATABASE_URL;
const hasPostgresEnv = Boolean(databaseUrl || (process.env.POSTGRES_DB && process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD));
const strictPersistence = process.env.STRICT_PERSISTENCE !== 'false';
const connectionString = databaseUrl ?? `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`;
const pgPool = hasPostgresEnv ? new pg.Pool({ connectionString }) : null;

const serializeState = () => JSON.stringify({
  users: [...usersByEmail.values()].map((u) => ({
    ...u,
    id: Buffer.from(u.id).toString('base64url'),
    authenticators: u.authenticators.map((a) => ({ ...a, credentialPublicKey: Buffer.from(a.credentialPublicKey).toString('base64') })),
  })),
  sessions: [...sessions.entries()],
  invites: [...invites.entries()],
  setupState,
});

const hydrateState = (payload: any) => {
  if (!payload) return;
  usersByEmail.clear();
  sessions.clear();
  invites.clear();
  for (const u of payload.users ?? []) {
    usersByEmail.set(u.email, {
      ...u,
      id: Uint8Array.from(Buffer.from(u.id, 'base64url')),
      authenticators: (u.authenticators ?? []).map((a: any) => ({
        ...a,
        credentialPublicKey: Uint8Array.from(Buffer.from(a.credentialPublicKey, 'base64')),
      })),
    });
  }
  for (const [k, v] of payload.sessions ?? []) {
    // handle old format (plain string) gracefully — those sessions are simply dropped
    if (typeof v === 'object' && v !== null && 'userId' in v && 'expiresAt' in v) {
      sessions.set(k, v as SessionEntry);
    }
  }
  for (const [k, v] of payload.invites ?? []) invites.set(k, v);
  Object.assign(setupState, payload.setupState ?? {});
};

const persistState = async () => {
  try {
    if (!hasPostgresEnv) return;
    await pgPool!.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pgPool!.query(
      'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()',
      [serializeState()],
    );
  } catch (error) {
    console.error('persistState failed', error);
    if (strictPersistence) process.exit(1);
  }
};

const loadState = async () => {
  try {
    if (!hasPostgresEnv) return;
    await pgPool!.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const row = await pgPool!.query('SELECT data FROM app_state WHERE id = 1');
    const raw = row.rows[0]?.data ? JSON.stringify(row.rows[0].data) : '';
    if (raw) hydrateState(JSON.parse(raw));
  } catch (error) {
    console.error('loadState failed', error);
    if (strictPersistence) throw error;
  }
};

const generateBackupPassword = () => crypto.randomBytes(18).toString('base64url');

const hashBackupPassword = (password: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });

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
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  void persistState();
  return token;
};

const getCurrentUserFromSession = (req: express.Request): UserRecord | undefined => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName];
  if (!token) return undefined;
  const entry = sessions.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return [...usersByEmail.values()].find((user) => Buffer.from(user.id).toString('base64url') === entry.userId);
};

const getSessionUser = (req: express.Request): UserRecord | undefined => getCurrentUserFromSession(req);

const isAdmin = (req: express.Request) => {
  const user = getSessionUser(req);
  return Boolean(user && (user.role === 'root' || user.role === 'admin'));
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
  void persistState();
  return created;
};

// ── Admin routes (registered before static middleware) ───────────────────────

app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const users = [...usersByEmail.values()].map((u) => ({
    id: Buffer.from(u.id).toString('base64url'),
    email: u.email,
    role: u.role,
    hasPasskey: u.authenticators.length > 0,
    avatarUrl: u.avatarUrl,
  }));
  return res.json({ users });
});

app.post('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  return res.status(410).json({ error: 'Direct user creation is disabled. Use invite links.' });
});

app.post('/api/admin/invites', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { email, role, ttlMinutes } = req.body as { email?: string; role?: UserRole; ttlMinutes?: number };
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  const normalizedEmail = email.trim().toLowerCase();
  const safeRole: UserRole = role && ['admin', 'user', 'readonly'].includes(role) ? role : 'user';
  const safeTtl = Math.min(10080, Math.max(5, ttlMinutes ?? 60));
  const token = crypto.randomBytes(24).toString('base64url');
  invites.set(token, { email: normalizedEmail, role: safeRole, expiresAt: Date.now() + safeTtl * 60_000, used: false });
  void persistState();
  return res.json({ ok: true, token, inviteUrl: `${getEffectiveOrigin()}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}` });
});

// ── Setup routes ─────────────────────────────────────────────────────────────

app.get('/api/setup/status', (_req, res) => {
  return res.json({
    completed: setupState.completed,
    dashboardName: setupState.dashboardName,
    theme: setupState.theme,
    accent: setupState.accent,
    setupStarted: Boolean(setupState.rootEmail),
    backupPasswordAccepted: Boolean(setupState.backupPasswordAccepted),
  });
});

app.post('/api/setup/start', (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Setup already completed' });
  const { rootEmail } = req.body as { rootEmail?: string };
  if (!rootEmail || !isValidEmail(rootEmail)) return res.status(400).json({ error: 'A valid rootEmail is required' });
  setupState.rootEmail = rootEmail.trim().toLowerCase();
  setupState.backupPasswordAccepted = false;
  getOrCreateUser(setupState.rootEmail);
  void persistState();
  return res.json({ ok: true });
});

app.post('/api/setup/generate-backup-password', async (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Setup already completed' });
  const { email } = req.body as { email?: string };
  if (!setupState.rootEmail || email?.toLowerCase() !== setupState.rootEmail) {
    return res.status(400).json({ error: 'Root account mismatch' });
  }
  const root = usersByEmail.get(setupState.rootEmail);
  if (!root || root.authenticators.length === 0) {
    return res.status(400).json({ error: 'Register a root passkey first' });
  }

  const plaintext = generateBackupPassword();
  setupState.rootBackupPasswordHash = await hashBackupPassword(plaintext);
  setupState.backupPasswordAccepted = false;
  void persistState();
  // Plaintext returned only once, never stored
  return res.json({ rootBackupPassword: plaintext });
});

app.post('/api/setup/acknowledge-backup-password', (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Setup already completed' });
  const { accepted } = req.body as { accepted?: boolean };
  if (!accepted) return res.status(400).json({ error: 'Backup password must be acknowledged' });
  setupState.backupPasswordAccepted = true;
  void persistState();
  return res.json({ ok: true });
});

app.post('/api/setup/complete', (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Setup already completed' });
  const body = req.body as {
    email?: string;
    dashboardName?: string;
    theme?: string;
    accent?: string;
  };
  const email = body.email;
  if (!setupState.rootEmail || email?.toLowerCase() !== setupState.rootEmail) {
    return res.status(400).json({ error: 'Root account mismatch' });
  }
  const root = usersByEmail.get(setupState.rootEmail);
  if (!root || root.authenticators.length === 0) {
    return res.status(400).json({ error: 'Register a root passkey first' });
  }
  if (!setupState.backupPasswordAccepted) {
    return res.status(400).json({ error: 'Backup password must be acknowledged first' });
  }
  const rawName = body.dashboardName?.trim() ?? '';
  setupState.dashboardName = rawName.length > 0 && rawName.length <= 80 ? rawName : setupState.dashboardName;
  setupState.theme = (['light', 'dark', 'ultra-dark'] as const).includes(body.theme as any) ? body.theme as SetupState['theme'] : 'dark';
  setupState.accent = body.accent && isValidHex(body.accent) ? body.accent : '#007AFF';
  setupState.completed = true;
  void persistState();
  return res.json({ ok: true });
});

app.post('/api/setup/root/registration-options', async (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Root setup registration is disabled after setup completion' });
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = email.trim().toLowerCase();
  if (!setupState.rootEmail || normalizedEmail !== setupState.rootEmail) {
    return res.status(403).json({ error: 'Only configured root email can register during setup' });
  }
  const user = getOrCreateUser(normalizedEmail);
  const options = await generateRegistrationOptions({
    rpID: getEffectiveRPID(),
    rpName,
    userName: user.email,
    userID: user.id as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    excludeCredentials: user.authenticators.map((a) => ({ id: a.credentialID, transports: a.transports as any })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: requireUserVerification ? 'required' : 'preferred' },
  });
  user.currentChallenge = options.challenge;
  void persistState();
  return res.json(options);
});

app.post('/api/setup/root/verify-registration', async (req, res) => {
  if (setupState.completed) return res.status(410).json({ error: 'Root setup registration is disabled after setup completion' });
  const { email, registrationResponse } = req.body as { email?: string; registrationResponse?: RegistrationResponseJSON };
  if (!email || !registrationResponse) return res.status(400).json({ error: 'Email and registrationResponse are required' });
  const normalizedEmail = email.trim().toLowerCase();
  if (!setupState.rootEmail || normalizedEmail !== setupState.rootEmail) {
    return res.status(403).json({ error: 'Root account mismatch' });
  }
  const user = usersByEmail.get(normalizedEmail);
  if (!user || !user.currentChallenge) return res.status(400).json({ error: 'Registration challenge not found for user' });

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationResponse as any,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getEffectiveOrigin(),
      expectedRPID: getEffectiveRPID(),
      requireUserVerification,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown registration verification error';
    return res.status(400).json({ error: message });
  }

  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ verified: false });
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const alreadyRegistered = user.authenticators.some((item) => item.credentialID === credential.id);
  if (!alreadyRegistered) {
    user.authenticators.push({
      credentialID: credential.id,
      credentialPublicKey: credential.publicKey as Uint8Array<ArrayBufferLike>,
      counter: credential.counter ?? 0,
      transports: registrationResponse.response.transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });
  }
  user.currentChallenge = undefined;
  void persistState();
  return res.json({ verified: true });
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/passkey/registration-options', async (req, res) => {
  const { email, inviteToken } = req.body as { email?: string; inviteToken?: string };
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  const normalizedEmail = email.trim().toLowerCase();
  if (!setupState.completed) return res.status(410).json({ error: 'User registration is disabled until root setup is completed' });
  const invite = inviteToken ? invites.get(inviteToken) : undefined;
  if (!invite || invite.used || invite.expiresAt < Date.now() || invite.email !== normalizedEmail) {
    return res.status(403).json({ error: 'A valid invite token is required for passkey registration' });
  }
  const user = getOrCreateUser(normalizedEmail);
  const options = await generateRegistrationOptions({
    rpID: getEffectiveRPID(),
    rpName,
    userName: user.email,
    userID: user.id as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    excludeCredentials: user.authenticators.map((a) => ({ id: a.credentialID, transports: a.transports as any })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: requireUserVerification ? 'required' : 'preferred' },
  });
  user.currentChallenge = options.challenge;
  void persistState();
  return res.json(options);
});

app.post('/api/auth/passkey/verify-registration', async (req, res) => {
  const { email, registrationResponse, inviteToken } = req.body as {
    email?: string;
    registrationResponse?: RegistrationResponseJSON;
    inviteToken?: string;
  };
  if (!email || !registrationResponse) return res.status(400).json({ error: 'Email and registrationResponse are required' });

  const user = usersByEmail.get(email.trim().toLowerCase());
  if (!user || !user.currentChallenge) return res.status(400).json({ error: 'Registration challenge not found for user' });

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationResponse as any,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getEffectiveOrigin(),
      expectedRPID: getEffectiveRPID(),
      requireUserVerification,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown registration verification error';
    console.error('verify-registration failed', { message });
    return res.status(400).json({ error: message });
  }

  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ verified: false });

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  if (!user.authenticators.some((item) => item.credentialID === credential.id)) {
    user.authenticators.push({
      credentialID: credential.id,
      credentialPublicKey: credential.publicKey as Uint8Array<ArrayBufferLike>,
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
  void persistState();
  return res.json({ verified: true });
});

app.post('/api/auth/passkey/authentication-options', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Sign-in failed. Check your email and try again.' });

  const user = usersByEmail.get(email.trim().toLowerCase());
  // Generic error to avoid user enumeration
  if (!user || user.authenticators.length === 0) {
    return res.status(400).json({ error: 'Sign-in failed. Check your email and try again.' });
  }

  const options = await generateAuthenticationOptions({
    rpID: getEffectiveRPID(),
    allowCredentials: user.authenticators.map((a) => ({ id: a.credentialID, transports: a.transports as any })),
    userVerification: requireUserVerification ? 'required' : 'preferred',
  });

  user.currentChallenge = options.challenge;
  return res.json(options);
});

app.post('/api/auth/passkey/verify-authentication', async (req, res) => {
  const body = req.body as AuthenticationResponseJSON;

  const user = [...usersByEmail.values()].find((candidate) =>
    candidate.authenticators.some((a) => a.credentialID === body.id),
  );
  if (!user || !user.currentChallenge) {
    return res.status(400).json({ error: 'Could not validate this login request' });
  }

  const authenticator = user.authenticators.find((item) => item.credentialID === body.id)!;

  const credentialForVerification = {
    id: authenticator.credentialID,
    publicKey: authenticator.credentialPublicKey,
    counter: authenticator.counter ?? 0,
    transports: authenticator.transports,
  };

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: body as any,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: getEffectiveOrigin(),
      expectedRPID: getEffectiveRPID(),
      authenticator: {
        credentialID: authenticator.credentialID,
        credentialPublicKey: authenticator.credentialPublicKey,
        counter: authenticator.counter ?? 0,
        transports: authenticator.transports as any,
      },
      credential: credentialForVerification as any,
      requireUserVerification,
    } as any);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verification error';
    const normalized = message.toLowerCase();
    const hint = normalized.includes('user verification was required')
      ? 'User verification is currently required. Use a passkey with Face ID/Touch ID/PIN verification or set REQUIRE_USER_VERIFICATION=false.'
      : message;
    console.error('verify-authentication failed', { message });
    return res.status(400).json({ error: hint });
  }

  if (!verification.verified) {
    return res.status(401).json({ verified: false });
  }

  authenticator.counter = verification.authenticationInfo.newCounter;
  user.currentChallenge = undefined;
  void persistState();

  const loginUserId = Buffer.from(user.id).toString('base64url');
  const loginSessionToken = createSession(loginUserId);
  const isSecure = !origin.startsWith('http://localhost');
  res.setHeader('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(loginSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${isSecure ? '; Secure' : ''}`);

  return res.json({
    verified: true,
    user: { id: loginUserId, email: user.email, role: user.role, avatarUrl: user.avatarUrl },
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getCurrentUserFromSession(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    user: { id: Buffer.from(user.id).toString('base64url'), email: user.email, role: user.role, avatarUrl: user.avatarUrl },
    setup: { dashboardName: setupState.dashboardName, theme: setupState.theme, accent: setupState.accent, isAdmin: isAdmin(req) },
  });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[sessionCookieName];
  if (token) sessions.delete(token);
  void persistState();
  const isSecure = !origin.startsWith('http://localhost');
  res.setHeader('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`);
  return res.json({ ok: true });
});

app.get('/api/auth/health', (_req, res) => {
  res.json({ ok: true, rpID: getEffectiveRPID(), rpName, origin: getEffectiveOrigin(), message: 'Passkey auth server is running' });
});

// ── Static frontend ───────────────────────────────────────────────────────────

app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(distDir, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const startServer = async () => {
  if (!hasPostgresEnv && strictPersistence) {
    throw new Error('Persistence is required but PostgreSQL env vars are missing. Set DATABASE_URL or POSTGRES_* in .env.');
  }
  await loadState();
  const server = app.listen(port, () => {
    console.log(`Passkey auth API listening on http://localhost:${port}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use.`);
      process.exit(1);
    }
    console.error('Server failed to start', error);
    process.exit(1);
  });
};

void startServer();
