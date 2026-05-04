export const env = {
  sessionSecret: process.env.SESSION_SECRET ?? '',
  rpName: process.env.RP_NAME ?? 'Shyy Dashboard',
  rpID: process.env.RP_ID ?? '',
  origin: process.env.ORIGIN ?? '',
  tsContainerName: process.env.TS_CONTAINER_NAME ?? 'teamspeak',
  homeserverMac: process.env.HOMESERVER_MAC ?? '',
  tailscaleHomeIP: process.env.TAILSCALE_HOME_IP ?? '',
};

export function assertEnv() {
  const required = ['SESSION_SECRET', 'RP_ID', 'ORIGIN', 'DATABASE_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}
