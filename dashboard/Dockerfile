# Stage 1 — build Vite frontend + compile Express server TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

# Stage 2 — lean runtime (no TypeScript, no Vite, no dev deps, no source)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
