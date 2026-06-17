import 'dotenv/config';
import crypto, { webcrypto } from 'node:crypto';
import dgram from 'node:dgram';
import httpsModule from 'node:https';
import net from 'node:net';
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

// Prevent authenticated sessions from spamming device actions or discovery scans
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api/devices/:id/action', actionLimiter);
app.use('/api/pi-agent/discover', actionLimiter);
app.use('/api/monitor/check', actionLimiter);

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

// ── Device types ──────────────────────────────────────────────────────────────

type ShellyPlugConfig   = { type: 'shelly_plug';   ip: string; channel?: number };
type ShellyLightConfig  = { type: 'shelly_light';  ip: string; channel?: number };
type WolConfig          = { type: 'wol';  mac: string; broadcastIp?: string; port?: number };
type ProxmoxConfig      = { type: 'proxmox'; ip: string; port?: number; tokenId: string; tokenSecret: string; allowSelfSigned?: boolean; node?: string };
type RdpConfig          = { type: 'rdp'; ip: string; port?: number; username?: string };
type SshConfig          = { type: 'ssh'; ip: string; port?: number; username?: string };
type HttpConfig         = { type: 'http'; ip: string; onPath: string; offPath?: string; statusPath?: string; method?: 'GET' | 'POST' };
// Web: a device you open/connect to (router, NAS, web UI) — not an on/off switch
type WebConfig          = { type: 'web'; ip: string; port?: number; scheme?: 'http' | 'https'; path?: string };
// Tasmota: works with NOUS A5T, Sonoff, Gosund, and any Tasmota-based device
type TasmotaConfig      = { type: 'tasmota'; ip: string; channels?: number };
// Docker: remote daemon via TCP (enable with dockerd -H tcp://0.0.0.0:2375)
type DockerConfig       = { type: 'docker'; ip: string; port?: number };
// Tailscale: uses official Tailscale API
type TailscaleConfig    = { type: 'tailscale'; apiKey: string; tailnet: string };

type DeviceConfig = ShellyPlugConfig | ShellyLightConfig | WolConfig | ProxmoxConfig | RdpConfig | SshConfig | HttpConfig | WebConfig | TasmotaConfig | DockerConfig | TailscaleConfig;

type DeviceType = DeviceConfig['type'];

// Access is deny-by-default for regular users: they see and control NOTHING until an
// admin puts them in an access group. A group scopes a set of devices (by id and/or
// tag) and grants either view or control over them. Roles root/admin bypass groups
// entirely; 'readonly' can never control, even where a group grants it.
type AccessLevel = 'view' | 'control';
type AccessGroup = {
  id: string;
  name: string;
  deviceIds: string[];   // specific devices in scope
  tags: string[];        // any device carrying one of these tags is in scope
  level: AccessLevel;
  members: string[];     // user ids (base64url)
};

// Mutating actions need 'control'; everything else (status, lists, connect URLs) needs 'view'.
const CONTROL_ACTIONS = new Set(['on', 'off', 'toggle', 'wake', 'vm_ctrl', 'container_ctrl']);

type DeviceRecord = {
  id: string;
  name: string;
  type: DeviceType;           // always present — used for icons, filtering, permissions
  room?: string;
  icon?: string;
  tags?: string[];            // free-form user labels for grouping/filtering + access scoping
  config?: DeviceConfig;      // only in legacy mode (PI_AGENT_URL not set)
};

// ── Widget types ──────────────────────────────────────────────────────────────

type WidgetLayout = { col: number; row: number; w: number; h: number };

type ClockWidgetConfig        = { type: 'clock';         format?: '12h' | '24h'; showSeconds?: boolean; showDate?: boolean };
type WeatherWidgetConfig      = { type: 'weather';       location?: string; unit?: 'C' | 'F' };
type DeviceToggleWidgetConfig = { type: 'device_toggle'; deviceId: string };
type WolButtonWidgetConfig    = { type: 'wol_button';    deviceId: string; label?: string };
type ProxmoxVmsWidgetConfig   = { type: 'proxmox_vms';   deviceId: string };
type NoteWidgetConfig         = { type: 'note';          content: string; title?: string };
type QuickActionsWidgetConfig = { type: 'quick_actions'; deviceIds: string[] };
type EnergyWidgetConfig       = { type: 'energy';        deviceId: string };
type DockerWidgetConfig       = { type: 'docker_containers'; deviceId: string };
type TailscaleWidgetConfig    = { type: 'tailscale_peers';   deviceId: string };
type MonitorWidgetConfig      = { type: 'monitor';       deviceIds?: string[] };

type WidgetConfig = ClockWidgetConfig | WeatherWidgetConfig | DeviceToggleWidgetConfig | WolButtonWidgetConfig | ProxmoxVmsWidgetConfig | NoteWidgetConfig | QuickActionsWidgetConfig | EnergyWidgetConfig | DockerWidgetConfig | TailscaleWidgetConfig | MonitorWidgetConfig;

type WidgetRecord = { id: string; userId: string; layout: WidgetLayout; config: WidgetConfig };

type UserRecord = {
  id: Uint8Array<ArrayBufferLike>;
  email: string;
  role: UserRole;
  avatarUrl?: string;
  currentChallenge?: string;
  authenticators: StoredAuthenticator[];
};

const usersByEmail = new Map<string, UserRecord>();

type SessionEntry = { userId: string; expiresAt: number; createdAt?: number; userAgent?: string };
const sessions = new Map<string, SessionEntry>();

type InviteRecord = { email: string; role: UserRole; expiresAt: number; used: boolean };
const invites = new Map<string, InviteRecord>();

const devices = new Map<string, DeviceRecord>();
const widgets = new Map<string, WidgetRecord>();
const accessGroups = new Map<string, AccessGroup>();

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
  devices: [...devices.entries()],
  widgets: [...widgets.entries()],
  accessGroups: [...accessGroups.entries()],
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
  devices.clear();
  widgets.clear();
  accessGroups.clear();
  for (const [k, v] of payload.devices ?? []) {
    const rec = v as any;
    // Ensure `type` field exists (migrate old records that stored type inside config)
    if (!rec.type && rec.config?.type) rec.type = rec.config.type;
    // Old per-permission flags are gone — access is now group-based (deny-by-default)
    delete rec.requiredPermissions;
    // In zero-knowledge mode, strip sensitive config — it belongs on the Pi Agent
    if (process.env.PI_AGENT_URL && rec.config) delete rec.config;
    devices.set(k, rec as DeviceRecord);
  }
  for (const [k, v] of payload.widgets ?? []) widgets.set(k, v as WidgetRecord);
  for (const [k, v] of payload.accessGroups ?? []) accessGroups.set(k, v as AccessGroup);
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

const createSession = (userId: string, userAgent?: string) => {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now(), userAgent: userAgent?.slice(0, 200) });
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
    // Only expose rootEmail during active (incomplete) setup so the frontend can pre-fill it
    rootEmail: !setupState.completed ? (setupState.rootEmail ?? null) : null,
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
    user.currentChallenge = undefined;
    void persistState();
    const message = error instanceof Error ? error.message : 'Unknown registration verification error';
    user.currentChallenge = undefined;
    return res.status(400).json({ error: message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    user.currentChallenge = undefined;
    void persistState();
    return res.status(400).json({ verified: false });
  }
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
    user.currentChallenge = undefined;
    void persistState();
    const message = error instanceof Error ? error.message : 'Unknown registration verification error';
    console.error('verify-registration failed', { message });
    user.currentChallenge = undefined;
    return res.status(400).json({ error: message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    user.currentChallenge = undefined;
    void persistState();
    return res.status(400).json({ verified: false });
  }

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

// Challenges for usernameless (discoverable passkey) logins. These aren't tied
// to a user yet — the user is identified from the returned credential at verify.
const discoverableChallenges = new Map<string, number>(); // challenge -> expiry (ms)
const DISCOVERABLE_TTL_MS = 5 * 60 * 1000;
const consumeDiscoverableChallenge = (challenge: string): boolean => {
  const exp = discoverableChallenges.get(challenge);
  if (exp === undefined) return false;
  discoverableChallenges.delete(challenge);
  return exp > Date.now();
};

app.post('/api/auth/passkey/authentication-options', async (req, res) => {
  const { email } = req.body as { email?: string };

  // Usernameless flow: no email → offer every discoverable passkey (Apple-style
  // "just tap" sign-in). The user is resolved from the credential at verify time.
  if (!email) {
    const options = await generateAuthenticationOptions({
      rpID: getEffectiveRPID(),
      allowCredentials: [],
      userVerification: requireUserVerification ? 'required' : 'preferred',
    });
    const now = Date.now();
    for (const [c, e] of discoverableChallenges) if (e < now) discoverableChallenges.delete(c);
    discoverableChallenges.set(options.challenge, now + DISCOVERABLE_TTL_MS);
    return res.json(options);
  }

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Sign-in failed. Check your email and try again.' });

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
  // The challenge may live on the user (email flow) or in the discoverable store
  // (usernameless flow) — validated below via the expectedChallenge function.
  if (!user) {
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
      // Accept either the user-bound challenge (email flow) or a valid
      // discoverable challenge (usernameless flow). Consuming prevents replay.
      expectedChallenge: (challenge: string) =>
        (!!user.currentChallenge && challenge === user.currentChallenge) || consumeDiscoverableChallenge(challenge),
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
    user.currentChallenge = undefined;
    void persistState();
    const message = error instanceof Error ? error.message : 'Unknown verification error';
    const normalized = message.toLowerCase();
    const hint = normalized.includes('user verification was required')
      ? 'User verification is currently required. Use a passkey with Face ID/Touch ID/PIN verification or set REQUIRE_USER_VERIFICATION=false.'
      : message;
    console.error('verify-authentication failed', { message });
    return res.status(400).json({ error: hint });
  }

  if (!verification.verified) {
    user.currentChallenge = undefined; // consume challenge even on failure to prevent replay
    void persistState();
    return res.status(401).json({ verified: false });
  }

  authenticator.counter = verification.authenticationInfo.newCounter;
  user.currentChallenge = undefined;
  void persistState();

  const loginUserId = Buffer.from(user.id).toString('base64url');
  const loginSessionToken = createSession(loginUserId, req.headers['user-agent']);
  const isSecure = !origin.startsWith('http://localhost');
  res.setHeader('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(loginSessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${isSecure ? '; Secure' : ''}`);

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
  res.setHeader('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure ? '; Secure' : ''}`);
  return res.json({ ok: true });
});

// Active sessions for the current user. A non-secret id (hash of the token) is exposed
// so a session can be revoked from the UI without ever leaking the session token itself.
const sessionPublicId = (token: string) => crypto.createHash('sha256').update(token).digest('base64url').slice(0, 16);

app.get('/api/auth/sessions', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const currentToken = parseCookies(req.headers.cookie)[sessionCookieName];
  const list = [...sessions.entries()]
    .filter(([, e]) => e.userId === userId && e.expiresAt > Date.now())
    .map(([token, e]) => ({
      id: sessionPublicId(token),
      createdAt: e.createdAt ?? null,
      expiresAt: e.expiresAt,
      userAgent: e.userAgent ?? null,
      current: token === currentToken,
    }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return res.json({ sessions: list });
});

app.delete('/api/auth/sessions/:id', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  for (const [token, e] of sessions) {
    if (e.userId === userId && sessionPublicId(token) === req.params.id) {
      sessions.delete(token);
      void persistState();
      return res.json({ ok: true });
    }
  }
  return res.status(404).json({ error: 'Session not found' });
});

app.get('/api/auth/health', (_req, res) => {
  res.json({ ok: true, rpID: getEffectiveRPID(), rpName, origin: getEffectiveOrigin(), message: 'Passkey auth server is running' });
});

// ── Monitor ───────────────────────────────────────────────────────────────────
// When PI_AGENT_URL is set: Pi Agent runs TCP checks (it knows the IPs).
// Legacy fallback: dashboard runs checks using locally stored configs.

type MonitorStatus = { deviceId: string; online: boolean; latencyMs: number | null; lastCheck: number };
const monitorStatuses = new Map<string, MonitorStatus>();

const checkTcp = (host: string, port: number, timeoutMs = 2500): Promise<number | null> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(Date.now() - t0); });
    sock.once('error', () => resolve(null));
    sock.once('timeout', () => { sock.destroy(); resolve(null); });
  });

const deviceCheckPort = (cfg: DeviceConfig): { host: string; port: number } | null => {
  if (cfg.type === 'wol' || cfg.type === 'tailscale') return null;
  const ip = (cfg as any).ip as string | undefined;
  if (!ip) return null;
  const portMap: Record<string, number> = {
    shelly_plug: 80, shelly_light: 80, tasmota: 80, http: 80,
    proxmox: (cfg as ProxmoxConfig).port ?? 8006,
    rdp: (cfg as RdpConfig).port ?? 3389,
    ssh: (cfg as SshConfig).port ?? 22,
    docker: (cfg as DockerConfig).port ?? 2375,
  };
  const p = portMap[cfg.type];
  return p ? { host: ip, port: p } : null;
};

// Legacy-mode only: run TCP checks from the dashboard (when no Pi Agent)
const runLocalMonitorChecks = async () => {
  const promises = [...devices.values()].map(async (device) => {
    if (!device.config) return; // zero-knowledge mode: no config on dashboard
    const target = deviceCheckPort(device.config);
    if (!target) return;
    const latency = await checkTcp(target.host, target.port);
    monitorStatuses.set(device.id, { deviceId: device.id, online: latency !== null, latencyMs: latency, lastCheck: Date.now() });
  });
  await Promise.allSettled(promises);
};

// Sync monitor statuses from Pi Agent (zero-knowledge mode)
const syncMonitorFromPiAgent = async () => {
  if (!process.env.PI_AGENT_URL || !process.env.PI_AGENT_SECRET) return;
  try {
    const r = await fetch(`${process.env.PI_AGENT_URL}/devices/monitor`, {
      headers: { Authorization: `Bearer ${process.env.PI_AGENT_SECRET}` },
    });
    if (!r.ok) return;
    const statuses = await r.json() as MonitorStatus[];
    for (const s of statuses) monitorStatuses.set(s.deviceId, s);
  } catch { /* Pi Agent unreachable, keep stale data */ }
};

const runMonitorChecks = async () => {
  if (process.env.PI_AGENT_URL) {
    await syncMonitorFromPiAgent();
  } else {
    await runLocalMonitorChecks();
  }
};

setTimeout(() => void runMonitorChecks(), 8_000);
setInterval(() => void runMonitorChecks(), 30_000);

// ── Wake-on-LAN (legacy / no Pi Agent) ───────────────────────────────────────

const sendWOL = (mac: string, broadcastIp = '255.255.255.255', port = 9): Promise<void> =>
  new Promise((resolve, reject) => {
    const macHex = mac.replace(/[:\-]/g, '');
    if (macHex.length !== 12) { reject(new Error('Invalid MAC address')); return; }
    const macBytes = Buffer.from(macHex, 'hex');
    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);
    const socket = dgram.createSocket('udp4');
    socket.once('error', (e) => { socket.close(); reject(e); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magic, 0, magic.length, port, broadcastIp, (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });

// ── Pi Agent helpers ──────────────────────────────────────────────────────────

const piAgentFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const url = `${process.env.PI_AGENT_URL}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PI_AGENT_SECRET}`,
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
};

const hasPiAgent = () => Boolean(process.env.PI_AGENT_URL && process.env.PI_AGENT_SECRET);

// Strips sensitive config before returning device to client.
// In zero-knowledge mode the config is never stored on this server at all.
// `canControl` tells the client whether to show control buttons (server enforces it too).
const safeDevice = (d: DeviceRecord, canControl = false) => ({
  id: d.id, name: d.name, type: d.type, room: d.room, icon: d.icon, tags: d.tags ?? [], canControl,
});

// ── Device routes ─────────────────────────────────────────────────────────────

// Resolve a user's effective access to a device. Deny-by-default: a regular user with
// no matching group gets 'none'. A device is in a group's scope if the group lists its
// id or shares one of its tags. 'readonly' role is capped at 'view'.
const deviceAccessLevel = (userId: string, role: UserRole, device: DeviceRecord): 'none' | AccessLevel => {
  if (role === 'root' || role === 'admin') return 'control';
  const deviceTags = device.tags ?? [];
  let level: 'none' | AccessLevel = 'none';
  for (const g of accessGroups.values()) {
    if (!g.members.includes(userId)) continue;
    const inScope = g.deviceIds.includes(device.id) || g.tags.some((tg) => deviceTags.includes(tg));
    if (!inScope) continue;
    if (g.level === 'control') level = 'control';
    else if (level === 'none') level = 'view';
  }
  if (role === 'readonly' && level === 'control') level = 'view';
  return level;
};

const userHasDeviceAccess = (userId: string, role: UserRole, device: DeviceRecord): boolean =>
  deviceAccessLevel(userId, role, device) !== 'none';

const userCanControlDevice = (userId: string, role: UserRole, device: DeviceRecord): boolean =>
  deviceAccessLevel(userId, role, device) === 'control';

app.get('/api/devices', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const list = [...devices.values()]
    .map((d) => ({ d, level: deviceAccessLevel(userId, user.role, d) }))
    .filter(({ level }) => level !== 'none')
    .map(({ d, level }) => safeDevice(d, level === 'control')); // never return sensitive config to client
  return res.json({ devices: list });
});

// Admin-only: fetch sensitive config for a device (from Pi Agent in zero-knowledge mode).
// Used to pre-fill the edit form. Config is fetched on demand, never stored in browser state.
app.get('/api/devices/:id/config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (hasPiAgent()) {
    try {
      const r = await piAgentFetch(`/devices/config/${req.params.id}`);
      if (r.status === 404) return res.json({ config: null }); // not yet synced
      if (!r.ok) return res.status(502).json({ error: 'Pi Agent error' });
      return res.json({ config: await r.json() });
    } catch {
      return res.status(502).json({ error: 'Pi Agent unreachable' });
    }
  }
  // Legacy mode: config is stored locally
  return res.json({ config: device.config ?? null });
});

app.post('/api/devices', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { name, room, icon, tags, config } = req.body as Partial<DeviceRecord & { config: DeviceConfig }>;
  if (!name || !config || !config.type) return res.status(400).json({ error: 'name and config.type are required' });
  const id = crypto.randomBytes(12).toString('base64url');
  const cleanTags = Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : undefined;

  if (hasPiAgent()) {
    // Zero-knowledge mode: push sensitive config to Pi Agent, store only metadata here
    try {
      const r = await piAgentFetch('/devices/config', { method: 'POST', body: JSON.stringify({ id, name, ...config }) });
      if (!r.ok) return res.status(502).json({ error: `Pi Agent rejected config: ${r.status}` });
    } catch (err) {
      return res.status(502).json({ error: `Pi Agent unreachable: ${(err as Error).message}` });
    }
    const device: DeviceRecord = { id, name, type: config.type, room, icon, tags: cleanTags };
    devices.set(id, device);
  } else {
    // Legacy mode: store full config on dashboard
    const device: DeviceRecord = { id, name, type: config.type, room, icon, tags: cleanTags, config };
    devices.set(id, device);
  }

  void persistState();
  return res.status(201).json({ device: safeDevice(devices.get(id)!, true) });
});

app.patch('/api/devices/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const { name, room, icon, tags, config } = req.body as Partial<DeviceRecord & { config: DeviceConfig }>;
  if (name !== undefined) device.name = name;
  if (room !== undefined) device.room = room;
  if (icon !== undefined) device.icon = icon;
  if (tags !== undefined) device.tags = Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
  if (config !== undefined) {
    device.type = config.type;

    if (hasPiAgent()) {
      try {
        await piAgentFetch(`/devices/config/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ id: req.params.id, name: device.name, ...config }) });
      } catch { /* non-fatal: Pi Agent may be temporarily unreachable */ }
    } else {
      device.config = config;
    }
  }
  void persistState();
  return res.json({ device: safeDevice(device, true) });
});

app.delete('/api/devices/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!devices.has(req.params.id)) return res.status(404).json({ error: 'Device not found' });
  if (hasPiAgent()) {
    try {
      await piAgentFetch(`/devices/config/${req.params.id}`, { method: 'DELETE' });
    } catch { /* non-fatal */ }
  }
  devices.delete(req.params.id);
  // Drop the device from any access group that referenced it directly
  for (const g of accessGroups.values()) {
    const i = g.deviceIds.indexOf(req.params.id);
    if (i !== -1) g.deviceIds.splice(i, 1);
  }
  void persistState();
  return res.json({ ok: true });
});

app.post('/api/devices/:id/action', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const userId = Buffer.from(user.id).toString('base64url');
  const level = deviceAccessLevel(userId, user.role, device);
  if (level === 'none') return res.status(403).json({ error: 'Permission denied' });

  const { action } = req.body as { action?: string };
  if (!action) return res.status(400).json({ error: 'action is required' });
  // Mutating actions require control; view-level users can only read status / lists / connect URLs.
  if (CONTROL_ACTIONS.has(action) && level !== 'control') {
    return res.status(403).json({ error: 'Control access required' });
  }

  // Zero-knowledge mode: forward to Pi Agent using only the device ID — no config sent over the wire.
  // `actor` (the user's email) is forwarded so the Pi's audit log records WHO triggered the action.
  if (hasPiAgent()) {
    try {
      const r = await piAgentFetch('/proxy', {
        method: 'POST',
        body: JSON.stringify({ ...req.body, deviceId: req.params.id, action, actor: user.email }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pi Agent unreachable';
      return res.status(502).json({ error: `Pi Agent error: ${msg}` });
    }
  }

  // Legacy mode (no Pi Agent): execute directly using locally stored config
  const cfg = device.config;
  if (!cfg) return res.status(503).json({ error: 'Pi Agent required but not configured. Set PI_AGENT_URL in .env.' });

  try {
    if (cfg.type === 'shelly_plug' || cfg.type === 'shelly_light') {
      const channel = (cfg as ShellyPlugConfig).channel ?? 0;
      const relayPath = cfg.type === 'shelly_plug' ? 'relay' : 'light';
      if (action === 'on' || action === 'off' || action === 'toggle') {
        const r = await fetch(`http://${cfg.ip}/${relayPath}/${channel}?turn=${action}`);
        return res.json(await r.json());
      }
      if (action === 'status') {
        const r = await fetch(`http://${cfg.ip}/${relayPath}/${channel}`);
        return res.json(await r.json());
      }
      return res.status(400).json({ error: 'Supported actions: on, off, toggle, status' });
    }

    if (cfg.type === 'wol') {
      if (action !== 'wake') return res.status(400).json({ error: 'WOL only supports wake' });
      await sendWOL(cfg.mac, cfg.broadcastIp, cfg.port);
      return res.json({ ok: true });
    }

    if (cfg.type === 'proxmox') {
      const agent = new httpsModule.Agent({ rejectUnauthorized: !cfg.allowSelfSigned });
      const base = `https://${cfg.ip}:${cfg.port ?? 8006}/api2/json`;
      const node = cfg.node ?? 'pve';
      const headers: Record<string, string> = { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` };
      if (action === 'list_vms') {
        // List both KVM/QEMU VMs and LXC containers, tagged with their kind.
        const [qemuR, lxcR] = await Promise.all([
          fetch(`${base}/nodes/${node}/qemu`, { headers, agent: agent as any } as any),
          fetch(`${base}/nodes/${node}/lxc`,  { headers, agent: agent as any } as any),
        ]);
        if (!qemuR.ok) return res.status(502).json({ error: 'Proxmox API error', status: qemuR.status });
        const qemu = (((await qemuR.json()) as any).data ?? []).map((v: any) => ({ ...v, _kind: 'qemu' }));
        const lxc = lxcR.ok ? (((await lxcR.json()) as any).data ?? []).map((v: any) => ({ ...v, _kind: 'lxc' })) : [];
        return res.json({ data: [...qemu, ...lxc] });
      }
      const { vmId, vmAction, vmKind } = req.body as { vmId?: string; vmAction?: string; vmKind?: string };
      if (vmId && vmAction && ['start', 'stop', 'reboot', 'shutdown'].includes(vmAction)) {
        const kind = vmKind === 'lxc' ? 'lxc' : 'qemu';
        const r = await fetch(`${base}/nodes/${node}/${kind}/${vmId}/status/${vmAction}`, { method: 'POST', headers, agent: agent as any } as any);
        return res.json(await r.json());
      }
      return res.status(400).json({ error: 'Use action=list_vms or provide vmId+vmAction' });
    }

    if (cfg.type === 'rdp' || cfg.type === 'ssh') {
      const protocol = cfg.type;
      const port = cfg.port ?? (protocol === 'rdp' ? 3389 : 22);
      const url = `${protocol}://${(cfg as RdpConfig).username ? `${(cfg as RdpConfig).username}@` : ''}${cfg.ip}:${port}`;
      return res.json({ ok: true, url });
    }

    if (cfg.type === 'web') {
      const scheme = cfg.scheme ?? (cfg.port === 443 || cfg.port === 8443 ? 'https' : 'http');
      const portPart = cfg.port && cfg.port !== 80 && cfg.port !== 443 ? `:${cfg.port}` : '';
      return res.json({ ok: true, url: `${scheme}://${cfg.ip}${portPart}${cfg.path ?? ''}` });
    }

    if (cfg.type === 'http') {
      const actionPath = action === 'on' ? cfg.onPath : (cfg.offPath ?? cfg.onPath);
      const r = await fetch(`http://${cfg.ip}${actionPath}`, { method: cfg.method ?? 'GET' });
      return res.json({ ok: true, status: r.status });
    }

    if (cfg.type === 'tasmota') {
      const ch = req.body.channel ? `${Number(req.body.channel)}` : '';
      if (['on', 'off', 'toggle'].includes(action)) {
        const cmd = `Power${ch}+${action.charAt(0).toUpperCase() + action.slice(1)}`;
        const r = await fetch(`http://${cfg.ip}/cm?cmnd=${encodeURIComponent(cmd)}`);
        return res.json(await r.json());
      }
      if (action === 'status') { const r = await fetch(`http://${cfg.ip}/cm?cmnd=Power${ch}`); return res.json(await r.json()); }
      if (action === 'energy') { const r = await fetch(`http://${cfg.ip}/cm?cmnd=Status+10`); return res.json(await r.json()); }
      return res.status(400).json({ error: 'Supported: on, off, toggle, status, energy' });
    }

    if (cfg.type === 'docker') {
      const base = `http://${cfg.ip}:${cfg.port ?? 2375}`;
      if (action === 'list_containers') {
        const r = await fetch(`${base}/containers/json?all=1`);
        if (!r.ok) return res.status(502).json({ error: 'Docker API error' });
        return res.json(await r.json());
      }
      const { containerId, containerAction } = req.body as { containerId?: string; containerAction?: string };
      if (containerId && containerAction && ['start', 'stop', 'restart', 'pause', 'unpause'].includes(containerAction)) {
        const r = await fetch(`${base}/containers/${containerId}/${containerAction}`, { method: 'POST' });
        return res.json({ ok: r.ok, status: r.status });
      }
      return res.status(400).json({ error: 'Use list_containers or containerId+containerAction' });
    }

    if (cfg.type === 'tailscale') {
      if (action !== 'list_devices') return res.status(400).json({ error: 'Only list_devices is supported' });
      const r = await fetch(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(cfg.tailnet)}/devices`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!r.ok) return res.status(502).json({ error: 'Tailscale API error' });
      return res.json(await r.json());
    }

    return res.status(400).json({ error: 'Unknown device type' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Device action failed';
    console.error('device action error', msg);
    return res.status(502).json({ error: msg });
  }
});

// ── Pi Agent discovery proxy ──────────────────────────────────────────────────

app.get('/api/pi-agent/discovered', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!process.env.PI_AGENT_URL || !process.env.PI_AGENT_SECRET) {
    return res.json({ devices: [], agents: [], configured: false });
  }
  try {
    const [devR, agR, healthR] = await Promise.all([
      fetch(`${process.env.PI_AGENT_URL}/discover/results`, {
        headers: { Authorization: `Bearer ${process.env.PI_AGENT_SECRET}` },
      }),
      fetch(`${process.env.PI_AGENT_URL}/agents`, {
        headers: { Authorization: `Bearer ${process.env.PI_AGENT_SECRET}` },
      }),
      fetch(`${process.env.PI_AGENT_URL}/health`, {
        headers: { Authorization: `Bearer ${process.env.PI_AGENT_SECRET}` },
      }).catch(() => null),
    ]);
    const devices = devR.ok ? await devR.json() : [];
    const agents = agR.ok ? await agR.json() : [];
    const health = healthR && healthR.ok ? await healthR.json() : null;
    const pi = health
      ? { connected: true, version: health.version as string, uptime: health.uptime as number, metrics: health.metrics ?? null }
      : { connected: false };
    return res.json({ devices, agents, configured: true, pi });
  } catch {
    return res.json({ devices: [], agents: [], configured: true, pi: { connected: false } });
  }
});

// Admin-only: the Pi Agent's rolling metric time-series, for the Pi tab's trend charts.
app.get('/api/pi-agent/metrics/history', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.json({ samples: [], configured: false });
  try {
    const r = await piAgentFetch('/metrics/history');
    if (!r.ok) return res.status(502).json({ error: 'Pi Agent error' });
    const data = await r.json() as { samples?: unknown[]; sampleIntervalMs?: number };
    return res.json({ samples: data.samples ?? [], sampleIntervalMs: data.sampleIntervalMs ?? 30000, configured: true });
  } catch {
    return res.status(502).json({ error: 'Pi Agent unreachable' });
  }
});

// Admin-only: notification channel status (no secrets) + a test trigger.
app.get('/api/pi-agent/notify/status', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.json({ enabled: false, channels: [], configured: false });
  try {
    const r = await piAgentFetch('/notify/status');
    if (!r.ok) return res.status(502).json({ error: 'Pi Agent error' });
    return res.json({ ...(await r.json() as object), configured: true });
  } catch {
    return res.status(502).json({ error: 'Pi Agent unreachable' });
  }
});

app.post('/api/pi-agent/notify/test', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.status(400).json({ error: 'Pi Agent not configured' });
  try {
    const r = await piAgentFetch('/notify/test', { method: 'POST' });
    return res.status(r.status).json(await r.json());
  } catch {
    return res.status(502).json({ error: 'Pi Agent unreachable' });
  }
});

app.post('/api/pi-agent/discover', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!process.env.PI_AGENT_URL || !process.env.PI_AGENT_SECRET) {
    return res.status(400).json({ error: 'Pi Agent not configured' });
  }
  try {
    const r = await fetch(`${process.env.PI_AGENT_URL}/discover`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PI_AGENT_SECRET}` },
    });
    return res.json(await r.json());
  } catch {
    return res.status(502).json({ error: 'Pi Agent unreachable' });
  }
});

// ── Just-in-Time remote access (forwarded to the Pi Agent) ────────────────────
// Admin-only. The powerful Tailscale ACL key lives on the Pi, never here.

app.get('/api/access', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.json({ enabled: false, grants: [] });
  try {
    const r = await piAgentFetch('/access');
    return res.status(r.status).json(await r.json());
  } catch { return res.json({ enabled: false, grants: [] }); }
});

app.post('/api/access/grant', async (req, res) => {
  const user = getSessionUser(req);
  if (!user || !isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.status(400).json({ error: 'Pi Agent not configured' });
  const { deviceId, ttl } = req.body as { deviceId?: string; ttl?: number };
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const device = devices.get(deviceId);
  try {
    const r = await piAgentFetch('/access/grant', {
      method: 'POST',
      body: JSON.stringify({ deviceId, label: device?.name ?? deviceId, ttl, actor: user.email }),
    });
    return res.status(r.status).json(await r.json());
  } catch (err) {
    return res.status(502).json({ error: `Pi Agent error: ${(err as Error).message}` });
  }
});

app.post('/api/access/revoke', async (req, res) => {
  const user = getSessionUser(req);
  if (!user || !isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) return res.status(400).json({ error: 'Pi Agent not configured' });
  const { id } = req.body as { id?: string };
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const r = await piAgentFetch('/access/revoke', { method: 'POST', body: JSON.stringify({ id, actor: user.email }) });
    return res.status(r.status).json(await r.json());
  } catch (err) {
    return res.status(502).json({ error: `Pi Agent error: ${(err as Error).message}` });
  }
});

// ── Monitor route ────────────────────────────────────────────────────────────

app.get('/api/monitor/status', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const isAdminUser = user.role === 'root' || user.role === 'admin';
  // Only return statuses for devices the user can access
  const accessible = [...devices.values()]
    .filter((d) => userHasDeviceAccess(userId, user.role, d))
    .map((d) => d.id);
  const statuses = accessible.reduce<Record<string, MonitorStatus>>((acc, id) => {
    const s = monitorStatuses.get(id);
    if (s) acc[id] = s;
    return acc;
  }, {});
  return res.json({ statuses });
});

app.post('/api/monitor/check', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  await runMonitorChecks();
  return res.json({ ok: true, checked: devices.size });
});

// ── Widget routes ─────────────────────────────────────────────────────────────

app.get('/api/widgets', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  return res.json({ widgets: [...widgets.values()].filter((w) => w.userId === userId) });
});

app.post('/api/widgets', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const { layout, config } = req.body as { layout?: WidgetLayout; config?: WidgetConfig };
  if (!layout || !config || !config.type) return res.status(400).json({ error: 'layout and config.type required' });
  const id = crypto.randomBytes(12).toString('base64url');
  const widget: WidgetRecord = { id, userId, layout, config };
  widgets.set(id, widget);
  void persistState();
  return res.status(201).json({ widget });
});

app.patch('/api/widgets/:id', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const widget = widgets.get(req.params.id);
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  if (widget.userId !== userId && !isAdmin(req)) return res.status(403).json({ error: 'Not your widget' });
  const { layout, config } = req.body as { layout?: WidgetLayout; config?: WidgetConfig };
  if (layout) widget.layout = layout;
  if (config) widget.config = config;
  void persistState();
  return res.json({ widget });
});

app.delete('/api/widgets/:id', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const userId = Buffer.from(user.id).toString('base64url');
  const widget = widgets.get(req.params.id);
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  if (widget.userId !== userId && !isAdmin(req)) return res.status(403).json({ error: 'Not your widget' });
  widgets.delete(req.params.id);
  void persistState();
  return res.json({ ok: true });
});

// ── Access group routes (admin) ─────────────────────────────────────────────────
// Deny-by-default access control. A group scopes devices (by id and/or tag) and grants
// view or control over them to its members. No group = no access.

const sanitizeStrings = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, max) : [];

app.get('/api/admin/groups', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  return res.json({ groups: [...accessGroups.values()] });
});

app.post('/api/admin/groups', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { name, deviceIds, tags, level, members } = req.body as Partial<AccessGroup>;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const id = crypto.randomBytes(9).toString('base64url');
  const group: AccessGroup = {
    id,
    name: String(name).trim().slice(0, 60),
    deviceIds: sanitizeStrings(deviceIds),
    tags: sanitizeStrings(tags),
    level: level === 'control' ? 'control' : 'view',
    members: sanitizeStrings(members),
  };
  accessGroups.set(id, group);
  void persistState();
  return res.status(201).json({ group });
});

app.patch('/api/admin/groups/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const group = accessGroups.get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { name, deviceIds, tags, level, members } = req.body as Partial<AccessGroup>;
  if (name !== undefined) group.name = String(name).trim().slice(0, 60) || group.name;
  if (deviceIds !== undefined) group.deviceIds = sanitizeStrings(deviceIds);
  if (tags !== undefined) group.tags = sanitizeStrings(tags);
  if (level !== undefined) group.level = level === 'control' ? 'control' : 'view';
  if (members !== undefined) group.members = sanitizeStrings(members);
  void persistState();
  return res.json({ group });
});

app.delete('/api/admin/groups/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!accessGroups.delete(req.params.id)) return res.status(404).json({ error: 'Group not found' });
  void persistState();
  return res.json({ ok: true });
});

// Remove a user entirely: their passkeys, sessions, widgets and group memberships.
// Guards: only admins, can't delete yourself or a root account.
app.delete('/api/admin/users/:id', (req, res) => {
  const actor = getSessionUser(req);
  if (!actor || !(actor.role === 'root' || actor.role === 'admin')) return res.status(403).json({ error: 'Admin access required' });
  const target = [...usersByEmail.values()].find((u) => Buffer.from(u.id).toString('base64url') === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (Buffer.from(actor.id).toString('base64url') === req.params.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (target.role === 'root') return res.status(400).json({ error: 'The root account cannot be deleted' });

  usersByEmail.delete(target.email);
  for (const [token, e] of sessions) if (e.userId === req.params.id) sessions.delete(token);
  for (const [id, w] of widgets) if (w.userId === req.params.id) widgets.delete(id);
  for (const g of accessGroups.values()) {
    const i = g.members.indexOf(req.params.id);
    if (i !== -1) g.members.splice(i, 1);
  }
  void persistState();
  return res.json({ ok: true });
});

// ── Audit log (admin) ──────────────────────────────────────────────────────────
// Proxies the Pi Agent's internal activity log over Tailscale. The detailed
// trail (which local IP was contacted, latency, errors) lives only on the Pi.

app.get('/api/admin/audit', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  if (!hasPiAgent()) {
    return res.json({ entries: [], configured: false });
  }
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const kindParam = typeof req.query.kind === 'string' ? `&kind=${encodeURIComponent(req.query.kind)}` : '';
    const r = await piAgentFetch(`/audit?limit=${limit}${kindParam}`);
    if (!r.ok) return res.status(502).json({ error: 'Pi Agent error' });
    const data = await r.json() as { entries: unknown[] };
    return res.json({ entries: data.entries ?? [], configured: true });
  } catch {
    return res.status(502).json({ error: 'Pi Agent unreachable' });
  }
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
