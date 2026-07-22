# Going Blue: Weather Forecasts via Satellite

Going Blue is a weather app specifically designed for satellite messengers and SMS. By using a highly optimized encoding scheme, Going Blue is able to deliver over 100 hourly data points in a single 160-character message. Going Blue is deployed at [going.blue](https://going.blue/).

I built Going Blue before a Denali ski expedition because I wasn't satisfied with the existing weather forecasting tools that are accessible over satellite. The gap between the information I had available in the field and the information I had at home felt huge. I built Going Blue to bridge that gap and provide detailed weather forecasts everywhere.

Going Blue has several advantages over existing tools:
1. Choice of weather models. Going Blue uses forecasts from [Open-Meteo](https://open-meteo.com/), which supports over 30 different weather models from ECMWF, NOAA, and other weather services. You can choose whichever model you prefer and compare the forecasts across different models.
2. Choice of weather variables. Going Blue forecasts always include temperature, wind, and precipitation. They optionally include detailed cloud cover, high altitude winds, and freezing level.
3. Meteogram visualization. Unlike other forecasts that operate over SMS that use abbreviated weather codes, Going Blue provides a rich visual representation of the forecast. 
4. Information density. Going Blue's compact encoding scheme allows it to deliver over 100 hourly data points in a single 160-character message. That's a 3 day forecast at 1 hour resolution, a 7 day forecast at 3 hour resolution, or a 10 day forecast at 6 hour resolution.

Going Blue works like this:
1. Build a forecast request from the mobile app. Choose a priority — Detail (hourly detail first), Auto (a balance, the default), or Range (the whole 12-day horizon first) — plus the weather model and the variables that you need. The server fills the reply with as much data as fits, in the order your priority asks for.
2. Send the forecast request to (425) 434-5858 via Garmin inReach, ZOLEO, SMS, or any other satellite messenger.
3. Copy the forecast response into the mobile app to visualize it.

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

### Unified model

Every weather variable is encoded under the **same model**: a Markov chain over a small discrete
alphabet, entropy-coded by rANS under static, corpus-derived frequency tables
(`packages/protocol/src/entropy.ts`, weights in `codebooks.gen.ts`). There are no per-column
encoding schemes or mode selectors — what varies per variable is only:

- **What a symbol is.** *Value-based* columns code the quantized value itself; used where the
  alphabet is small or where an absorbing state dominates ("still dry" is the strongest signal
  rain/snow carry, and a delta of 0 would conflate it with "steady heavy snowfall").
  *Delta-based* columns code the period-over-period change, with one full-width raw anchor at the
  start of the column; used where the domain is wide but the change per period is small
  (temperature, wind speed, freezing level, cloud cover).
- **What keys the codebook.** Each symbol's table is chosen by context **both sides already
  have**, so context costs no wire bits: the previously decoded symbol (or a bucket of it), the
  period's own resolution (both sides derive the layout, and persistence falls with the
  aggregation step), and for the 600/700 hPa wind columns the upper pressure level's
  already-decoded same-period values. A column's first symbol, having no predecessor, is coded
  under a per-variable bootstrap table.

No column carries any per-message signaling: every codebook choice is fully determined by shared
context. (Temperature was the last holdout — a 4-bit cheapest-of-16 table selector — until a
held-out conditioning ladder showed the selector was mostly re-discovering resolution, which is
free; its tables are now keyed by resolution × time-of-day × previous delta instead. Deltas beyond
±7 °C still escape to a raw 6-bit field.) All context choices are validated held-out (5-fold,
split by location) — see the `packages/server/scripts/derive-*-codebooks.ts` scripts that generate
the tables, and `analyze-temp-heldout.ts` for the temperature ladder.

### Header

The response is **slim**: it omits everything the client itself chose, carrying only a 7-bit message
`code`. The client assigns a code to each request and stores the request under it — lat/lon, the
single model index, variables, the requested priority mode (`p:`), the location's UTC offset
(`z:`, whole hours), and the request time (**UTC**) — then the response echoes the code so the
client recovers those fields from its own storage (see `packages/mobile/cache.ts`). The code is a
rotating index over 128 slots; reusing a code (as it cycles) evicts the old forecast in that slot.
This trades the protocol's "any string decodes anywhere" property for a much smaller header —
acceptable because the app is the only client.

The client sends the request time in the request (`t:`, UTC hours since the epoch, aligned to the
hour); the server anchors the forecast window to it rather than to "now", so delivery delay can't
shift which periods come back.

The **period layout isn't on the wire either**. The server fills the response budget by walking
the priority mode's refinement path — every step either covers one more day slot at 12h or makes
one covered slot a rung finer (12h → 6h → 3h → 1h); Detail plays refine-moves first, Range
extend-moves first, Auto interleaves — and the header carries only the resulting sequence number
`seq`. Both sides derive the identical layout (period count + per-period resolution) from
`layoutFor(mode, request time, UTC offset, seq)` (see `packages/protocol/src/layout.ts`; the
anchor tables and interpolation rule there are wire format). Periods align to **local midnight**
(the `z:` offset). The horizon covers **13 day slots**: the remainder of the request day, then 12
whole local days; how many are covered — and how finely — depends on the weather's entropy, not
on a promised number. Slot 0 is partial — its first period is the one containing the request
time, so refining it discards earlier hours of today. Every path starts with a truncated all-12h
ramp, so a starved budget degrades to the same message in every mode.

| Field            | Bits | Notes                                              |
| ---------------- | ---- | -------------------------------------------------- |
| version prefix   | 7    | self-describing protocol version (1 char)          |
| code             | 7    | message code; recovers lat/lon, model, vars, priority mode, UTC offset, and request time from client storage |
| seq              | 8    | fill-sequence number − 1; the period layout is derived from it |
| elevation        | 7    | 100 m steps, 0–12700 m (coarse sanity check)       |

The header is 22 packed bits → **5 chars** including the version prefix. The body carries **no length
field**: it is a single rANS stream, serialized little-endian and self-delimiting — the decoder
knows the structure (period count, single model, `vars_mask`) and consumes exactly the symbols the
encoder wrote, so trailing zero words are simply dropped.

### Per-period variables

| Variable             | Model | States (the symbol alphabet)                          | Codebook keyed by                              | Quantization                          |
| -------------------- | ----- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------- |
| weathercode          | value | 28 WMO codes                                            | previous code                                  | —                                     |
| temperature          | delta | Δ°C −7…+7, plus an escape symbol + raw 6-bit (−32…+31) | resolution × time-of-day (8 × 3h local buckets) × previous-delta bucket (≤−2 \| −1 \| 0 \| +1 \| ≥+2) | 1 °C steps, −100…+155 °C; 8-bit anchor |
| precipitation prob.  | value | eighths 0…7                                             | resolution × previous value × same-period weathercode class | 0–100% in eighths        |
| snow                 | value | 64 companded steps                                      | resolution × previous-value bucket (0 \| 1–3 \| 4–9 \| 10–20 \| 21+) × same-period weathercode class | sqrt-companded, 0–200 cm |
| rain                 | value | 64 companded steps                                      | resolution × previous-value bucket (same) × same-period weathercode class | sqrt-companded, 0–144 mm |
| freezing level       | delta | Δ −31…+31                                               | one shared table                               | 1000 ft steps, 0–31000 ft; 5-bit anchor |
| cloud (high/mid/low) | delta | Δ −7…+7                                                 | one shared table per level                     | 0–100% in eighths; 3-bit anchor       |
| wind speed           | delta | Δ −31…+31                                               | resolution × level; 600/700 hPa by the upper level's Δ bucket | 5 mph steps, 0–155 mph; 5-bit anchor |
| wind direction       | value | 8 cardinals                                             | resolution × previous direction (× upper direction for 600/700 hPa); calm periods emit no symbol | 45° points |

Value-based columns chain their previous-symbol context across the whole column; delta-based
columns never diff across a model boundary (each model gets its own anchor). See
[Wind](#wind) for the cross-level conditioning and calm gating.

The **weathercode class** keying the three wet columns is the code collapsed to a 4-state
precipitation regime — dry (clear/cloud/fog) | rain-ish (drizzle/rain/showers/thunder) | freezing
(freezing drizzle/rain) | snow-ish (snow/snow showers). Weathercode is the first column decoded and
is always present, so each wet cell can key on its *own* period's class for free — the same
already-decoded-context trick the 600/700 hPa wind columns play on the upper pressure level.

### Wind

Each wind column (surface, then 500/600/700 hPa) carries its quantized speeds first — a 5-bit
anchor followed by entropy-coded period-over-period deltas — and then its directions. Everything
that picks a codebook is context both sides already know, so it costs no wire bits:

- **Resolution and level** key the tables. Wind persists far more hour-to-hour than
  6h-to-6h, and surface deltas are far more peaked than jet-level ones, so each
  (resolution, level) pair gets its own distribution. The fill mixes resolutions within one
  message, so the key is **each period's own resolution** — derived from the layout on both
  sides (a delta at a resolution boundary is keyed by the arriving period's step).
- **The level above** conditions the 600/700 hPa columns: they decode after the level above
  them, so its already-decoded same-period values sharpen their tables (direction keyed by
  previous × upper direction, speed delta by the upper level's bucketed delta). Adjacent
  pressure levels share the synoptic flow, so this is the strongest single context.
- **Calm periods carry no direction symbol.** When the speed quantizes to 0 the direction is
  weather-model noise (~35% of 1h surface periods), so it's skipped entirely; the app shows
  the last known direction, and the direction context chain carries it across the gap.

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

The benchmark mirrors production exactly: for each cached forecast it runs the priority-mode fill
(the same `fitFillToBudget` the server uses) and records the largest fill sequence that fits the
message budget. The headline metric is **mean fill %** — how far along its mode's path the budget
carries a message, where 100% is the top of the path — shown for every priority mode
(Detail/Auto/Range) × variable selection (base, plus each optional group).
The report also draws the fill frontier, the median message's period layout, and per-view detail
(fill-resolution distribution strips, the share of forecasts reaching each rung, and a mean
bit-cost-per-column table). Interactive duration and variable selectors matching the app control
the detail view (`--duration` sets which one the report opens on; all are always computed).

`pnpm benchmark` runs both phases: it collects the forecast corpus (cached under `data/raw/<model>`, gitignored, idempotent/resumable) and then encodes each forecast through the production path, writing a timestamped HTML report to `data/benchmarks` (kept so runs can be compared side by side).

```bash
pnpm benchmark                     # collect (idempotent) then report
pnpm benchmark --report-only       # skip collection; report from cached data
pnpm benchmark --collect-only      # expand the cache without reporting (the pull can be long)
pnpm benchmark --dry-run           # preview the collection plan, no fetch
pnpm benchmark --duration 5        # 3/5/7/10 days (default 7)
pnpm benchmark --request-hour 18   # local hour of the request (default 7)
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
17. rANS unification: precip probability, rain, and snow move from the adaptive best-of
    (raw / FOR / sparse / empty + 2-bit mode selector) to order-1 rANS over values, keyed by
    (resolution, previous value) — full 8×8 context for precip probability, 5 previous-value
    buckets for the companded accumulations. Sparse charged a full bit per dry period; the
    order-1 tables charge a small fraction of one. Held-out bits/period: precip 2.12 → 1.00,
    snow 1.30 → 0.74, rain 1.98 → 1.15. Also removes cloud (total) — redundant with weathercode
    plus per-altitude cloud cover — and deletes the whole per-column scheme-selection machinery:
    every variable now rides the unified model above. (The benchmark changed alongside #16 to
    measure the real duration-first fill instead of fixed 1h/3h/6h forecasts, so periods/message
    isn't comparable to earlier entries.) Mean fill across all duration × variable views
    72.3% → 77.0%; per view +2.6 to +7.3 points (+2.7% to +11.3%), e.g. 7d base 78.2% → 85.1%
    and 10d base 64.4% → 71.7%.
18. Context-conditioned temperature deltas: the cheapest-of-16 k-means tables + 4-bit
    per-message selector give way to codebooks keyed by (resolution × time-of-day × previous
    delta) — all context both sides already have, so temp joins the unified model with zero
    per-message signaling. A held-out conditioning ladder (analyze-temp-heldout.ts) showed the
    old selector was mostly re-discovering resolution (res alone: 2.678 b/period vs 2.640 for
    the full selector); time-of-day (8 × 3h local buckets) captures the diurnal delta sign, and
    the previous-delta bucket adds the airmass's actual trajectory — a sign-consistent gain in
    all 5 location-folds. Solar elevation was measured and rejected (≈ time-of-day overall,
    worse at 12h — not worth pinning a solar formula into wire format). Held-out: 2.648 →
    2.335 b/period; per resolution 12h 5.367 → 5.065, 6h 4.244 → 3.742, 3h 3.232 → 2.836,
    1h 1.980 → 1.724.
19. Cross-variable conditioning for the wet columns: precip probability, snow, and rain key their
    codebooks on the **same period's weathercode class** (dry | rain-ish | freezing | snow-ish) on
    top of their existing context. Weathercode decodes first and is always present, so the class
    is free — no per-message signaling, the same trick the 600/700 hPa wind columns play on the
    upper level. Held-out (5-fold by location, analyze-cross-var-heldout.ts): precip 0.978 →
    0.876 b/period (32 → 128 contexts), snow 0.708 → 0.445 (20 → 80), rain 1.101 → 0.770 (20 →
    80). The class captures the shared latent outright — stacking a second cross-variable signal
    (rain on snow ≠ 0, snow on the precip-chance bucket) measured redundant on top of it. In the
    7d base view the three columns give up half a bit per period between them (rain 0.83 → 0.56,
    snow 0.53 → 0.33, precip 0.74 → 0.70). Mean fill across all duration × variable views
    78.2% → 80.1%; every view gains, and the gains scale with duration as the per-period saving
    compounds over more periods — 3d base 99.5% → 99.8% but 10d base 73.8% → 77.2% and 10d with
    high-altitude winds 41.8% → 44.2%. Cloud levels (−0.03) and weathercode × resolution (−0.033)
    were scanned and rejected as too small; freeze × temp-delta (−0.131) is deferred until the
    4-bit freezing-level anchor's 15,000 ft cap is widened, since real forecasts clip at it.
20. Freezing-level domain 4 -> 5 bits (cap 15,000 -> 31,000 ft). The old cap clipped 6.5% of
    corpus periods: the Andes and central Mexico sit above 15,000 ft nearly year-round, so those
    locations' freeze column decoded as a flat, permanently-saturated 15,000 ft (pisco 98.9% of
    periods clipped, belen 98.0%, chalcatongo-de-hidalgo 80.4%) — the variable was silently
    useless exactly where a freezing level is most interesting. The corpus tops out at 21,200 ft,
    so 5 bits never clips. Costs one anchor bit per model plus a slightly flatter delta table
    (1.340 -> 1.384 b/period, the un-clipped locations now carrying real motion instead of a
    constant): the +Freezing Level view gives up 0.2-0.4 pp of fill (7d 83.8% -> 83.4%, 10d
    69.8% -> 69.4%), mean fill across all views 80.1% -> 80.0%. Unblocks the freeze × temp-delta
    conditioning deferred in #19, which should more than pay this back.
21. Freeze × temp-delta conditioning (the deferral from #19, unblocked by #20): the freezing-level
    delta moves from one pooled table to codebooks keyed by (the arriving period's resolution, the
    **same period's temp-delta bucket**) — the 0°C isotherm moves with the airmass temperature, and
    temp decodes first, so its clamped-reconstruction delta is free context (the same trick as the
    wet columns' weathercode class in #19). A res-keyed fallback set covers messages without temp
    in vars_mask. Re-scanned post-widening, the gain held and slightly grew: held-out (5-fold by
    location) 1.445 -> 1.308 b/period (pooled -> res × tempΔ; res alone only reaches 1.393). Only
    the +Freezing Level view moves: 7d 83.4% -> 84.0%, 10d 69.4% -> 70.5% fill; mean fill across
    all views 80.05% -> 80.18% — paying back the anchor widening (#20) with change left over, as
    predicted there.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may read, modify, and use the code for any noncommercial purpose. Commercial use is reserved to the copyright holder.
