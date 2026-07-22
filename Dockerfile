FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/mobile/package.json packages/mobile/
# Every workspace manifest must exist for the frozen-lockfile check, including packages this
# image never builds.
COPY packages/codec-server/package.json packages/codec-server/
RUN pnpm install --frozen-lockfile
COPY . .
# The gateway image: transports, accounts, legal pages, and the Expo web export (served at
# /app). It routes forecast requests to per-version codec containers (Dockerfile.codec) via
# CODEC_URL_V<N> env vars and contains no codec itself. Node 22 satisfies Metro's >=20.19.4
# requirement.
RUN pnpm --filter @weather/protocol build \
 && pnpm --filter @weather/server build \
 && pnpm --filter @weather/mobile build:web
CMD ["node", "packages/server/dist/index.js"]
