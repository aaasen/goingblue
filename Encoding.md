
In May 2026 I was preparing for a Denali ski expedition and decided to build a weather app because I wasn't satisfied with the existing options. Garmin's built-in weather is notoriously inaccurate. I wanted to be able to access the information that I use at home. Specifically the European model that I generally use with Windy.

## Limitations

 - Garmin InReach messages are limited to 160 characters.
 - GSM-7 basic
 - Garmin supports a few printable ASCII characters that are not in GSM-7 basic
 - base-85 alphabet

## Baseline: Abbreviated weather forecasts (8 time periods per message)

Other SMS/satellite weather forecasting services like [BoltWX](https://boltwx.com/) use abbreviated weather forecasts like:

```
Th5a -6*FzFgNW10_Ovc    Thursday 5am -6°C, freezing fog, winds NW 10 km/h, overcast
Th2p 2*LtSnW20_Bkn      Thursday 2pm 2°C, light snow, winds W 20 km/h, broken clouds
Th11p 0*Pel!NE35_Ovc    Thursday 11pm 0°C, ice pellets, lightning, winds NE 35 km/h, overcast
Fr5a 3*LtRnSE15_Sct     Friday 5am 3°C, light rain, winds SE 15 km/h, scattered clouds
Fr2p 11*SW25_Clr        Friday 2pm 11°C, no rain, winds SW 25 km/h, clear skies
Fr11p 7*MRnW30_Bkn      Friday 11pm 7°C, moderate rain, winds W 30 km/h, broken clouds
```

These abbreviations take about 16-20 characters. With separators that is up to 9 time periods per message. 

## Binary format (8 -> 24 time periods per message)

My first idea for improving the weather forecast was to use a binary format instead of textual one to take advantage of the full character set. 

The abbreviated format is simple and human-readable but it doesn't take advantage of the full character set. For example, the day of the week takes two characters, which in base-85 is enough to represent 7,225 unique values, or 12 bits of information. Only 3 bits are really needed to represent this. 

The major problem with a binary format is that it isn't human-readable, so it needs some sort of client-side decoder. For Denali, I built a simple decoder as a Progressive Web App. On iPhone and Android these PWAs can be installed as apps and they stay cached for some amount of time. 

With the binary format we use only as many bits as necessary for the value:
 - Wind direction: 3 bits to represent 8 directions (N, NE, E, SE, S, SW, W, NW)
 - Wind speed: 4 bits to represent wind speed from 0-75mph in 5mph increments
 - Temperature: 7 bits to represent temperature from -40C to 87C in 1C increments
 - Precipitation chance: 3 bits to represent precipitation chance in 14% increments
 - Rain: 6 bits to represent rain in 1mm increments
 - Snowfall: 6 bits to represent snowfall in 1cm increments
 - Weathercode: 5 bits to represent 28 different WMO weather codes

Using a binary format I got each time period down to about 40 bits. After subtracting the message header (31 bits), there's about 996 bits left for the data which is 24 time periods. A 3x improvement over the abbreviated format!

## Frame of Reference Encoding

With the fixed binary format above, there's a lot of range that we aren't taking advantage of. For example, we allocate 7 bits (128 values) to represent temperature, but the actual range of temperature in a forecast is much smaller. An easy win here is frame of reference encoding, where we encode the minimum value in the header and then encode the delta for each time period. For most forecasts we can shrink the temperature encoding from 7 bits to 4 (15C delta).

## Sparse Encoding

Some variables like snowfall and rain are often zero. It's a waste to use 6 bits to represent zero. Instead, we can use a sparse encoding where we encode a single presence bit followed by the value if it is non-zero. This saves 5 bits per period for zeros but adds one bit per period for non-zeros. We can also have a global presence bit in the header to indicate whether the variable is ever non-zero in the forecast period. 

For Going Blue, I used a dynamic encoding strategy. The header contains 2 bits that represent the encoding strategy (empty, sparse, FOR, raw) for the variable. The server chooses whichever strategy is the most efficient for the variable.

## Companding

One of the issues with the rain and snow encoding in a binary format is that it is a linear scale the needs to be fairly precise. On an otherwise clear day, we care about 1mm of rain in an hour. At the day scale, it's possible for rainfall to reach well over a meter. Representing the range 0-1m in 1mm increments would take 1,000 values or 10 bits.

A 1mm difference in rainfall could be a decision point if it is 0->1mm. The same difference doesn't matter at all if it is 70mm->71mm. Instead of using a linear scale, we can use a sqrt scale to represent the data. This gives a range of 0–144 mm.

## Huffman Coding

Huffman coding is a lossless compression algorithm that assigns variable-length codes to values based on their frequency. More frequent values are assigned shorter codes and less frequent values are assigned longer codes. This can be much more efficient than fixed-length encoding if the probability distribution is skewed. 

Codes are generated by calculating the probability distribution of the dataset and then constructing a binary tree. No code is a prefix of another code. To decode a message, walk the tree until you hit a leaf node. 

WMO weathercodes are heavily skewed with just two codes making up the majority and the top 5 making up 80% of the data:
 - 0 Clear sky 31.6% `11`
 - 3 Overcast 29.3% `10`
 - 45 Fog 7.60% `000`
 - 51 Light drizzle 6.83% `0111`
 - 1 Mainly clear 4.98% `0101`

Rare weather conditions have much longer codes:
 - 66 Light freezing rain 0.03% `0110101001111`

```
root
  ├─ 0
  │  ├─ 0
  │  │  ├─ 0 → WMO 45: Fog              [000]
  │  │  └─ 1 → …
  │  └─ 1
  │     ├─ 0
  │     │  ├─ 0 → …
  │     │  └─ 1 → WMO 1: Mainly clear   [0101]
  │     └─ 1
  │        ├─ 0 → …
  │        └─ 1 → WMO 51: Light drizzle [0111]
  └─ 1
     ├─ 0 → WMO 3: Overcast             [10]
     └─ 1 → WMO 0: Clear sky            [11]
```

huffman.png

## Climate Clustering for Weathercodes

For my first pass at Huffman coding, I calculated the global probability distribution of weathercodes. One improvement that can be made to this is using different Huffman trees for different climate regions. An arctic location is much less likely to experience thunderstorms than a tropical location. A tropical location is almost never going to see snow.

I split the dataset into 16 climate types using k-means clustering and generated a separate Huffman tree for each cluster.

## Prior Weathercode

Climate is a decent predictor of weather, but an even better predictor of future weather is the current weather. If it is sunny now, it will probably be sunny an hour from now. If the current weathercode is "Clear sky", the probability distribution of the next hour's weathercode is:
 - 0 Clear sky 85.4%
 - 1 Mainly clear 5.1%
 - 3 Overcast 4.7%
 - 2 Partly cloudy 3.2%
 - 45 Fog 1.1%

 Since the distribution is so skewed towards clear sky, the Huffman code for it is simply `1`. If the weather isn't changing, we only need a single bit to encode it! That's a huge improvement over the original binary encoding that would consume 5 bits per time period even if the weather wasn't changing.

 The same technique is also easy to apply to wind direction, which has 8 possible values.

 ## Applying Huffman Coding to Numerical Values

 Weathercodes (28 options) and wind direction (continuous value made into 8 discrete options) are great fits for Huffman coding because there is a small set of discrete values with a heavily skewed distribution.

 We can apply the same technique to numerical values by applying it to the delta. For temperature, the temperature of the next hour is within 2 degrees of the current temperature 97.3% of the time:
 - 0C 50.4%
 - -1C 20.4%
 - +1C 18.3%
 - +2C 4.2%
 - -2C 4.0%

Instead of using 7 bits to encode each temperature, we can use 7 bits to encode the baseline, then a variable number of bits to encode the delta. 50% of the time we are only using a single bit per period, and 97% of the time we are using 5 bits or less.

## rANS Encoding

Huffman coding is a huge improvement over the original binary encoding, but it still has a 1 bit floor. Even with a distribution where 1 value occurs 100% of the time, Huffman coding still requires at least 1 bit per period. rANS removes this floor.
