
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

## Improving the Binary Format

The binary format is a large improvement over a human-readable character-based format, but it's still wasting a lot of bits on information that isn't useful. The main issue is that we need to allocate enough bits to each variable to cover its entire range even though we will only use a small part of that range. For example, 7 bits are allocated to temperature to represent a 127°C range even though most forecasts have a range of only 10°C. We allocate 6 bits to snowfall even though most forecasts include no snowfall at all. We allocate 6 bits to rain so that we can report amounts as low as 1mm in a hour and as high as 64mm in a day. This waste of bits can be addressed with a few different techniques.

### Frame of Reference Encoding

With the fixed binary format above, there's a lot of range that we aren't taking advantage of. For example, we allocate 7 bits (128 values) to represent temperature, but the actual range of temperature in a forecast is much smaller. An easy win here is frame of reference encoding, where we encode the minimum value in the header and then encode the delta for each time period. For most forecasts we can shrink the temperature encoding from 7 bits to 4 (15C delta).

### Sparse Encoding

Some variables like snowfall and rain are often zero. It's a waste to use 6 bits to represent zero. Instead, we can use a sparse encoding where we encode a single presence bit followed by the value if it is non-zero. This saves 5 bits per period for zeros but adds one bit per period for non-zeros. We can also have a global presence bit in the header to indicate whether the variable is ever non-zero in the forecast period. 

For Going Blue, I used a dynamic encoding strategy. The header contains 2 bits that represent the encoding strategy (empty, sparse, FOR, raw) for the variable. The server chooses whichever strategy is the most efficient for the variable.

### Companding

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

## Unified Model

Eventually, I settled on a single model to represent all weather variables. 

Each variable can be represented by a Markov chain with a discrete set of states and transition probabilities. The states either represent the previous value or the previous delta. Previous value is used for variables that have a small range of values, e.g. wind direction, weathercode, rain amount (bucketed). Previous delta is used for variables that have a large range of values and where the previous delta is more predictive than the previous value. For example, temperature is encoded using previous delta. If I want to know how much the temperature will change in the next hour, it's more useful to know that it increased by 1C in the previous hour than it is to know that it is currently 25C. Conversely, if I want to know how much it will snow in the next hour, it's more useful to know that it snowed 2cm in the last hour than it is to know that the snowfall rate increased by 1cm in the last hour.

## Improving Model Context

With all variables unified in the Markov rANS model, context becomes the main lever for improving compression performance.

For example, for temperature we can use the following context:
 - Forecast resolution
 - Time of day (8 buckets)
 - Previous delta (5 buckets)

I also experimented with using solar elevation instead of time of day but it was not as effective.

## Cross-Variable Correlation

Now that everything is on Markov rANS, I think the remaining room to optimize the codec is taking advantage of cross-variable correlation. Currently all variables are independent even though they are representing the same change in the weather. For example, if there is a storm coming in many variables change at the same time: weathercode shifts to rain, precip chance increases, rainfall starts. I think that we can take advantage of these correlations by selecting codebooks based not only on the previous value, but on other variables.

## Model Training

The core idea that makes this codec efficient is that the client and server have a shared probabilistic model of weather and only the entropy needs to be sent between the two. A forecast that matches the distribution well can be encoded very efficiently whereas one far outside the normal distribution will take many bits to encode. This means that the shared probability distribution needs to be representative of real-world forecasts.

For my first pass at the corpus, I pulled my Windy favorites since these are locations where I often check the weather. There are 137 of them and they are heavily concentrated in mountainous mid-latitude/polar regions: Cascades, BC, Alaska, NZ, Norway, the Alps. It's a fairly good sample for ski weather but excludes most of earth's climates. I pulled a year of data for the GFS seamless model (HRRR/GFS) through the [Open-Meteo historical weather API](https://open-meteo.com/en/docs/historical-weather-api) so that I would get full seasonal coverage. Open-Meteo also provides a [Single Runs API](https://open-meteo.com/en/docs/single-runs-api) but full model coverage only goes back to April 2026. ECMWF HRES is available going back to 2024 but I found the coverage to be spotty and the HRES model excludes pressure-level variables and freezing level. 

I found that the codebooks trained on my favorites underperformed especially in tropical locations. This makes sense considering that my favorites are heavily biased towards cool climates suitable for skiing and contain no tropical locations. Tropical locations cost an average of 10.74 bits/period which is 35% more than the training set (7.93). De-deriving the codebooks yielded a nice improvement, especially in tropical and ocean regions that weren't represented at all in the training data.

┌───────────────┬───────────────────┬────────────┬───────┐
│    Stratum    │ Old (ski-trained) │ Re-derived │   Δ   │
├───────────────┼───────────────────┼────────────┼───────┤
│ Köppen A      │ 10.74             │ 9.73       │ −1.01 │
├───────────────┼───────────────────┼────────────┼───────┤
│ Köppen B      │ 7.09              │ 6.61       │ −0.48 │
├───────────────┼───────────────────┼────────────┼───────┤
│ Köppen C      │ 8.22              │ 7.73       │ −0.49 │
├───────────────┼───────────────────┼────────────┼───────┤
│ Köppen D      │ 7.03              │ 6.67       │ −0.36 │
├───────────────┼───────────────────┼────────────┼───────┤
│ Köppen E      │ 5.69              │ 5.43       │ −0.26 │
├───────────────┼───────────────────┼────────────┼───────┤
│ ocean 0°–30°N │ 9.80              │ 8.58       │ −1.22 │
├───────────────┼───────────────────┼────────────┼───────┤
│ favorites     │ 7.93              │ 8.09       │ +0.16 │
└───────────────┴───────────────────┴────────────┴───────┘

┌────────────────────────┬─────────┬─────────┬──────────────┐
│        Stratum         │ Old b/p │ New b/p │ Fill old→new │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ Köppen A (tropical)    │ 10.74   │ 9.73    │ 82.6→84.6%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ Köppen B (arid)        │ 7.09    │ 6.61    │ 91.6→93.0%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ Köppen C (temperate)   │ 8.22    │ 7.73    │ 88.6→89.7%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ Köppen D (continental) │ 7.03    │ 6.67    │ 91.4→92.5%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ Köppen E (polar)       │ 5.69    │ 5.43    │ 95.4→96.1%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ ocean 0°–30°N          │ 9.80    │ 8.58    │ 85.4→87.8%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ ocean 30°S–0°          │ 9.20    │ 7.96    │ 86.3→89.2%   │
├────────────────────────┼─────────┼─────────┼──────────────┤
│ favorites              │ 7.93    │ 8.09    │ 88.9→88.6%   │
└────────────────────────┴─────────┴─────────┴──────────────┘


I didn't want the codec to be too biased towards skiing, so I set out to expand the corpus to include a representative sample of earth's weather. To do this, I started by using [Köppen climate classification](https://en.wikipedia.org/wiki/K%C3%B6ppen_climate_classification) which has 5 main groups (tropical, dry, temperate, continental, and polar) that are further broken down into 30 total classifications. There's a huge range in how common each classification is so I decided to weight each climate by the square root of its land area. This strikes a balance between random sampling of all locations (high weight to common climates) and sampling by climate class (high weight to uncommon climates). 

Köppen only includes land. Ocean weather differs substantially, with cooler temperatures, no diurnal swings, and more consistent winds. I divided the ocean area into 30° latitude bands (0°->30°N, 30°N->60°N, etc.) and used the same `sqrt(area)` weighting for them. Since ocean weather is much less variable, I split the sampled points 85% land/15% ocean. This brings the ocean climate in line with other high-level Köppen groups, which account for about 10-20% each.

I randomly sampled 10,000 locations (85% land, 15% ocean) and excluded locations that were within 25km of another point so that two points wouldn't be in the same grid cell of a weather model. The original corpus of Windy favorites is now used as a validation set but isn't used for training. 

I sampled data going back 10 years and included 12 14-day forecasts for each point. I split up the 2 years into 12 blocks 2-months each and randomly selected a point within that time frame. This should give a good range of weather forecasts.

When I looked at the sampling based on Köppen classification, I noticed something interesting. Norway and Sweden were sparsely sampled, but eastern Siberia was one of the most densely sampled regions in the world. This is because most of Scandinavia, Siberia, Canada, Alaska, and high altitude mountain ranges throughout the world share the `Dfc` climate (Continental, no dry season, cold summer). Due to the contrast of the wintertime [Siberian High](https://en.wikipedia.org/wiki/Siberian_High) and the summertime monsoon, parts of NE Siberia/Yakutia are classified as `Dwc`/`Dwd` meaning they have dry winters (driest winter month has less than 1/10 the precipitation of the wettest summer month), and either cold or severely cold winters (coldest month below -30°C/-36.4°F). 

I also experiemented with biasing the locations towards peaks. Mountain weather tends to be colder and windier than the surrounding lowlands. Going Blue users are more likely to be in the mountains so I wanted to make sure that these forecasts encded well. To test this I sampled peaks with over 600m of prominence and grouped them by elevation band. I found that the existing codec worked well for peaks. It actually worked better than for tropical locations and for my favorites set. I decided not to bias the training data towards peaks.

┌─────────────────────────────────┬───────────┬───────┬─────────────┐
│             Stratum             │ Locations │ Fill  │ bits/period │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ peaks <3.5 km                   │ 60        │ 91.9% │ 6.90        │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ peaks 3.5–5.5 km                │ 59        │ 90.6% │ 7.41        │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ peaks ≥5.5 km                   │ 31        │ 92.3% │ 6.95        │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ favorites (ski-skewed eval set) │ 137       │ 88.6% │ 8.09        │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ Köppen A (worst stratum)        │ 216       │ 84.6% │ 9.73        │
├─────────────────────────────────┼───────────┼───────┼─────────────┤
│ Köppen E (best)                 │ 150       │ 96.1% │ 5.43        │
└─────────────────────────────────┴───────────┴───────┴─────────────┘


file:///Users/laneaasen/dev/weather/data/corpus-map.svg


The Going Blue codec is trained on:
 - 2 years of historical weather data
 - 500 locations
 - 14-day forecasts pulled at 10-day intervals
 - 4 different weather models (best_match, gfs_seamless, ecmwf_ifs/ecmwf_ifs025, gem_seamless)

Forecasts are pulled from the [Open-Meteo historical weather API](https://open-meteo.com/en/docs/historical-weather-api). The total corpus far exceeded the limits of the free tier so I upgraded to the professional plan to pull the corpus.

## Climate Clustering

Earlier, I tried using climate to predict weathercode. I ran k-means clustering on the weathercode distributions and then created a separate weathercode for each cluster with the encoder choosing the one that minimized message length. This approach turned out to not work as well as having a separate codebook for each weathercode, since the current weather is a better predictor of future weather than the climate is. 

After expanding the corpus to be more representative of the whole planet's weather, I wondered if it was time to bring back multiple codebooks. There are large differences in the distribution of weather, so I think that having some best-of mechanism will help.

This time the selector is global — one codebook class per message, covering every variable's tables at once — rather than per-variable. The v1 header was 22 bits packed into 4 base-85 characters, which hold 25.6 bits, so a 3-bit class selector rides completely free: up to 8 classes with zero wire cost (a 9th class would cost a whole extra character). Classes are learned by k-means/EM in code-length space: each training forecast (location × window) is summarized as sparse context×symbol counts, the cost of a forecast under a class is just counts · code lengths, and the assignment step is exactly the encoder's try-all-pick-best. Class 0 is pinned to the global tables as a floor, class rows are smoothed toward the global distribution so rare contexts don't fragment, and weak classes are reseeded from the worst-encoded forecasts. The whole ladder runs off precomputed per-forecast counts, so no corpus re-scans.

Doubling the class count kept helping all the way to the free-selector limit, at a remarkably steady ~0.85% per doubling (held-out eval split):

┌──────────────┬────────────────┬──────────────────┐
│   Codebooks  │ Δ vs global    │ Δ vs previous K  │
├──────────────┼────────────────┼──────────────────┤
│ 1 (global)   │ —              │ —                │
├──────────────┼────────────────┼──────────────────┤
│ 2            │ −0.84%         │ −0.84%           │
├──────────────┼────────────────┼──────────────────┤
│ 4            │ −1.65%         │ −0.82%           │
├──────────────┼────────────────┼──────────────────┤
│ 8            │ −2.50%         │ −0.86%           │
└──────────────┴────────────────┴──────────────────┘

┌──────────────────┬────────────────────────────┬────────────────────────────┐
│     Stratum      │   b/period before → now    │     fill before → now      │
├──────────────────┼────────────────────────────┼────────────────────────────┤
│ Köppen A (worst) │ 9.73 → 9.04                │ 84.6 → 85.9%               │
├──────────────────┼────────────────────────────┼────────────────────────────┤
│ Köppen E (best)  │ 5.43 → 5.09                │ 96.1 → 96.6%               │
├──────────────────┼────────────────────────────┼────────────────────────────┤
│ tropical oceans  │ 8.58 / 7.96 → 7.84 / 7.17  │ 87.8 / 89.2 → 89.5 / 91.4% │
├──────────────────┼────────────────────────────┼────────────────────────────┤
│ favorites        │ 8.09 → 7.73                │ 88.6 → 89.5%               │
├──────────────────┼────────────────────────────┼────────────────────────────┤
│ Denali           │ seq mean 29.9 → 30.4 of 32 │                            │
└──────────────────┴────────────────────────────┴────────────────────────────┘

The classes the EM found are recognizably climatic. K=2 split off a marine regime (biggest wins in the Southern Ocean); K=4 added a tropical-ocean class; at K=8 every stratum improves — tropical oceans by 5.5–6.5%, tropical land 3.7%, my favorites 2.1% — and the global class 0 wins only ~7.5% of real messages. Temperature benefits most from class conditioning (−6.2% at K=8), which makes sense: the diurnal delta distributions differ enormously between, say, a marine layer and a continental interior. The smoothing strength barely matters (α of 50, 200, and 800 land within 0.01% of each other) because each class still trains on ~13k forecasts. I stopped at 8 classes: the gains hadn't hit an elbow, but 8 is where the free header bits run out.

Tropical takes the most bits to encode, polar takes the least

  Köppen A           216 locs    2559 cells  fill  50.9%  14.62 bits/period
  Köppen B           292 locs    3457 cells  fill  61.4%  11.08 bits/period
  Köppen C           242 locs    2874 cells  fill  55.8%  12.61 bits/period
  Köppen D           376 locs    4458 cells  fill  60.5%  11.18 bits/period
  Köppen E           150 locs    1774 cells  fill  73.5%  8.68 bits/period
  ocean 60°N–90°N     21 locs     248 cells  fill  70.7%  8.94 bits/period
  ocean 30°N–60°N     35 locs     417 cells  fill  62.9%  10.86 bits/period
  ocean 0°–30°N       48 locs     569 cells  fill  62.6%  10.96 bits/period
  ocean 30°S–0°       50 locs     594 cells  fill  64.3%  10.36 bits/period
  ocean 60°S–30°S     48 locs     572 cells  fill  58.8%  11.71 bits/period
  ocean 90°S–60°S     24 locs     285 cells  fill  58.8%  11.64 bits/period
  peaks <3.5 km       60 locs     710 cells  fill  60.8%  11.30 bits/period
  peaks 3.5–5.5 km    59 locs     696 cells  fill  56.3%  12.60 bits/period
  peaks ≥5.5 km       31 locs     367 cells  fill  59.4%  11.85 bits/period
  favorites          137 locs   10138 cells  fill  55.4%  12.78 bits/period

## Model Choice

Weather models behave very differently and I think it's important to know which one a forecast comes from. For example, the ECMWF models change a lot at the long range. The 10-day forecast seems to go through the full range of forecast possibilities.

Going Blue is powered by [Open Meteo](https://open-meteo.com/) which supports over 30 weather models from weather centers around the world. For Going Blue, the following weather models are supported:
 - `best_match`: Chooses the highest resolution weather model available at the forecast point. 

One of the reasons I built Going Blue is that I wanted to be able to pull different models, or at least know which model I was looking at. Most weather forecasting apps try to hide this information

## Beaufort Scale for Wind

https://en.wikipedia.org/wiki/Beaufort_scale

# References

 - Compression by trimming the mantissa of floating point numbers to exclude those that contain "false information"/noise. https://www.nature.com/articles/s43588-021-00156-2
 - ECMWF Code 4 Earth: https://github.com/ECMWFCode4Earth/Challenges_2026
 - rANS explanation: https://kedartatwawadi.github.io/post--ANS/
 - https://www.pascalspoerri.ch/projects/
