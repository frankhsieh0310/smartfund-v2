FROM node:22-bookworm-slim

WORKDIR /app
# Browser automation is a local/manual workflow. The Production Daily Engine
# uses Yahoo Chart HTTP requests, so Railway must not download Chromium while
# installing the optional Puppeteer package.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Prisma validates datasource URLs while generating the client. Railway injects
# the real URLs only at runtime, so use non-sensitive placeholders at build time.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" DIRECT_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

CMD ["sh", "-c", "npx prisma migrate deploy && node --experimental-strip-types scripts/data/production/run-production-cron.ts"]
