# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# optionalDependencies = the @deepseek-ai/* dsh packages (HARNESS_ENGINE=dsh). Installed by default.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3100 HARNESS_ENGINE=dsh
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s CMD curl -fsS http://127.0.0.1:3100/health || exit 1
CMD ["node", "dist/index.js"]
