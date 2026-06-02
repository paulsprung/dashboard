FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002
CMD ["npm", "run", "start"]
