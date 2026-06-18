# Stage 1 — compile TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json .
COPY src ./src
RUN npx tsc

# Stage 2 — lean runtime (only compiled JS + dotenv, no TypeScript tooling)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
