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

## Encoding

Forecast responses are bit-packed into a compact binary message, then serialized as base-85 over
the [GSM-7 basic alphabet](packages/protocol/src/constants.ts) so each character costs a single
septet over SMS. A message is a fixed header followed by one body cell per period × model.

To squeeze the body, each variable uses the encoding strategy that best fits its distribution. The
adaptive strategies (Huffman, frame-of-reference, sparse) are the protocol's encoding design; every
adaptive column can also fall back to **raw** fixed-width, and the encoder picks whichever mode is
cheapest per column, so the encoded size is never larger than fixed-width.

### Strategies

- **Fixed (linear)** — the value is mapped to a fixed-width integer with a constant step size and
  offset. Constant width; used where the range is small and roughly uniform.
- **Huffman** — a static, prefix-free variable-length code so common conditions cost fewer bits.
  Used for weathercode (several regime-tuned codebooks — dry, cold/snow, maritime, convective — named
  by the header's `wc_table` field) and for surface wind direction (8 codebooks derived by clustering
  the corpus's per-column direction distributions, selected by a 3-bit index before the column). In
  both cases the encoder picks the codebook that yields the fewest bits.
- **Frame-of-reference (FOR)** — store one baseline (the column minimum) plus a per-column bit
  width `W`; each value is its unsigned offset from the baseline in `W` bits. `W` adapts to the
  actual spread, so tightly-clustered columns shrink and an all-equal column costs zero bits per
  value. No error accumulation, and it degrades to raw when the spread is large.
- **Sparse** — for columns that are usually zero. One presence bit per value, with the magnitude
  stored (in an adaptive width) only for nonzero values. Suits precipitation, which is mostly zero
  with a skewed tail.

### Header

The response is **slim**: it omits everything the client itself chose, carrying only a 7-bit message
`code`. The client assigns a code to each request and stores the request under it — lat/lon, the
single model index, variables, resolution, and the requested **UTC** start time — then the response
echoes the code so the client recovers those fields from its own storage (see
`packages/mobile/cache.ts`). The code is a rotating index over 128 slots; reusing a code (as it
cycles) evicts the old forecast in that slot. This trades the protocol's "any string decodes
anywhere" property for a much smaller header — acceptable because the app is the only client.

The client sends the requested start time in the request (`t:`, UTC hours since the epoch, aligned to
the resolution); the server anchors the forecast to it rather than to "now", so delivery delay can't
shift which periods come back. **All times are UTC.**

| Field            | Bits | Notes                                              |
| ---------------- | ---- | -------------------------------------------------- |
| version prefix   | 7    | self-describing protocol version (1 char)          |
| code             | 7    | message code; recovers lat/lon, model, vars, resolution, and start time from client storage |
| periods          | 7    | period count − 1 (1–128 periods)                   |
| elevation        | 7    | 100 m steps, 0–12700 m (coarse sanity check)       |
| wc_table         | 3    | Huffman codebook selector for weathercode          |

The header is 24 packed bits → **5 chars** including the version prefix. The body carries **no length
field**: it is packed little-endian and self-delimiting — the decoder knows the structure (period
count, single model, `vars_mask`) and reads exactly the bits each column needs, so trailing
zero-padding is simply dropped.

### Per-period variables

| Variable               | Strategy | Size                          | Quantization                          |
| ---------------------- | -------- | ----------------------------- | ------------------------------------- |
| weathercode            | Huffman  | ~1–7 bits / value (variable)  | 28 WMO codes, codebook per `wc_table` |
| temperature (max)      | FOR      | 7-bit baseline + `W` (0–7)/value | 1 °C steps, −40 °C offset (−40..+87 °C) |
| temperature (min)      | FOR      | 7-bit baseline + `W` (0–7)/value | 1 °C steps, −40 °C offset             |
| freezing level         | FOR      | 4-bit baseline + `W` (0–4)/value | 1000 ft steps (0–15000 ft)            |
| snow                   | Sparse   | 1 presence bit + magnitude/nonzero | 6-bit sqrt-companded, 0–200 cm    |
| rain                   | Sparse   | 1 presence bit + magnitude/nonzero | 6-bit sqrt-companded, 0–144 mm    |
| precipitation prob.    | Adaptive | mode + FOR/sparse/empty (≤3 bits/value) | 0–100% in eighths                 |
| wind — surface         | Adaptive speed + Huffman dir | speed: mode + FOR/sparse/empty (≤4 b/val); dir: 3-bit codebook + Huffman (~1–3 b/val) | 5 mph speed steps, 8-point direction |
| wind — 500/600/700 hPa | Fixed    | 7 bits each (4 speed + 3 dir) | 5 mph speed steps, 8-point direction  |
| cloud (total/high/mid/low) | Fixed | 3 bits each                  | 0–100% in eighths                     |

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
eas build -p ios --profile development
```

Then run the Expo development server:

```
cd packages/mobile
npx expo start -c
```

Or run in the simulator:

```
cd packages/mobile
npx expo run:ios
```

Ad-hoc build:

```
cd packages/mobile
eas build --platform ios --profile preview
```

### Tests

```bash
pnpm test
```

### Encoding benchmarks

The forecast encoding is tested against real weather from Open-Meteo's [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api) — a continuous best-estimate archive going back a year+, sampled as 10-day windows every ~10 days for full seasonal coverage. It uses the **GFS** model, which supplies every variable (base, clouds, high-altitude winds, freezing level, and precipitation probability); encoded size barely differs between models, so a single model keeps the pull within one day's API budget. (This is best-estimate data, not a run-anchored 10-day-ahead forecast — fine for measuring how the encoding compresses realistic seasonal weather.)

Benchmarking uses a mix of hand-picked locations and random locations from around the globe. The hand-picked locations are 137 of my Windy favorites which are mostly mountainous locations in Alaska, BC, Cascades, Tetons, Andes, Alps, Norway, and New Zealand.

The HTML report has interactive **time resolution** (1h/3h/6h) and **variable** selectors matching the app (Clouds, High Altitude Winds, Freezing Level, on top of the always-on base, which is the default). The periods histogram, box-and-whisker summary, bit-occupancy table, and per-forecast detail table all update with the selection so you can see how periods/forecast depends on the chosen resolution and variables. (`--resolution` sets which one the report opens on; all resolutions are always computed.)

`pnpm benchmark` runs both phases: it collects the forecast corpus (cached under `data/raw/<model>`, gitignored, idempotent/resumable) and then encodes each forecast through the production path, writing a timestamped HTML report to `data/benchmarks` (kept so runs can be compared side by side).

```bash
pnpm benchmark                     # collect (idempotent) then report
pnpm benchmark --report-only       # skip collection; report from cached data
pnpm benchmark --collect-only      # expand the cache without reporting (the pull can be long)
pnpm benchmark --dry-run           # preview the collection plan, no fetch
pnpm benchmark --resolution 6h     # 1h/3h/6h (default 1h)
# other flags: --limit <n> (cap fetches), --max-chars <n>, --location <id>, --verbose, --include-incomplete, --no-open
```

## Encoding improvements

1. Adaptive encoding for precipitation probability. 3 bits -> 1.71 bits (1h mean). Periods/message 43.5 -> 49.6
2. Adaptive encoding for wind speed. Wind total 7 bits -> 4.81 bits (1h mean). Periods/message 46.9 -> 51.4.
3. Huffman coding for wind direction. Wind total 4.81 bits -> 4.05 bits (1h mean). Periods/message 51.4 -> 53.8.
4. Huffman codebook regeneration for weathercode. Weathercode total 3.18 bits -> 2.45 bits. Periods/message 53.8 -> 56.


## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read, modify, and use the code for any noncommercial purpose. Commercial use is reserved to the copyright holder.
