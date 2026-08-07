# Going Blue

Going Blue is a weather app designed specifically for satellite messengers. It was built for a Denali ski expedition with one goal: to get you all the weather information you would have at home, wherever you are. Going Blue uses a custom compression codec and decoder app to pack hundreds of forecast data points into a single 160-character message. Going Blue is deployed at [going.blue](https://going.blue/).

## How it works

To use Going Blue, a user:
1. Creates a forecast request in the app, specifying location, weather model, and weather variables.
1. Sends the forecast request to the Going Blue over the internet, SMS, or satellite messenger like Garmin inReach or ZOLEO.
1. Receives an encoded forecast.
1. Pastes the encoded forecast into the app to visualize the forecast.

## Architecture

There are a few components to the system:
1. Forecast source: [Open-Meteo](https://open-meteo.com/) which provides all forecast data.
1. Going Blue service: handles incoming SMS, fetches forecasts from Open-Meteo, and replies with encoded forecasts.
1. Going Blue app: mobile app for creating forecast requests and decoding/visualizing forecast responses.

The service is written in TypeScript. There are four packages:
- `packages/protocol` — shared TypeScript binary encoding/decoding used by both the server and the mobile app.
- `packages/server` — Hono/Node.js server; receives inbound messages, fetches forecasts, and sends replies.
- `packages/codec-server` — Codec server for encoding messages. This is separate from the main server so that old codecs can be kept deployed as-is while the codec is modified.
- `packages/mobile` — Expo React Native app for building requests and decoding forecasts.

## Compression

Going Blue uses Markov model of weather combined with a [rANS](https://en.wikipedia.org/wiki/Asymmetric_numeral_systems) entropy coder. 

To see how this works, let's step through an example of encoding the weathercode, which is a general summary of weather conditions in a single symbol. There are 28 different weathercodes, so encoding weathercode without compression would take 5 bits. We can take advantage of the fact that the current weather is a good predictor of future weather. For example, if it is currently sunny, this is the probability distribution of the next hour's weather:

| Next hour | Probability |
|---|---|
| ☀️ clear sky | **85.40%** |
| 🌤️ mainly clear | 8.68% |
| ⛅ partly cloudy | 2.67% |
| ☁️ overcast | 2.58% |
| 🌦️ light drizzle | 0.458% |
| … everything else | 0.192% combined |

We can then represent a forecast as series of state transitions with different probabilities i.e. a Markov chain: ☀️ -> ☀️ -> ⛅ -> ⛅ -> 🌦️. 

We can then feed this probability distribution into an entropy coder like a Huffman coder. In Huffman coding, each symbol is assigned a code based on its probability. The more likely a symbol is, the shorter its code: 

| conditions | P | bits | code |
|---|---|---|---|
| ☀️ clear sky | 85.40% | 1 | `0` |
| 🌤️ mainly clear | 8.68% | 2 | `10` |
| ⛅ partly cloudy | 2.67% | 3 | `110` |
| ☁️ overcast | 2.58% | 4 | `1110` |
| 🌦️ light drizzle | 0.458% | 5 | `11110` |

In this example, the clear -> clear transition is very likely so it gets a 1-bit code: `0`. The clear -> light drizzle transition is unlikely, so it gets a 5-bit code: `11110`. The expected length of the encoded forecast is only 1.248 bits/symbol, far below the 5 bits/symbol that would be required to encode any of the 28 different weathercodes. The actual encoded length may vary depending on the forecast. If it's completely clear for the entire forecast period, we will just use 1 bit per period. In more variable conditions, we will need more bits for each forecast period. 

The actual entropy coder that Going Blue uses is [rANS](https://en.wikipedia.org/wiki/Asymmetric_numeral_systems#Range_variants_(rANS)_and_streaming) which removes the 1-bit floor of Huffman coding by encoding the entire forecast into a single large number instead of going symbol by symbol. See this [post](https://kedartatwawadi.github.io/post--ANS/) for a great explanation of asymmetric numeral systems. With the Huffman coder, we can reach 1.248 bits/symbol. rANS brings us much closer to actual entropy of the data, which is 0.833 bits/symbol. 

The same technique can be applied to other weather variables

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

## Development

Everything needed to run locally is bundled into one tmux session:

```
pnpm install
./dev.sh
./dev.sh kill
```

The services run on the following ports by default:
 - Postgres: 5432
 - Gateway server: 8080
 - Codec server: 8082
 - Expo (mobile app server): 8081

To run the iOS app:

```
cd packages/mobile
eas build -p ios --profile development
```

Then install the app on your iOS device using the QR code in the step above.

The app can also be run in the simulator:

```
cd packages/mobile
npx expo run:ios
```

For a non-development build:

```
eas build --platform ios --profile preview
```

### Tests

```bash
pnpm test
```

## License

Copyright 2025-2026 Lane Aasen

Licensed under the [Apache License, Version 2.0](LICENSE). You may use, modify, and distribute this
software, including commercially, provided you retain the copyright and license notices and state
any significant changes you make. The license includes an express patent grant. See [NOTICE](NOTICE)
for the required attribution notice.

Forecast data comes from [Open-Meteo](https://open-meteo.com/) via its public API and is subject to
Open-Meteo's own terms; no Open-Meteo source code is included here.
