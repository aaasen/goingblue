# Satellite Weather

Weather forecasts via Garmin inReach satellite messenger. Deployed at [going.blue](https://going.blue/).

The goal of this project is to provide better weather forecasts than the default inReach system. Forecasts are sourced from [Open-Meteo](https://open-meteo.com/). They are encoded with a custom binary encoding to maximize information density. Using this encoding, it is possible to get 10-day daily forecasts in a single message.

## Offline Usage

The mobile app builds forecast requests, decodes the satellite replies, and caches decoded forecasts on-device so they remain available offline.

## Architecture

This is a pnpm monorepo with three packages:

- `packages/protocol` — shared TypeScript binary encoding/decoding used by both the server and the mobile app
- `packages/server` — Hono/Node.js server; receives inbound email webhooks, fetches Open-Meteo forecasts, and sends Garmin replies
- `packages/mobile` — Expo React Native app for building requests and decoding forecasts

## Development

**Prerequisites:** Node.js 18+, pnpm (`npm install -g pnpm`)

Install dependencies:

```bash
pnpm install
```

### Build

Build all packages (protocol → server):

```bash
pnpm build
```

To build a single package:

```bash
pnpm --filter @weather/protocol build
pnpm --filter @weather/server build
```

### Run

Build and start the server:

```bash
pnpm start
```

The server starts at `http://localhost:8080`. It exposes the `/forecast` endpoint used by the mobile app during local development.

To use a different port:

```bash
PORT=3000 node packages/server/dist/index.js
```

### Database

The server uses Postgres (Cloud SQL in production) to store user accounts and forecast requests. Connection details come from the environment; the schema is applied automatically on startup. The forecast path keeps working if the DB is unavailable — only account features require it.

| Env var | Purpose |
| --- | --- |
| `INSTANCE_CONNECTION_NAME` | Cloud SQL instance (`project:region:instance`). When set (and `DB_HOST` is not), the driver connects over the Cloud SQL Auth Proxy socket at `/cloudsql/<name>`. |
| `DB_HOST` / `DB_PORT` | TCP host/port for local dev (default `127.0.0.1:5432`). |
| `DB_USER` / `DB_PASS` / `DB_NAME` | Credentials and database name. |
| `DB_POOL_MAX` | Max pool connections per instance (default `5`). |

**Local dev** — run Postgres in Docker and point the server at it:

```bash
docker run --rm -d --name weather-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=goingblue postgres:18
DB_USER=postgres DB_PASS=dev DB_NAME=goingblue pnpm start
```

(Alternatively, run `cloud-sql-proxy <INSTANCE_CONNECTION_NAME>` to connect to the real Cloud SQL instance over `127.0.0.1`.)

Production deployment (Cloud Run, Cloud SQL, and the `DB_PASS` secret) is documented separately in `DEPLOYMENT.md`.

### Mobile (Expo / React Native)

**Additional prerequisites:** [Expo Go](https://expo.dev/go) on your iOS or Android device, or Xcode (iOS simulator) / Android Studio (Android emulator).

```
pnpm --filter @weather/mobile exec expo install expo-dev-client
```

Start the Expo development server from the mobile package:

```bash
pnpm --filter @weather/mobile start
```

This opens the Expo CLI. Then:

- **Physical device:** scan the QR code with the Expo Go app
- **iOS simulator:** press `i` (requires Xcode)
- **Android emulator:** press `a` (requires Android Studio)

You can also target a platform directly:

```bash
pnpm --filter @weather/mobile ios      # iOS simulator
pnpm --filter @weather/mobile android  # Android emulator
```

### Tests

```bash
pnpm test
```

### Docker

Build and run the container locally:

```bash
docker build -t denali-wx .
docker run --rm -p 8080:8080 denali-wx
```

The server starts at `http://localhost:8080`.

## Deploy

Requires [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) with a project configured.

```bash
./deploy.sh
```

Or directly:

```bash
gcloud run deploy denali-wx --source . --region us-west1 --allow-unauthenticated --platform managed
```

The Dockerfile builds all packages from source and runs the server on `$PORT` (Cloud Run sets this automatically).

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read, modify, and use the code for any noncommercial purpose. Commercial use is reserved to the copyright holder.
