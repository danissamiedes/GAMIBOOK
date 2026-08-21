# Single-VPS deployment target (SPEC §13).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# The end-to-end tests do not run in this image, and Playwright's postinstall
# would otherwise pull several hundred megabytes of browsers into the layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Dev dependencies are installed and kept: the runtime CMD runs the Prisma CLI
# to migrate on boot, and that CLI is a dev dependency.
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
RUN mkdir -p /data/storage
EXPOSE 3000
# Migrations run on boot so a deploy never lands ahead of its schema.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
