#!/bin/bash
set -euo pipefail

# Local dev: the whole README "Development" flow in one tmux session.
#
#   ./dev.sh install  # pnpm install, then fetch the bundled basemap (assets not in git that
#                     # Metro needs at bundle time); run once on a fresh clone
#   ./dev.sh start    # start Postgres (docker), build, create the session, attach
#   ./dev.sh tunnel   # same, but for public wifi with client isolation, where the phone
#                     # cannot reach the Mac's LAN address: Metro goes through Expo's ngrok
#                     # tunnel and the gateway through a second ngrok tunnel on your own
#                     # ngrok account (scripts/gateway-tunnel.mjs, authtoken from
#                     # ~/Library/Application Support/ngrok/ngrok.yml or NGROK_AUTHTOKEN).
#                     # The gateway URL is baked into the JS bundle as EXPO_PUBLIC_API_BASE.
#                     # Slower than LAN.
#   ./dev.sh stop     # tear down the session and stop the database; its data lives in the
#                     # goingblue-data docker volume and survives, so app accounts minted
#                     # against the local gateway keep working across restarts
#   ./dev.sh reset    # stop, then delete the volume for a fresh database next start
#
# Re-running while the session exists just re-attaches. Windows (C-b n / C-b p to cycle):
#   servers  three panes — tsc --build --watch (rebuilds protocol/codec-server/server on
#            edit), the codec server, and the gateway; both servers run node --watch on
#            dist, so a TS edit lands as compile → restart with no manual step
#   expo     npx expo start -c (its own window: Metro's UI is interactive and busy);
#            --scheme names the dev build so the QR code opens it, not the preview or
#            store app, which register the same default exp+mobile scheme. In tunnel
#            mode a second pane holds the gateway tunnel.
#
# Ports: gateway :8080, codec :8082 (NOT the codec's usual 8081 default — Metro also
# defaults to 8081 and Expo would collide), Metro :8081, Postgres :5432.
SESSION="weather"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
CODEC_PORT="${CODEC_PORT:-8082}"
# STATS_PASS is what registers /stats at all (index.ts fails closed without it), so local dev
# needs one or the dashboard is a 404 here. Log in as lane/dev.
DB_ENV="DB_USER=postgres DB_PASS=dev DB_NAME=goingblue STATS_PASS=dev"
# The dev build's bundle ID doubles as its URL scheme (see app.config.js variants).
EXPO_ARGS="--scheme com.laneaasen.weather.dev"
EXPO_ENV=""
TUNNEL_URL_FILE="${TMPDIR:-/tmp}/weather-gateway-tunnel.url"

DB_VOLUME="goingblue-data"

if [ "${1:-}" = "install" ]; then
  pnpm install
  pnpm --filter @weather/mobile fetch-basemap
  exit 0
fi

if [ "${1:-}" = "stop" ] || [ "${1:-}" = "reset" ]; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  docker stop goingblue 2>/dev/null || true
  if [ "$1" = "reset" ]; then
    docker volume rm "$DB_VOLUME" >/dev/null 2>&1 && echo "database cleared" || echo "no database to clear"
  fi
  exit 0
fi

TUNNEL=""
case "${1:-}" in
  start) ;;
  tunnel)
    TUNNEL=1
    EXPO_ARGS="$EXPO_ARGS --tunnel"
    ;;
  *)
    echo "usage: ./dev.sh install|start|tunnel|stop|reset"
    exit 2
    ;;
esac

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  if [ -z "$(docker ps -q -f name='^goingblue$')" ]; then
    docker run --rm -d --name goingblue -p 5432:5432 \
      -v "$DB_VOLUME:/var/lib/postgresql" \
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
    "$DB_ENV PORT=$GATEWAY_PORT CODEC_URL_V4=http://localhost:$CODEC_PORT node --watch packages/server/dist/index.js"
  tmux select-layout -t "$SESSION:servers" even-vertical

  if [ -n "$TUNNEL" ]; then
    rm -f "$TUNNEL_URL_FILE"
    tmux new-window -t "$SESSION" -n expo \
      "cd packages/mobile && node scripts/gateway-tunnel.mjs '$TUNNEL_URL_FILE' $GATEWAY_PORT"
    # A failed tunnel would otherwise close the window and take Metro's pane with it; keep
    # the dead pane so its error stays readable.
    tmux set-option -t "$SESSION:expo" remain-on-exit on
    for _ in $(seq 30); do
      [ -s "$TUNNEL_URL_FILE" ] && break
      sleep 1
    done
    if [ ! -s "$TUNNEL_URL_FILE" ]; then
      echo "gateway tunnel did not come up; see the expo window"
    else
      EXPO_ENV="EXPO_PUBLIC_API_BASE=$(cat "$TUNNEL_URL_FILE")"
    fi
    tmux split-window -t "$SESSION:expo" -v -l 80% \
      "cd packages/mobile && $EXPO_ENV npx expo start -c $EXPO_ARGS"
  else
    tmux new-window -t "$SESSION" -n expo "cd packages/mobile && npx expo start -c $EXPO_ARGS"
  fi
  tmux select-window -t "$SESSION:servers"
fi

exec tmux attach -t "$SESSION"
