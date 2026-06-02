# Stage 1 — compile TypeScript to JavaScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json .
COPY src ./src
RUN npx tsc

# Stage 2 — lean runtime image
# No TypeScript tooling, no source files, no dev dependencies
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3002
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3002
CMD ["node", "dist/index.js"]
