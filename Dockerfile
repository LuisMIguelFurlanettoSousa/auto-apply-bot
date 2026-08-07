FROM node:18-slim

ARG GITHUB_REPO=LuisMIguelFurlanettoSousa/auto-apply-bot
ARG GITHUB_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
    make \
    g++ \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

COPY package.json tsconfig.json vitest.config.ts .
COPY src src

RUN pnpm install

ENV NODE_ENV=production

CMD ["pnpm", "start"]
