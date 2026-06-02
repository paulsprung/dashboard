# SM Dashboard

A self-hosted home dashboard with Passkey authentication, device management, and real-time monitoring.

## Architecture

```
Internet
   │
   ▼
┌─────────────────────────────────┐
│  Hetzner VPS (DMZ)              │
│  ┌───────────────────────────┐  │
│  │  dashboard/               │  │
│  │  - Passkey auth           │  │
│  │  - React frontend         │  │
│  │  - Device config store    │  │
│  │  - Widget system          │  │
│  └───────────────────────────┘  │
└────────────────┬────────────────┘
                 │ Tailscale VPN
                 ▼
┌─────────────────────────────────┐
│  Raspberry Pi (Home Network)    │
│  ┌───────────────────────────┐  │
│  │  pi-agent/                │  │
│  │  - Device proxy           │  │
│  │  - ARP + mDNS discovery   │  │
│  │  - Host agent registry    │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌──────────┐ ┌──────────────┐  │
│  │ Proxmox  │ │ Docker Host  │  │
│  │ host-agent│ │ host-agent  │  │
│  └──────────┘ └──────────────┘  │
│                                 │
│  Smart Plugs, Lights, etc.      │
└─────────────────────────────────┘
```

**Key design decisions:**
- Auth surface stays on Hetzner (hardened DMZ) — the Pi is never directly reachable from the internet
- Pi Agent listens only on its Tailscale IP — not exposed to internet
- Device credentials are stored on the dashboard server, never sent from the browser
- SSRF protection: all device IPs/tokens come from server-side config, never from request body

---

## Components

| Folder | Runs on | Purpose |
|--------|---------|---------|
| `dashboard/` | Hetzner VPS | Web UI + API server + auth |
| `pi-agent/` | Raspberry Pi | Local device proxy + discovery |
| `host-agent/` | Any server (Proxmox, Docker, etc.) | Auto-registers IP with Pi Agent |

---

## 1. Tailscale Setup

Both Hetzner and Pi must be on the same Tailscale network.

```bash
# On Hetzner
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On Raspberry Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Enable subnet routing on Pi (so Hetzner can reach local devices via Pi)
sudo tailscale up --advertise-routes=192.168.1.0/24 --accept-routes
```

In the Tailscale admin panel, approve the subnet route advertised by the Pi.

Get the Pi's Tailscale IP:
```bash
tailscale ip -4   # e.g. 100.64.0.2
```

---

## 2. Pi Agent Setup

The Pi Agent runs on your Raspberry Pi and handles:
- Proxying device commands from the dashboard
- Discovering devices on your local network (ARP + mDNS)
- Receiving heartbeats from host agents

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

`.env` configuration:

```env
# Secret shared with the dashboard — must be long and random
AGENT_SECRET=generate_with_openssl_rand_hex_32

# Port to listen on (default 3002)
PORT=3002

# Bind only to Tailscale interface (security: not exposed to local network)
BIND_HOST=100.64.0.2   # Your Pi's Tailscale IP

# Local subnet for ARP discovery (e.g. your home network)
LOCAL_SUBNET=192.168.1.0/24
```

> **Security note:** Set `BIND_HOST` to your Pi's Tailscale IP (`tailscale ip -4`).
> This ensures the agent is only reachable through the Tailscale tunnel, not from your local network.

### Start

```bash
docker compose up -d --build
docker compose logs -f
```

### Verify

```bash
# From the Hetzner server (through Tailscale)
curl -H "Authorization: Bearer <your_secret>" http://100.64.0.2:3002/agents
```

---

## 3. Dashboard Setup (Hetzner)

### Requirements
- Docker + Docker Compose
- A domain with DNS pointing to the server
- Tailscale installed (joined to same network as Pi)

### Install

```bash
git clone https://github.com/paulsprung/sm-dashboard.git
cd sm-dashboard/dashboard
cp .env.example .env
nano .env
```

`.env` configuration:

```env
# PostgreSQL (internal to Docker network)
POSTGRES_USER=sm_dashboard
POSTGRES_PASSWORD=generate_strong_password_here
POSTGRES_DB=sm_dashboard

DATABASE_URL=postgresql://sm_dashboard:<password>@postgres:5432/sm_dashboard

# WebAuthn / Passkey settings
RP_ID=dashboard.yourdomain.com         # hostname only, no https://
RP_NAME=SM Dashboard
ORIGIN=https://dashboard.yourdomain.com

# Pi Agent connection (via Tailscale)
PI_AGENT_URL=http://100.64.0.2:3002    # Pi's Tailscale IP
PI_AGENT_SECRET=same_secret_as_pi_agent

# Session secret
SESSION_SECRET=generate_with_openssl_rand_hex_32

PORT=3001
```

### Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f sm-dashboard
```

### Reverse Proxy (Nginx example)

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

1. Navigate to `https://dashboard.yourdomain.com`
2. Enter your email address
3. Click **Register passkey** — this uses your device's biometrics/PIN
4. On subsequent visits, click **Sign in with passkey**

---

## 4. Host Agent Setup (Optional)

The host agent runs on servers (Proxmox, Docker hosts, etc.) and automatically registers
their current IP with the Pi Agent. This solves the DHCP problem — you don't need to
manually update IPs when they change.

### What it detects automatically
- Primary IP address (and Tailscale IP if present)
- Docker (checks `/var/run/docker.sock` or TCP port 2375)
- Proxmox (checks TCP port 8006)

### Install with npm

```bash
git clone https://github.com/paulsprung/sm-dashboard.git
cd sm-dashboard/host-agent
npm install
cp .env.example .env
nano .env
```

`.env` configuration:

```env
# Pi Agent URL (Tailscale IP)
PI_AGENT_URL=http://100.64.0.2:3002

# Must match AGENT_SECRET in pi-agent/.env
AGENT_SECRET=same_secret_as_pi_agent

# Optional: override auto-detected hostname
# HOSTNAME_OVERRIDE=my-proxmox-server

# Heartbeat interval in seconds (default: 30)
HEARTBEAT_INTERVAL=30
```

### Start

```bash
npm start
```

### Run as systemd service

Create `/etc/systemd/system/sm-host-agent.service`:

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

Or with tsx directly (if installed globally):

```ini
ExecStart=/usr/local/bin/tsx src/index.ts
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sm-host-agent
sudo systemctl start sm-host-agent
sudo systemctl status sm-host-agent
```

### View registered agents

In the Pi Agent API:
```bash
curl -H "Authorization: Bearer <secret>" http://100.64.0.2:3002/agents
```

---

## 5. Adding Devices

Once the dashboard is running, go to **Settings → Devices → Add Device**.

### Supported Device Types

| Type | Protocol | What you need |
|------|----------|---------------|
| Shelly Plug | HTTP | IP address |
| Shelly Light | HTTP | IP address |
| Tasmota | HTTP | IP address (NOUS A5T, Sonoff, Gosund, etc.) |
| Wake-on-LAN | UDP | MAC address + broadcast address |
| Proxmox | HTTPS REST | IP, API token (`user@pve!tokenid=secret`) |
| Docker | HTTP | IP + port (default 2375) |
| RDP | TCP link | IP + port |
| SSH | TCP link | IP + port |
| Tailscale | API | API key + tailnet name |
| HTTP | HTTP | URL |

### Using Device Discovery

Instead of manually entering IPs, use the discovery scanner:

1. Go to **Settings → Devices → Discover Devices**
2. The Pi Agent scans your local network via ARP table + mDNS
3. Detected devices appear with their type pre-filled
4. Click **Add** to save a device

Discovery automatically detects:
- Shelly devices (via `_shelly._tcp` mDNS + `/shelly` endpoint)
- Tasmota devices (via `_http._tcp` mDNS + `/cm` endpoint)
- Docker hosts (via TCP probe on port 2375)
- Proxmox hosts (via TCP probe on port 8006)

---

## 6. Widgets

Go to **Settings → Widgets → Add Widget** to add widgets to your dashboard.

Available widgets:

| Widget | Description |
|--------|-------------|
| Clock | Live time display |
| Weather | Current weather (requires OpenWeatherMap API key) |
| Device Toggle | On/off switch for a smart plug or light |
| Wake-on-LAN Button | One-click WOL magic packet |
| Proxmox VMs | List VMs with CPU/RAM stats + Start/Stop/Reboot |
| Energy | Power consumption graph for Tasmota devices |
| Docker | Container list with start/stop/restart |
| Tailscale Peers | Peer list with online status |
| Service Monitor | TCP health check for any host:port |
| Note | Freetext sticky note |

---

## 7. User Permissions

Admins can grant or revoke specific permissions per user.

Go to **Admin → Users → (select user) → Permissions**.

| Permission | Allows |
|------------|--------|
| `control:plugs` | Toggle smart plugs |
| `control:lights` | Toggle lights |
| `control:wol` | Send WOL packets |
| `view:proxmox` | View Proxmox VMs |
| `control:proxmox` | Start/stop/reboot VMs |
| `view:rdp` | See RDP device links |
| `view:ssh` | See SSH device links |
| `control:http` | Trigger HTTP actions |
| `control:tasmota` | Control Tasmota devices |
| `view:docker` | View Docker containers |
| `control:docker` | Start/stop/restart containers |
| `view:tailscale` | View Tailscale peers |

---

## 8. Service Monitor

The dashboard runs TCP health checks every 30 seconds against all configured devices.

- Green dot = reachable (latency shown in ms)
- Red dot = unreachable

This is visible on device cards and in the **Service Monitor** widget.

---

## Development

### Dashboard

```bash
cd dashboard
npm install
cp .env.example .env
# Edit .env with your settings

# Start backend (port 3001)
npm run server:dev

# Start frontend (port 5173) — in a separate terminal
npm run dev
```

### Pi Agent

```bash
cd pi-agent
npm install
cp .env.example .env
npm run dev
```

### Host Agent

```bash
cd host-agent
npm install
cp .env.example .env
npm run dev
```

---

## Security Notes

- **Never expose the Pi Agent on a public IP.** Bind it to the Tailscale interface only.
- **Rotate `AGENT_SECRET` regularly.** It's the only auth between dashboard and Pi Agent.
- **Passkey credentials** are stored in the PostgreSQL database. Back up the database volume.
- **Device tokens** (Proxmox API tokens, Tailscale API keys) are stored on the server only and never sent to the browser.
- **Proxmox self-signed certs** are accepted by design for internal use. If your Proxmox has a valid cert, remove `rejectUnauthorized: false` from the Proxmox handler in `dashboard/server/index.ts`.
