# SM Dashboard

A self-hosted home dashboard with Passkey authentication, device management, and real-time monitoring — built so the internet-facing server knows as little as possible about your home network.

## Architecture

```
                 Internet
                    │
                    ▼
   ┌──────────────────────────────────┐
   │  Hetzner VPS  (DMZ / public)     │
   │  dashboard/                      │
   │   • Passkey auth (WebAuthn)      │
   │   • React frontend               │
   │   • Knows ONLY: device name,     │
   │     type, room, tags, groups     │
   │   • NO IPs, MACs, tokens         │
   └──────────────┬───────────────────┘
                  │  Tailnet A (infra)
                  │  Hetzner ⇄ Pi only
                  ▼
   ┌──────────────────────────────────┐
   │  Raspberry Pi  (home network)    │
   │  pi-agent/                       │
   │   • Stores ALL secrets locally   │
   │     (IPs, MACs, API tokens)      │
   │   • Executes device commands     │
   │   • TCP health checks            │
   │   • ARP + mDNS discovery         │
   │   • Host-agent registry          │
   │   • Internal activity log        │
   └───┬───────────────────────┬──────┘
       │ local LAN             │ Tailnet B (personal)
       ▼                       ▼
  Smart Plugs,          Gaming PC, your
  Lights, Tasmota,      phone/laptop
  Proxmox, Docker…      (Moonlight, RDP — direct P2P)
       ▲
       │  host-agent/ (optional, on servers)
       │  reports current IP via heartbeat
```

### Key design decisions

- **Zero-knowledge dashboard.** Hetzner stores only device *metadata* (name, type, room, tags) plus access groups. Every sensitive value — IP, MAC, Proxmox token, Tailscale key — lives **only** on the Pi. If Hetzner is ever compromised, the attacker learns device *names and types*, nothing that lets them reach your network.
- **Auth stays on Hetzner.** The hardened public DMZ handles Passkey login. The Pi is never directly reachable from the internet.
- **Pi Agent binds to its Tailscale IP only.** Not exposed to the local LAN or the internet.
- **Two separate Tailnets** (recommended) to limit blast radius — see below.

### Two-Tailnet design (recommended)

Putting everything in one Tailnet means a compromised Hetzner could reach your personal devices. Split them:

| Device | Tailnet A (infra) | Tailnet B (personal) |
|--------|:-----------------:|:--------------------:|
| Hetzner | ✅ | ❌ |
| Raspberry Pi | ✅ | ✅ |
| Gaming PC | ❌ | ✅ |
| Phone / Laptop | ❌ | ✅ |

- **Tailnet A** (a dedicated service account): only Hetzner ⇄ Pi. This is the path the dashboard uses.
- **Tailnet B** (your personal account): Pi + your personal devices, used for direct connections (Moonlight game streaming, RDP) that never touch Hetzner.

The Pi is the only bridge, and only you control Tailnet B. A breach of Hetzner stays contained in Tailnet A.

---

## How it works (data flows)

### Adding a device
```
You type in dashboard:  name, type, IP, MAC, token …
        │
        ▼
Hetzner keeps ONLY:  name, type, room, tags
        │  forwards the rest over Tailnet A ↓
        ▼
Pi stores permanently in data/device-configs.json:
        IP, MAC, token, port …
```
When you **edit** a device, the dashboard fetches the config from the Pi on demand (admins only, shown in the form, never written to Postgres).

### Triggering an action
```
Browser → Hetzner:  POST /api/devices/<id>/action  { action: "on" }
Hetzner → Pi:       POST /proxy  { deviceId, action, actor: you@email }
                    (no IP/token crosses the wire — just the device ID)
Pi looks up the config locally → contacts the device → returns the result
Pi writes an audit entry: who, what, which target, status, latency
```

### Health checks (three independent mechanisms)
```
A) host-agent  →  Pi      every 30s: "I'm alive, my IP is X"   (solves DHCP)
B) Pi          →  devices every 30s: TCP probe → online? latency?
C) Hetzner     →  Pi      every 30s: GET /devices/monitor (pulls statuses)
```
Hetzner **never** probes your LAN — it only asks the Pi for the aggregated result.

### Activity log
The Pi keeps the detailed internal trail (which IP was contacted, status code, latency, errors) in `data/audit.log`. The dashboard reads it over Tailscale for admins (**Admin → Aktivitätsprotokoll**). Hetzner additionally knows *who* requested each action; the Pi records that `actor` in the same log entry, so you get a full who-did-what-to-which-device picture in one place.

---

## Components

| Folder | Runs on | Purpose |
|--------|---------|---------|
| `dashboard/` | Hetzner VPS | Web UI + API + auth. Stores device metadata only. |
| `pi-agent/` | Raspberry Pi | Stores secrets, executes commands, discovery, health checks, audit log |
| `host-agent/` | Any server (Proxmox, Docker…) | Auto-reports its current IP to the Pi Agent |

---

## 1. Tailscale Setup

Minimum (single Tailnet): both Hetzner and Pi on the same network.

```bash
# On Hetzner
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On Raspberry Pi — advertise the LAN subnet so the Pi can reach local devices
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-routes=192.168.1.0/24 --accept-routes
```

Approve the advertised subnet route in the Tailscale admin panel, then get the Pi's IP:
```bash
tailscale ip -4   # e.g. 100.64.0.2
```

For the **two-Tailnet** setup, run Hetzner+Pi on a dedicated service account (Tailnet A), and join the Pi to your personal account (Tailnet B) as well. Use Tailscale ACLs to keep the two groups isolated except for the Pi.

---

## 2. Pi Agent Setup

Handles device commands, discovery, host-agent registration, health checks, and the activity log. **All secrets live here.**

### Requirements
- Docker + Docker Compose
- Tailscale installed (so it has a `100.x.x.x` IP)

### Install

```bash
git clone https://github.com/paulsprung/sm-dashboard.git
cd sm-dashboard/pi-agent
cp .env.example .env
nano .env
```

`.env`:

```env
# Secret shared with the dashboard — must be long and random
AGENT_SECRET=generate_with_openssl_rand_hex_32

# Port to listen on (default 3002)
PORT=3002

# Bind ONLY to the Tailscale interface (not the LAN, not the internet)
BIND_HOST=100.64.0.2          # your Pi's Tailscale IP

# Local subnet for ARP discovery
LOCAL_SUBNET=192.168.1.0/24

# Where device configs + audit log are stored (persisted via Docker volume)
DATA_DIR=./data
```

> **Security note:** Set `BIND_HOST` to the Pi's Tailscale IP (`tailscale ip -4`) so the
> agent is reachable only through the tunnel. The `data/` directory holds your secrets
> and audit log — it is mounted as a Docker volume so it survives restarts. Back it up.

### Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

### Verify

```bash
# From Hetzner, over Tailscale
curl -H "Authorization: Bearer <your_secret>" http://100.64.0.2:3002/agents
curl -H "Authorization: Bearer <your_secret>" http://100.64.0.2:3002/audit?limit=20
```

---

## 3. Dashboard Setup (Hetzner)

### Requirements
- Docker + Docker Compose
- A domain with DNS pointing to the server
- Tailscale installed (joined to the same Tailnet as the Pi — Tailnet A)

### Install

```bash
git clone https://github.com/paulsprung/sm-dashboard.git
cd sm-dashboard/dashboard
cp .env.example .env
nano .env
```

`.env`:

```env
# PostgreSQL (internal to Docker network) — stores users, sessions, device METADATA
POSTGRES_USER=sm_dashboard
POSTGRES_PASSWORD=generate_strong_password_here
POSTGRES_DB=sm_dashboard
DATABASE_URL=postgresql://sm_dashboard:<password>@postgres:5432/sm_dashboard

# WebAuthn / Passkey
RP_ID=dashboard.yourdomain.com         # hostname only, no https://
RP_NAME=SM Dashboard
ORIGIN=https://dashboard.yourdomain.com

# Pi Agent connection (over Tailscale). Setting this enables zero-knowledge mode:
# the dashboard forwards configs to the Pi and stops storing them locally.
PI_AGENT_URL=http://100.64.0.2:3002
PI_AGENT_SECRET=same_secret_as_pi_agent

PORT=3001
```

> **Without `PI_AGENT_URL`** the dashboard runs in *legacy mode*: it stores device configs
> locally and talks to devices directly (handy for local development). For the secure
> production setup, always set `PI_AGENT_URL`.

### Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f sm-dashboard
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name dashboard.yourdomain.com;
    ssl_certificate     /etc/letsencrypt/live/dashboard.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dashboard.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### First Login

1. Open `https://dashboard.yourdomain.com`
2. Enter your email → **Register passkey** (uses Face ID / Touch ID / PIN)
3. On later visits → **Sign in with passkey**

---

## 4. Host Agent Setup (Optional)

Runs on servers (Proxmox, Docker hosts…) and auto-reports their current IP to the Pi Agent — so you never have to chase DHCP changes.

### Auto-detects
- Primary IP (and Tailscale IP if present)
- Docker (`/var/run/docker.sock` or TCP 2375)
- Proxmox (TCP 8006)

### Install

```bash
cd sm-dashboard/host-agent
npm install
cp .env.example .env
nano .env
```

`.env`:

```env
PI_AGENT_URL=http://100.64.0.2:3002
AGENT_SECRET=same_secret_as_pi_agent
# HOSTNAME_OVERRIDE=my-proxmox-server
HEARTBEAT_INTERVAL=30
```

### Run as systemd service

`/etc/systemd/system/sm-host-agent.service`:

```ini
[Unit]
Description=SM Dashboard Host Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sm-dashboard/host-agent
EnvironmentFile=/opt/sm-dashboard/host-agent/.env
ExecStart=/usr/bin/node --import tsx/esm src/index.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sm-host-agent
sudo systemctl status sm-host-agent
```

Registered agents appear in **Admin → Aktivitätsprotokoll** and at `GET /agents` on the Pi.

---

## 5. Adding Devices

In the dashboard: **Settings → Devices → Add Device**. You enter the full details once;
the dashboard forwards everything sensitive to the Pi and keeps only the metadata.

### Supported Device Types

| Type | Protocol | What you provide |
|------|----------|------------------|
| Shelly Plug | HTTP | IP address |
| Shelly Light | HTTP | IP address |
| Tasmota | HTTP | IP (NOUS A5T, Sonoff, Gosund…) |
| Philips Hue | HTTP (bridge API v1) | Bridge IP — paired in-app (press link button), then pick a room/light |
| Wake-on-LAN | UDP | MAC + broadcast address |
| Proxmox | HTTPS REST | IP, API token (`user@pam!id` + secret) |
| Docker | HTTP | IP + port (default 2375) |
| RDP | link | IP + port |
| SSH | link | IP + port |
| Tailscale | API | API key + tailnet |
| HTTP | HTTP | IP + on/off paths |

### Device Discovery (no manual IPs)

1. **Settings → Devices → Discover Devices**
2. The Pi scans the LAN via ARP table + mDNS and probes known ports
3. Detected devices come back with the type pre-filled — click **Add**

Detects Shelly (`_shelly._tcp` + `/shelly`), Tasmota (`_http._tcp` + `/cm`), Docker (port 2375), Proxmox (port 8006).

### Philips Hue

Choose **💡 Philips Hue** as the type. Click **Find** to auto-discover the bridge IP
(or type it), press the round **link button** on top of the bridge, then click **Pair
bridge** within 30 seconds. The dashboard fetches your rooms and lights — pick which one
this card controls (a whole room/zone or a single bulb). The card then shows **On / Off /
Toggle**. The bridge application key is created via the local API and stored on the Pi
only; the bridge itself is reached from the Pi over the LAN.

---

## 6. Widgets

**Settings → Widgets → Add Widget**:

| Widget | Description |
|--------|-------------|
| Clock | Live time |
| Weather | Current weather |
| Device Toggle | On/off for a plug or light |
| Wake-on-LAN | One-click magic packet |
| Proxmox VMs | VM list with CPU/RAM + Start/Stop/Reboot |
| Energy | Tasmota power consumption |
| Docker | Container list with start/stop/restart |
| Tailscale Peers | Peer list with online status |
| Service Monitor | Reachability of your devices |
| Note | Freetext sticky note |

---

## 7. Access control (groups)

Access is **deny-by-default**: a regular `user` (or `readonly`) sees and controls
**nothing** until an admin puts them in an **access group**.

**Admin → Users & Roles → Access groups → + Group**. A group has:

- **Members** — the users it applies to
- **Devices** — specific devices (and/or device **tags**, e.g. `wohnzimmer`) it scopes
- **Level** — `view` (read status / open links) or `control` (toggle, wake, start/stop)

A device is in a group's scope if the group lists it directly **or** the device carries
one of the group's tags — so tagging a new light `wohnzimmer` automatically grants it to
the "Kids → control wohnzimmer" group. A user's effective access is the union of all their
groups (control wins over view).

| Role | Access |
|------|--------|
| `root` / `admin` | Everything, plus device & group management |
| `user` | Only what their groups grant (view or control) |
| `readonly` | Same scope as their groups, but **never** control — capped at view |

Mutating actions (on/off, wake, VM/container start-stop) require `control`; the server
enforces this regardless of what the UI shows.

---

## 8. Service Monitor

The **Pi Agent** runs TCP health checks every 30s against each device (it's the one that
knows the IPs). The dashboard pulls the aggregated result every 30s via `GET /devices/monitor`.

- Green dot = reachable (latency in ms)
- Red dot = unreachable

Shown on device cards and the **Service Monitor** widget. In legacy mode (no Pi Agent),
the dashboard runs the checks itself.

---

## 9. Notifications / Alerts

The **Pi Agent** sends push alerts — it's the one that watches device reachability and
its own health, and it keeps working even if the public dashboard is down. Configure any
channel(s) in `pi-agent/.env` (secrets stay on the Pi) and restart the agent:

| Channel | Env vars |
|---------|----------|
| **ntfy** | `NTFY_URL` (a topic URL, self-hosted or `https://ntfy.sh/<topic>`) |
| **Webhook** | `ALERT_WEBHOOK_URL` (receives a JSON POST `{ title, message, priority, tags, ts }`) |
| **Telegram** | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |

Alerts fire on:

- **Device offline / back online** — a monitored device stops/starts responding.
- **Pi health** — temperature, disk or memory crossing a threshold (`ALERT_TEMP_C`=75,
  `ALERT_DISK_PCT`=90, `ALERT_MEM_PCT`=92 by default). Fires on the way up, sends a
  "recovered" once it drops back down — no spamming.

Manage and test it under the **Pi** tab → *Alerts* (shows the active channels and
thresholds, with a **Send test** button). Every alert is also written to the activity log.

---

## 10. Activity Log

The Pi records every internal operation to `data/audit.log` (JSON-lines, also streamed to
`docker compose logs`):

- **action** — device command executed (with target, status, latency, and the `actor`)
- **config_create / update / delete** — device configuration changes
- **agent_register / agent_ip_change** — host agents joining or changing IP
- **discovery** — network scans
- **auth_fail** — rejected requests (bad bearer token)

View it in the dashboard under **Admin → Aktivitätsprotokoll** (proxied over Tailscale),
or directly: `curl -H "Authorization: Bearer <secret>" http://100.64.0.2:3002/audit?limit=50`.

The detailed internal trail never leaves the Pi/Tailscale tunnel.

---

## Development

```bash
# Dashboard (legacy mode if PI_AGENT_URL unset)
cd dashboard && npm install && cp .env.example .env
npm run server:dev          # backend :3001
npm run dev                 # frontend :5173 (separate terminal)

# Pi Agent
cd pi-agent && npm install && cp .env.example .env
npm run dev

# Host Agent
cd host-agent && npm install && cp .env.example .env
npm run dev
```

---

## Hardening a shared Hetzner host

If your Hetzner box **only** runs the dashboard, the default `compose.yml` is fine.
But if the same server also hosts other services (a website, a TeamSpeak/game server,
etc.), there's a real risk: those services share the host, and if Tailscale runs on the
**host**, a compromise of *any* of them could pivot through Tailscale to the Pi.

Close that off with two layers:

### Layer 1 — Tailscale ACL (do this regardless)

Tag the two machines and allow the Hetzner node to reach **only** the Pi agent port.
Even if an attacker lands on the host, they can't reach anything else on the tailnet —
not your personal devices, not SSH, just `100.x:3002` (which still needs `AGENT_SECRET`).

In the Tailscale admin console (Access Controls):

```json
{
  "tagOwners": {
    "tag:hetzner": ["autogroup:admin"],
    "tag:pi":      ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["tag:hetzner"], "dst": ["tag:pi:3002"] }
  ]
}
```

Tag the Pi as `tag:pi` (`tailscale up --advertise-tags=tag:pi`) and use a `tag:hetzner`
auth key for the dashboard. Now `tag:hetzner` literally cannot open any other connection.

### Layer 2 — Tailscale only inside the dashboard container

Run Tailscale as a **sidecar** so the host kernel and sibling containers have no tailnet
route at all — only the dashboard container does. Use the provided compose file:

```bash
cd dashboard
# create a tagged auth key at https://login.tailscale.com/admin/settings/keys (tag:hetzner)
echo "TS_AUTHKEY=tskey-auth-..." >> .env
docker compose -f compose.tailscale-sidecar.yml up -d --build
```

How it works: `sm-dashboard` uses `network_mode: "service:tailscale"`, so it shares the
sidecar's network namespace and is the *only* container on the tailnet. Your website or
TeamSpeak container is on the normal Docker network and has **no path** to `100.x`.

Combined, even a fully popped TeamSpeak can't reach the Pi: it has no tailnet route
(Layer 2), and the dashboard's tailnet identity can only touch `Pi:3002` (Layer 1), which
in turn requires the shared secret.

---

## Security Notes

- **Zero-knowledge by default.** With `PI_AGENT_URL` set, Hetzner never stores or sees device IPs, MACs, or tokens — they go straight to the Pi.
- **Never expose the Pi Agent publicly.** Bind it to the Tailscale IP only.
- **Back up `pi-agent/data/`.** It holds your device secrets and the audit log.
- **Rotate `AGENT_SECRET`.** It's the only credential between dashboard and Pi.
- **Passkeys + metadata** live in PostgreSQL on Hetzner — back up that volume too.
- **Proxmox self-signed certs** are accepted by design for internal use. With a valid cert, set `allowSelfSigned: false` on the device.
- **Two Tailnets** keep a Hetzner breach away from your personal devices.
- **Shared host?** Run Tailscale as a sidecar + lock the ACL to `Pi:3002` (see "Hardening a shared Hetzner host"), so co-located services can't pivot to the Pi.
