# SM Dashboard (Passkey Login Demo)

## Voraussetzungen
- Node.js 20+
- npm
- HTTPS is **not required** for localhost testing (WebAuthn allows localhost)

## 1) Dependencies installieren
```bash
npm install
```

## .env (optional, empfohlen)
```env
PORT=3001
RP_NAME=SM Dashboard
ORIGIN=https://<dein-forwarded-url>
RP_ID=<nur-hostname-ohne-https-und-ohne-slash>
```

**Wichtig:** `RP_ID` darf **kein** `https://` und **keinen** abschließenden `/` enthalten.

## 2) Backend starten
```bash
npm run server:dev
```
Backend läuft auf `http://localhost:3001`.

## 3) Frontend starten (neues Terminal)
```bash
npm run dev -- --host 0.0.0.0 --port 5173
```
Frontend läuft auf `http://localhost:5173`.

## 4) Im Browser testen
1. Öffne die Vite-URL im Codespace.
2. Gib eine E-Mail ein.
3. Klicke **Register passkey** (erstmalig nötig).
4. Danach **Sign in with passkey**.

## Hinweise
- User/Passkeys werden nur im RAM gehalten (Demo). Neustart löscht Daten.
- Für Produktion: DB, Sessions/JWT, CSRF/Cookie-Strategie, Rate-Limits, Logging, und feste `RP_ID`/`ORIGIN` setzen.

## Env Variablen (optional)
- `PORT` (default `3001`)
- `RP_ID` (default `localhost`)
- `RP_NAME` (default `SM Dashboard`)
- `ORIGIN` (default `http://localhost:5173`)
- `REQUIRE_USER_VERIFICATION` (`true` or `false`, default `false` for demo compatibility)


## Codespaces-Hinweis (wichtig für RP ID)
In GitHub Codespaces ist `localhost` im Browser oft **nicht** die echte Origin-Domain.
Wenn du den Fehler `RP ID "localhost" is invalid for this domain` bekommst, setze:

```bash
export ORIGIN="https://<dein-forwarded-url>"
export RP_ID="<host-aus-deiner-forwarded-url-ohne-protokoll>"
npm run server:dev
```

Beispiel: bei `https://fuzzy-space-xyz-5173.app.github.dev`
- `ORIGIN=https://fuzzy-space-xyz-5173.app.github.dev`
- `RP_ID=fuzzy-space-xyz-5173.app.github.dev`
