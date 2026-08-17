FROM node:26-slim
WORKDIR /app
# Node 26 no longer bundles corepack, so it is installed here; the pnpm version itself still
# comes from the root package.json "packageManager" field.
RUN npm i -g corepack@latest && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/mobile/package.json packages/mobile/
# Every workspace manifest must exist for the frozen-lockfile check, including packages this
# image never builds.
COPY packages/codec-server/package.json packages/codec-server/
RUN pnpm install --frozen-lockfile
COPY . .
# The gateway image: transports, accounts, and legal pages. It routes forecast requests to
# per-version codec containers (Dockerfile.codec) via CODEC_URL_V<N> env vars and contains no
# codec itself.
RUN pnpm --filter @weather/protocol build \
 && pnpm --filter @weather/server build
CMD ["node", "packages/server/dist/index.js"]
