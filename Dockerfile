FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_OPTIONS=--max_old_space_size=2048
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY server ./server
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["npm", "run", "server:start"]
