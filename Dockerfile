FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/mobile/package.json packages/mobile/
RUN pnpm install --frozen-lockfile
COPY . .
# Build the shared protocol, the server, and the Expo web export (served at /app). Node 22
# satisfies Metro's >=20.19.4 requirement.
RUN pnpm --filter @weather/protocol build \
 && pnpm --filter @weather/server build \
 && pnpm --filter @weather/mobile build:web
CMD ["node", "packages/server/dist/index.js"]
