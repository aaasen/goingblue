import { MODEL_INFO, OPEN_METEO_DOCS, horizonText } from "@weather/protocol";
import { BRAND, REPO_URL } from "../constants.js";
import { DELETION_HTML } from "./privacy.js";

// The FAQ shared by the landing page and /support. Each answer is a native <details>, collapsed by
// default, so the list works without JavaScript. The native disclosure marker is replaced with a
// chevron that rotates open, since Safari and Chrome draw the default triangle differently.
export const FAQ_CSS = `
  .faq { border-top: 1px solid #ddd; }
  .faq details { border-bottom: 1px solid #ddd; }
  .faq summary { display: flex; gap: 10px; padding: 12px 0; cursor: pointer; font-weight: 600;
    list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::before { content: ""; flex: none; width: 7px; height: 7px; margin-top: 0.5em;
    border-right: 2px solid #888; border-bottom: 2px solid #888; transform: rotate(-45deg);
    transition: transform 0.15s; }
  .faq details[open] summary::before { transform: rotate(45deg); }
  .faq .answer { padding: 0 0 0.6em 19px; }
  .faq .answer > :first-child { margin-top: 0; }
  .faq .answer p + :is(ul, ol) { margin-top: -0.6em; }
`;

// The app's Weather Model info sheet, as HTML.
const MODELS_HTML = MODEL_INFO.map((m) => `
    <p><strong>${m.name}</strong>: ${m.desc}</p>${m.models.length ? `
    <ul>${m.models.map(({ spec, region }) => `
      <li>${spec.label}: ${horizonText(spec.horizonHours)}, ${region}</li>`).join("")}
    </ul>` : ""}`).join("");

export const FAQ_HTML = `
<div class=faq>
<details>
  <summary>Which devices can I use with ${BRAND}?</summary>
  <div class=answer>
    <p>${BRAND} supports several different ways to get a forecast:</p>
    <ol>
      <li>Internet if you have Wi-Fi or cell service.</li>
      <li>Direct to cell satellite internet like Starlink Direct to Cell, T-Mobile T-Satellite,
      etc.</li>
      <li>SMS text messaging, including SMS via satellite.</li>
      <li>Garmin inReach with the Garmin Earthmate and Garmin Messenger apps. All inReach models
      are supported.</li>
      <li>iPhone satellite messaging.</li>
      <li>ZOLEO.</li>
    </ol>
  </div>
</details>
<details>
  <summary>Where do forecasts come from?</summary>
  <div class=answer>
    <p>Forecasts are sourced from regional weather centers including NOAA in the US, ECMWF in
    Europe, Environment Canada, and DWD in Germany. <a href="https://open-meteo.com/">Open-Meteo</a>
    provides the forecasts.</p>
  </div>
</details>
<details>
  <summary>Which weather models are supported?</summary>
  <div class=answer>${MODELS_HTML}
    <p>For model details, see <a href="${OPEN_METEO_DOCS}">Open-Meteo</a>.</p>
  </div>
</details>
<details>
  <summary>How does model agreement work?</summary>
  <div class=answer>
    <p>Model agreement shows how well the amount of precipitation in the current forecast agrees
    with other forecasts. There are four levels of agreement:</p>
    <ul>
      <li><strong>Strong agreement</strong>: Forecasts agree that there will be no precipitation, or
      agree on the amount of precipitation.</li>
      <li><strong>Weak agreement</strong>: Forecasts agree that there will be precipitation but the
      amounts differ slightly.</li>
      <li><strong>Weak disagreement</strong>: Forecasts agree that there will be precipitation but
      the amounts differ significantly.</li>
      <li><strong>Strong disagreement</strong>: One forecast calls for dry conditions and the other
      calls for significant precipitation.</li>
    </ul>
  </div>
</details>
<details>
  <summary>Why do ${BRAND} forecasts look like gibberish?</summary>
  <div class=answer>
    <p>To fit as much data as possible into each message, ${BRAND} uses a compressed binary format
    that can only be decoded by the app. A full explanation of the codec is available on
    <a href="${REPO_URL}#compression">GitHub</a>.</p>
  </div>
</details>
<details>
  <summary>How can I delete my data?</summary>
  <div class=answer>
    ${DELETION_HTML}
  </div>
</details>
</div>
`;
