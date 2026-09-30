# One image for all five services; docker-compose picks which one to run.
FROM node:22-slim

# Prisma's migration engine needs OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY libs ./libs
COPY apps ./apps
COPY scripts ./scripts

RUN npm run prisma:generate && npm run build

ENV NODE_ENV=production
