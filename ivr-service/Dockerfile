FROM node:22-alpine

WORKDIR /app

# Copy manifests first so the dependency layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
