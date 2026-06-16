# Satellite Weather

Weather forecasts via Garmin inReach satellite messenger. Deployed at [weather.laneaasen.com](https://weather.laneaasen.com/).

The goal of this project is to provide better weather forecasts than the default inReach system. Forecasts are sourced from [Open-Meteo](https://open-meteo.com/). They are encoded with a custom binary encoding to maximize information density. Using this encoding, it is possible to get 10-day daily forecasts in a single message.

## Offline Usage

The decoder app is a Progressive Web App (PWA) that can be installed on your phone for offline use. Open [weather.laneaasen.com](https://weather.laneaasen.com/) in your browser and tap the share button, then select "Add to Home Screen".

## Architecture

This is a pnpm monorepo with four packages:

- `packages/protocol` — shared TypeScript binary encoding/decoding used by both server and client
- `packages/server` — Hono/Node.js server; receives inbound email webhooks, fetches Open-Meteo forecasts, sends Garmin replies, and serves the decoder page
- `packages/client` — Vite PWA decoder; imports the protocol package to decode and render forecasts entirely in-browser
- `packages/mobile` — Expo React Native iOS companion app

## Development

**Prerequisites:** Node.js 18+, pnpm (`npm install -g pnpm`)

Install dependencies:

```bash
pnpm install
```

### Build

Build all packages (protocol → client → server):

```bash
pnpm build
```

To build a single package:

```bash
pnpm --filter @weather/protocol build
pnpm --filter @weather/client build
pnpm --filter @weather/server build
```

### Run

Build and start the server:

```bash
pnpm start
```

The server starts at `http://localhost:8080`. Open it in a browser to use the decoder.

To use a different port:

```bash
PORT=3000 node packages/server/dist/index.js
```

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
