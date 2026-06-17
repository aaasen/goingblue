# Going Blue: Weather Forecasts via Satellite

Going Blue is a tool for retrieving weather forecasts over satellite. It is deployed at [going.blue](https://going.blue/).

I built Going Blue before a Denali ski expedition because I wasn't satisfied with the existing weather forecast tools. For Denali, it was important to have high-altitude wind data, hourly forecasts, and compare multiple models.

Going Blue works like this:
1. Build a forecast request from the mobile app. Choose time resolution, weather model, and the variables that you need.
2. Send the forecast request to (425) 434-5858 via Garmin inReach, ZOLEO, SMS, or any other satellite messenger.
3. Copy the forecast response into the mobile app. Responses are encoded in a custom format to maximize space.
4. View the forecast on the mobile app.

Forecasts are provided by [Open-Meteo](https://open-meteo.com/).

## Architecture

This is a pnpm monorepo with three packages:

- `packages/protocol` — shared TypeScript binary encoding/decoding used by both the server and the mobile app
- `packages/server` — Hono/Node.js server; receives inbound messages, fetches forecasts, and sends replies
- `packages/mobile` — Expo React Native app for building requests and decoding forecasts

## Development

### Database

The server uses a PostgreSQL database to store user tokens and forecast requests.

```bash
docker run --rm -d --name goingblue -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=goingblue postgres:18
```

### Server

Install dependencies:

```bash
pnpm install
```

Start the server:

```bash
DB_USER=postgres DB_PASS=dev DB_NAME=goingblue pnpm start
```

The server starts at `http://localhost:8080`. 

#### Inbound messages

The server receives forecast requests over two transports, each fetching a forecast from the
request body and replying on the same channel:

- **Email** (`POST /inbound`) — forwarded Garmin inReach messages. The reply is posted back via
  the message's `inreachlink.com` reply URL.
- **SMS** (`POST /sms`) — Twilio inbound-SMS webhook. Point your Twilio number's "A message comes
  in" webhook at `https://<host>/sms` (HTTP POST). The forecast is returned as TwiML, which Twilio
  delivers back to the sender, so no Twilio REST credentials are required for replies. Set
  `TWILIO_AUTH_TOKEN` to verify the `X-Twilio-Signature` on each request (recommended in
  production); requests that fail validation are rejected with 403. If the public URL Twilio signs
  differs from the in-process URL (e.g. behind a proxy), pin it with `TWILIO_WEBHOOK_URL`.

### Client

The client is an Expo React Native app. The app works on iOS, Android, and the web. To run the web client:

```bash
cd packages/mobile
pnpm run web
```

Or, build an iOS app:

```
cd packages/mobile
eas build --platform ios --local
```

### Tests

```bash
pnpm test
```

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read, modify, and use the code for any noncommercial purpose. Commercial use is reserved to the copyright holder.
