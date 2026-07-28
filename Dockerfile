FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Prisma validates datasource URLs while generating the client. Railway injects
# the real URLs only at runtime, so use non-sensitive placeholders at build time.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" DIRECT_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

CMD ["node", "--experimental-strip-types", "scripts/data/daily/run-production-yahoo-daily.ts", "--all-due"]
