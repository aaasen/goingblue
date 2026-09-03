import type { Context } from "hono";
import { BRAND, CONTACT_EMAIL } from "../constants.js";
import { PAGE } from "./shell.js";
import { DELETION_HTML } from "./privacy.js";

// The App Store listing points its Support URL here rather than at the landing page: a reviewer
// checking that support exists should land on a page that is unambiguously support, and the
// landing page is marketing. Contact goes first — a support page that makes you read an FAQ
// before it tells you how to reach a person has it backwards.
const SUPPORT_BODY = `
<div class=cta>
  <h2 style="margin-top:0">Get in touch</h2>
  <p><strong>Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></strong> with questions,
  bug reports, or anything the answers below don't cover.</p>
</div>

<h2>Do I need a satellite messenger?</h2>
<p>No. ${BRAND} can send a forecast request three ways: over an ordinary internet connection, as a
text message, or from a satellite messenger. The app is useful with nothing but a phone — the
satellite path is there for when you are past the end of cell service.</p>

<h2>Which devices work?</h2>
<p>Any satellite messenger that can send and receive SMS. We have tested Garmin inReach and iPhone
satellite messaging. The <strong>Setup</strong> section in the app walks through each one.</p>

<h2>How do I request a forecast?</h2>
<ol>
  <li>On the <strong>Builder</strong> tab, set a location, pick a weather model, and choose the
  variables you want.</li>
  <li>Choose your device and send the request — <strong>Internet</strong> fetches the forecast over
  your data connection, <strong>SMS</strong> texts it from your phone, and <strong>inReach</strong>
  copies the message to paste into your satellite messenger.</li>
  <li>Paste the reply into the <strong>Decoder</strong> tab to see the full forecast.</li>
</ol>

<h2>The reply will not decode</h2>
<p>Two things cause this:</p>
<ul>
  <li><strong>The message is incomplete or has extra text.</strong> A forecast has to be pasted
  whole and on its own. Some messenger apps add text when you copy — remove anything that is not
  the reply itself.</li>
  <li><strong>The app is out of date.</strong> Forecasts carry a protocol version. If a reply uses
  a newer version than your app understands, the Decoder says so — update the app and request a
  new forecast.</li>
</ul>

<h2>How do I delete my data?</h2>
${DELETION_HTML}

<h2>Where does the weather data come from?</h2>
<p>Forecasts are retrieved from <a href="https://open-meteo.com/">Open-Meteo</a>, which serves
models from NOAA in the United States, ECMWF in Europe, and Environment and Climate Change Canada,
among more than thirty regional models. The app can pick the highest-resolution model for your
location automatically, or you can choose a forecast center yourself and compare them.</p>

<h2>Why is the forecast one short message?</h2>
<p>Satellite messengers charge per message and limit how much each one carries, so a forecast has
to fit in a single 160-character reply. ${BRAND} uses a compression codec built for that limit:
the reply is not readable text but a dense encoding the app unpacks into a full multi-day
forecast. That is why it has to be pasted into the app rather than read directly.</p>

<h2>Forecasts are informational</h2>
<p>Forecasts may be inaccurate, delayed, or unavailable. Do not rely on ${BRAND} as your sole
source of weather information for decisions affecting safety, including in remote or backcountry
settings.</p>
`;

// No "Last updated" stamp: that belongs on the legal documents, where the revision date carries
// meaning. On a support page it just looks stale the moment an answer stops changing.
export function support(c: Context) {
  return c.html(PAGE("Support", SUPPORT_BODY, { showUpdated: false }));
}
