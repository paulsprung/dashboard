# SM Dashboard (Passkey Login Demo)

## Voraussetzungen
- Node.js 20+
- npm
- HTTPS is **not required** for localhost testing (WebAuthn allows localhost)

## 1) Dependencies installieren
```bash
npm install
```

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
