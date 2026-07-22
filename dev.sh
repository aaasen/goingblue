#!/bin/bash
set -euo pipefail

# Local dev: the whole README "Development" flow in one tmux session.
#
#   ./dev.sh          # start Postgres (docker), build, create the session, attach
#   ./dev.sh kill     # tear down the session AND stop the database (the container runs
#                     # with --rm, so its data is discarded — it's disposable by design)
#
# Re-running while the session exists just re-attaches. Windows (C-b n / C-b p to cycle):
#   servers  three panes — tsc --build --watch (rebuilds protocol/codec-server/server on
#            edit), the codec server, and the gateway; both servers run node --watch on
#            dist, so a TS edit lands as compile → restart with no manual step
#   expo     npx expo start -c (its own window: Metro's UI is interactive and busy)
#
# Ports: gateway :8080, codec :8082 (NOT the codec's usual 8081 default — Metro also
# defaults to 8081 and Expo would collide), Metro :8081, Postgres :5432.
SESSION="weather"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
CODEC_PORT="${CODEC_PORT:-8082}"
DB_ENV="DB_USER=postgres DB_PASS=dev DB_NAME=goingblue"

if [ "${1:-}" = "kill" ]; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  docker stop goingblue 2>/dev/null || true
  exit 0
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  if [ -z "$(docker ps -q -f name='^goingblue$')" ]; then
    docker run --rm -d --name goingblue -p 5432:5432 \
      -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=goingblue postgres:18 \
      || { echo "could not start Postgres — is Docker running?"; exit 1; }
  fi

  pnpm build

  # The gateway applies the schema once at startup (migrate), so wait until Postgres is
  # actually accepting connections before launching it.
  for _ in $(seq 30); do
    docker exec goingblue pg_isready -U postgres -q && break
    sleep 1
  done

  # tsc lives in the packages' devDependencies, so run it through pnpm from a package dir;
  # `-b . ../codec-server` covers both server packages and, via references, protocol.
  tmux new-session -d -s "$SESSION" -n servers \
    "pnpm --filter @weather/server exec tsc -b --watch --preserveWatchOutput . ../codec-server"
  tmux split-window -t "$SESSION:servers" -v \
    "PORT=$CODEC_PORT node --watch packages/codec-server/dist/index.js"
  tmux split-window -t "$SESSION:servers" -v \
    "$DB_ENV PORT=$GATEWAY_PORT CODEC_URL_V1=http://localhost:$CODEC_PORT node --watch packages/server/dist/index.js"
  tmux select-layout -t "$SESSION:servers" even-vertical

  tmux new-window -t "$SESSION" -n expo "cd packages/mobile && npx expo start -c"
  tmux select-window -t "$SESSION:servers"
fi

exec tmux attach -t "$SESSION"
