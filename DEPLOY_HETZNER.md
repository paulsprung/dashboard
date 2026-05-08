# Hetzner + Docker deployment (PostgreSQL included)

## 1) Copy and configure environment
```bash
cp .env.example .env
nano .env
```
Set strong values for:
- `POSTGRES_PASSWORD`
- `RP_ID` (your domain)
- `ORIGIN` (https://your-domain)

## 2) Start services
```bash
docker compose up -d --build
```

## 3) Verify containers
```bash
docker compose ps
docker compose logs -f sm-dashboard
```

## 4) Backup Postgres (example)
```bash
docker exec sm-dashboard-postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup_$(date +%F).sql
```

## Notes
- Postgres is internal to Docker network (no host port exposed).
- Data persists in Docker volume `pg_data`.
- When DB migrations are introduced (Prisma/Drizzle), run migrations after deploy.
