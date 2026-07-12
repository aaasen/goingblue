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


The core of Going Blue is a super compact message format that maximizes the amount of weather data that can fit in a single message.

Forecast responses are bit-packed into a compact binary message, then serialized as base-85 over
the [GSM-7 basic alphabet](packages/protocol/src/constants.ts) so each character costs a single
septet over SMS. A message is a fixed header followed by one body cell per period × model.

The body is emitted through a single **rANS** (range Asymmetric Numeral System) entropy coder
(`packages/protocol/src/rans.ts`), so every modeled symbol costs its exact information content in
fractional bits — the peaked distributions here (P(Δ=0) ≈ 0.7–0.8) cost well under the
1-bit-per-symbol floor a prefix code can't cross. The stream is one rANS state per message
(LIFO-encoded, ~20–25 bits of constant flush/renorm overhead), and the decoder's final state
doubles as an integrity check: desynced reads throw instead of returning plausible garbage.

### Strategies

- **Fixed (linear)** — the value is mapped to a fixed-width integer with a constant step size and
  offset. Constant width; used where the range is small and roughly uniform. Passes through the
  coder's bypass path at exactly its nominal width.
- **Entropy-coded deltas** — most columns store one full-width anchor per model, then
  period-over-period deltas under static, corpus-derived frequency tables
  (`packages/protocol/src/entropy.ts`, weights in `codebooks.gen.ts`). Weathercode and wind
  direction are order-1 conditional: each symbol's table is keyed by the previously decoded
  symbol — context both sides already have, so it costs no header bits. Temp deltas pick the
  cheapest of 16 tables (4-bit selector, ±7 °C core plus a 6-bit escape); wind speed, freezing
  level, and the three cloud levels each use one shared table.
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
| periods          | 8    | period count − 1 (1–256 periods)                   |
| elevation        | 7    | 100 m steps, 0–12700 m (coarse sanity check)       |

The header is 22 packed bits → **5 chars** including the version prefix. The body carries **no length
field**: it is a single rANS stream, serialized little-endian and self-delimiting — the decoder
knows the structure (period count, single model, `vars_mask`) and consumes exactly the symbols the
encoder wrote, so trailing zero words are simply dropped.

### Per-period variables

| Variable               | Strategy | Size (model cost)             | Quantization                          |
| ---------------------- | -------- | ----------------------------- | ------------------------------------- |
| weathercode            | order-1 entropy | ~1.7 bits/value (1h mean) | 28 WMO codes, table keyed by previous code |
| temperature (max/min)  | anchor + entropy deltas | 8-bit anchor + ~2.1 bits/delta; 4-bit table selector | 1 °C steps, −100 °C offset |
| freezing level         | anchor + entropy deltas | 4-bit anchor + ~1.1 bits/delta | 1000 ft steps (0–15000 ft)  |
| snow                   | Adaptive | mode + sparse/FOR/empty       | 6-bit sqrt-companded, 0–200 cm        |
| rain                   | Adaptive | mode + sparse/FOR/empty       | 6-bit sqrt-companded, 0–144 mm        |
| precipitation prob.    | Adaptive | mode + FOR/sparse/empty (≤3 bits/value) | 0–100% in eighths           |
| wind — all levels      | anchor + entropy deltas; contextual entropy dir, no dir symbol when calm | 5-bit speed anchor + ~1.8–2.5 bits/period (1h mean, speed + dir); tables keyed by resolution × level, 600/700 hPa also by the upper level's decoded values | 5 mph speed steps, 0–155 mph, 8-point direction |
| cloud (high/mid/low)   | anchor + entropy deltas | 3-bit anchor + ~1.6 bits/delta | 0–100% in eighths          |
| cloud (total)          | Fixed    | 3 bits each                   | 0–100% in eighths                     |

## Development

To get running locally:

1. Start a local Postgres database through Docker:

```
docker run --rm -d --name goingblue -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=goingblue postgres:18
```

2. Start the forecast server:

```
pnpm install
DB_USER=postgres DB_PASS=dev DB_NAME=goingblue pnpm start
```

3. Build the app

```
cd packages/mobile
eas build -p ios --profile development
```

4. Install the app on your iOS device with the QR code in the step above.

5. Start the Expo development server

```
cd packages/mobile
npx expo start -c
```

6. Open the mobile app. It should find the running Expo development server.

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

The client is an Expo React Native app which currently works only on iOS.

First, build an iOS app:

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

The HTML report compares days/message with box plots for **1h**, **3h**, and **6h** forecasts using base variables alone and base plus each optional group (Clouds, High Altitude Winds, and Freezing Level). It reports an overall score averaging the corresponding periods/message means. Interactive resolution and variable selectors matching the app control the detailed histogram, box-and-whisker summary, and bit-occupancy table. (`--resolution` sets which detail view the report opens on; all resolutions are always computed.)

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
5. 8 -> 16 codebooks for weathercode. 2.45 bits -> 2.32 bits. Periods/message 56 -> 56.3.
6. Remove tmin at 1hr resolution. Periods/message 56.3 -> 71.2. 
7. Always use FOR for temperature. Periods/message 71.2 -> 71.3.
8. Huffman coding for temperature deltas. Temp 3.98 bits -> 2.13 bits. Periods/message 71.3 -> 81.7
9. Huffman coding for weathercode dependent on previous weathercode. Weathercode 2.38 bits -> 1.84 bits. Periods per message 81.7 -> 84.5. 
10. Period count 7 -> 8 bits (256 periods max). Periods per message 84.5 -> 85.
11. Huffman coding for wind direction based on previous direction. Wind total 4.22 bits -> 3.39 bits. Periods per message 85 -> 91.9.
12. Huffman coding for wind speed deltas. Wind total 3.39 bits -> 2.87 bits. Periods per message 91.9 -> 96.4.
13. Huffman coding for freezing level. 2.52 bits -> 1.41 bits. Periods per message 77.7 -> 84.8.
14. Huffman coding for cloud cover. 3 bits -> 1.9 bits. Periods per message 51.3 -> 63.6.
15. rANS entropy coding replacing Huffman throughout the body (same models and corpus-derived
    tables, now charged fractional bits). Periods/message (1h base) 96.4 -> 101.2; wind
    2.85 -> 2.41 bits/period, weathercode 1.84 -> 1.64; overall score 52.6 -> 54.3. Costs a
    constant ~22-bit stream overhead per message, and surfaced that the 1h-derived wind
    dir/speed tables are overconfident at 3h/6h (+0.36 b/p on wind columns there — Huffman's
    integer rounding had masked the miscalibration); recovered by resolution-keyed tables,
    planned alongside the dynamic time-frame change.
16. Wind encoding overhaul (all context both sides already know, so no wire cost): dir/speed
    tables keyed by resolution × level; 600/700 hPa conditioned on the upper level's decoded
    same-period values (dir keyed by prev × upper dir, speed delta by the upper's delta bucket);
    calm gating — no direction symbol when the quantized speed is 0 (35% of 1h surface periods,
    where direction is model dither); speed domain 4 -> 5 bits (cap 75 -> 155 mph — the old cap
    clamped 6-8.6% of 500 hPa values). Surface wind 2.45 -> 1.84 b/p (1h), w600 4.99 -> 3.58
    (6h). Periods/message (1h base) 101.2 -> 107.9; overall score 54.3 -> 57.1; days/message at
    6h with high-altitude winds 6.8 -> 7.7. Fixes the 3h/6h regression noted in #15. Scheme
    selection was held-out validated (5-fold by location) — see
    packages/server/scripts/analyze-wind-heldout.ts.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read, modify, and use the code for any noncommercial purpose. Commercial use is reserved to the copyright holder.
