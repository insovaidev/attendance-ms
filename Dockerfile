# One Dockerfile, three targets; docker-compose picks the target.
#   build   – compiles TypeScript and generates Prisma clients
#   migrate – build + Prisma CLI, runs `prisma migrate deploy` then exits
#   runtime – production dependencies + compiled code only, runs as non-root

FROM node:22-slim AS base
# Prisma needs OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY libs ./libs
COPY apps ./apps
COPY scripts ./scripts
RUN npm run prisma:generate && npm run build

FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "prisma:deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
# The service to run is chosen by the compose `command`.
CMD ["node", "dist/apps/gateway/src/main.js"]
