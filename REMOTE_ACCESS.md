# Just-in-Time Remote Access (Tailscale)

Open **time-boxed** access to a single device (e.g. your Proxmox web UI) on
demand, straight from the dashboard — without giving anything standing access to
your whole LAN.

When you click **🔐 Connect** on a device, the Pi-Agent adds a temporary rule to
your Tailscale ACL (`you → device-ip:port`), valid for a few minutes. You connect
over the Tailscale tunnel, do your work, and the rule auto-removes itself.

---

## Why this is safe (threat review)

| Concern | How it's handled |
|---|---|
| "Anyone could reach my LAN" | **Default-deny.** The live policy = *your baseline file* + only the *currently active* grants. Nothing else is reachable. |
| "A standing tunnel is always open" | **Time-boxed.** Each grant has a TTL (default 15 min, hard cap 4 h). A sweeper removes expired grants and re-applies the ACL, closing access again. |
| "Who can open a grant?" | **Authenticated admins only.** Request → passkey-authed admin → dashboard (`isAdmin`) → Pi (Bearer `AGENT_SECRET`) → Tailscale. No anonymous path. |
| "What does a grant expose?" | **One identity → one ip:port.** Not the subnet, not other devices, not other users. Only `TS_ADMIN_IDENTITY` may use it. |
| "The ACL API key is powerful" | It lives **only on the Pi** (`TS_API_KEY`), never on the internet-facing dashboard. The dashboard can't touch your tailnet directly. |
| "A bug could break/over-open my network" | **Inert until configured** (no keys → no writes, ever). **Validates** every change via `/acl/validate` before applying. Your baseline (incl. a lockout-safe admin→Pi rule) is **only read, never written**. |
| "Audit" | Every grant/revoke is written to the Pi audit log (actor, target, TTL) and shown in **Admin → Activity log**. |
| "Dashboard gets compromised" | It still can't reach your LAN — the tunnel is Browser→Tailscale→Pi→device, independent of the dashboard, and the dashboard holds no ACL key. |

**Bottom line:** with no keys set, this feature does literally nothing. Once
configured, the worst a compromised admin account can do is open *one device at a
time, briefly, to your own Tailscale identity* — all logged.

---

## One-time setup

### 1. Tag your machines (Tailscale admin console)
Tag the Pi as `tag:pi` and the dashboard host as `tag:hetzner` (Machines → ⋯ → Edit ACL tags), and make the Pi advertise your LAN route:
```bash
# on the Pi
sudo tailscale up --advertise-routes=10.0.0.0/24 --accept-routes --advertise-tags=tag:pi
```

### 2. Baseline policy (default-deny)
Copy the template and adapt identities/IPs, then place it on the Pi as
`data/acl-baseline.json` (next to your device configs):
```bash
cp pi-agent/acl-baseline.example.json  ~/pi-agent/data/acl-baseline.json
nano ~/pi-agent/data/acl-baseline.json
```
This file is **your** static policy. The Pi-Agent only ever *reads* it and appends
active grants on top.

### 3. Tailscale API key + env
In `~/pi-agent/.env`:
```env
TS_API_KEY=tskey-api-...        # API access token with ACL write scope (keep on the Pi only!)
TS_TAILNET=you@gmail.com        # your tailnet name
TS_ADMIN_IDENTITY=you@gmail.com # the identity grants are opened for (you)
```
Then `docker compose up -d`. The agent logs `Remote access: enabled` on start.

> Prefer a Tailscale **OAuth client** with just the `acl` scope over a personal API key.

---

## How you actually connect (the Tailscale VPN part)

Tailscale is the VPN — this feature only flips the *permission*. The encrypted path
is provided by the Tailscale client on your device.

1. **Install Tailscale on the device you browse from** (laptop/phone) and sign in to
   the same tailnet. On the phone, enable **"Use Tailscale subnet routes"**; on a
   laptop it's `--accept-routes`.
2. The **Pi is the subnet router** (step 1 above), so your client can reach
   `10.0.0.x` *through* the Pi over WireGuard — but only where the ACL allows.
3. In the dashboard, on the device, click **🔐 Connect**. The Pi opens
   `you → 10.0.0.10:8006` for the TTL, and the dashboard opens the URL.
4. Your browser reaches the device over the Tailscale tunnel (Proxmox web UI incl.
   the **noVNC console** works — it's transparent, like being on the LAN).
5. When the timer runs out (or you hit **✕ Revoke**), the rule is removed and the
   device is unreachable again.

No port forwarding, nothing exposed to the internet, no per-device VPN on the
target — the Pi routes, the ACL gates, the grant is temporary.
