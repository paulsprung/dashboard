# shyy-dashboard

Production-ready starter for a private infrastructure dashboard with passkey-only auth.

## Stack
Next.js (App Router), TypeScript, TailwindCSS, Prisma, PostgreSQL, SimpleWebAuthn.

## Setup (Codespaces or Server)
1. Copy env: `cp .env.example .env` and edit values.
2. Install deps: `npm install`
3. Start Postgres: `docker compose up -d db`
4. Run migrations: `npx prisma migrate dev --name init`
5. Start app: `npm run dev`
6. Open `/setup` once to create owner + first passkey.

## Production (Docker Compose)
1. Set real domain values in `.env` (`RP_ID`, `ORIGIN`) and strong `SESSION_SECRET`.
2. `docker compose build`
3. `docker compose up -d`
4. Run migrations in app container: `docker compose exec app npx prisma migrate deploy`

## Security notes
- Passkey-only auth (no passwords).
- WebAuthn challenge flows with expected origin + RP ID checks.
- HTTP-only secure same-site sessions.
- Origin check + explicit confirm phrases for dangerous actions.
- Audit logs for login and actions.

## Placeholder actions
- TeamSpeak restart/status are stubbed in `lib/action-runner.ts` until Docker socket integration is enabled.
- Homeserver wake sends Wake-on-LAN magic packet.
