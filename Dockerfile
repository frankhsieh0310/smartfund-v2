FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate

CMD ["node", "--experimental-strip-types", "scripts/data/daily/run-production-yahoo-daily.ts", "--all-due"]
