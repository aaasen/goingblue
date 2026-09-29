# The gateway image: transports, accounts, and legal pages. It routes forecast requests to
# per-version codec containers (Dockerfile.codec) via CODEC_URL_V<N> env vars and contains no
# codec itself.
FROM node:26-slim AS base
WORKDIR /app
# Node 26 no longer bundles corepack, so it is installed here; the pnpm version itself still
# comes from the root package.json "packageManager" field.
RUN npm i -g corepack@latest && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
# Every workspace manifest must exist for the frozen-lockfile check, including packages this
# image never builds; the filter keeps the install to server and its workspace dependencies.
COPY packages/mobile/package.json packages/mobile/
COPY packages/codec-server/package.json packages/codec-server/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@weather/server..."
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server
RUN pnpm --filter @weather/protocol build \
 && pnpm --filter @weather/server build

FROM base
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@weather/server..."
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/server/dist packages/server/dist
# Owned by the runtime user so a file checked out without world read still serves.
COPY --chown=node:node packages/server/public packages/server/public
USER node
CMD ["node", "packages/server/dist/index.js"]
