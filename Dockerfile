FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @weather/protocol build \
 && pnpm --filter @weather/server build
CMD ["node", "packages/server/dist/index.js"]
