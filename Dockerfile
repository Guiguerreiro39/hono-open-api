FROM node:24-slim AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm install --prod --frozen-lockfile

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/infra/db/migrations ./src/infra/db/migrations
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 9999

CMD ["node", "dist/src/index.js"]
