import type { Context } from "hono";

const BRAND = "Going Blue";
const LAST_UPDATED = "August 5, 2026";
const CONTACT_EMAIL = "help@going.blue";
const FORECAST_NUMBER = "+14254345858";
const REPO_URL = "https://github.com/aaasen/goingblue";

// The landing page is headed by a full-bleed photo of Sultana in a band of its own, with the
// masthead over it — the photo is a defined section of the page, not the backdrop behind all of
// it. Served at two widths from /img (assets.ts); the small one is plenty for a phone and a
// quarter of the bytes.
//
// The source photo is cropped so the summit is the center of the frame, which is what lets the
// band crop around it: horizontally `center` holds the summit in the middle at any width. The
// vertical is `top` rather than `center` because the summit sits a tenth of a frame below the
// upper edge — on a band wider than the photo's 2.46:1 the `cover` crop eats height, and any
// anchor but the top carries the peak up and out of the band.
//
// The app icon sits above the title. The icon file is square and unrounded (iOS applies the mask
// itself), so the corner radius is ours to draw: 22.4% of the width is Apple's own superellipse
// proportion, which is what makes it read as an app icon rather than a photo.
const HERO_CSS = `
  .hero {
    display: flex; align-items: center; justify-content: center;
    height: 480px; padding: 0 20px; text-align: center; color: #fff;
    background: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
      url(/img/sultana-1200.jpg) center top / cover no-repeat #0c2240;
  }
  @media (min-width: 801px) {
    .hero {
      background-image: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
        url(/img/sultana-2400.jpg);
    }
  }
  @media (max-width: 600px) { .hero { height: 380px; } }
  .hero h1 { margin: 0.5em 0 0.12em; font-size: 2.2em; letter-spacing: -0.02em;
    text-shadow: 0 2px 10px rgba(6, 18, 36, 0.55); }
  .hero .subtitle { margin: 0; font-size: 1.2em;
    text-shadow: 0 2px 10px rgba(6, 18, 36, 0.55); }
  .appicon { display: block; width: 116px; height: 116px; margin: 0 auto; border-radius: 26px;
    box-shadow: 0 6px 22px rgba(6, 18, 36, 0.45); }
  @media (max-width: 600px) {
    .appicon { width: 92px; height: 92px; border-radius: 21px; }
    .hero h1 { font-size: 1.85em; }
    .hero .subtitle { font-size: 1.05em; }
  }
`;

// The screenshots run in one horizontally scrolling strip rather than a stacked column: they are
// portrait phone shots, and five of them down the page would push every word of the copy below
// the fold. The strip is what buys them their width: a shot is 300px in the text column and 230px
// on a phone — big enough to read the meteogram rather than just recognize one — where a row that
// had to fit them all would have to draw each at a third of that. Nothing says "scroll me" except
// a shot cut off by the edge, so the widths also leave one mid-frame: two and a good part of the
// third in the text column, one and half of the second on a phone.
//
// The negative margins cancel the wrap's 20px padding so the strip scrolls edge to edge, with the
// padding moved inside it to keep the first shot flush with the text above. It spans the wrap's
// border box and no more — a `100vw` full-bleed would overflow the body by the width of a desktop
// scrollbar.
//
// `scroll-snap-type: proximity`, not `mandatory`: the strip is a glance, not a carousel, and
// mandatory snapping fights a user who is flicking through it.
const SHOTS_CSS = `
  .shots { display: flex; gap: 16px; margin: 1.8em -20px; padding: 0 20px 10px;
    overflow-x: auto; scroll-snap-type: x proximity; }
  .shots figure { flex: 0 0 300px; margin: 0; scroll-snap-align: center; }
  .shots img { display: block; width: 100%; height: auto; border-radius: 14px;
    border: 1px solid #e2e6ea; box-shadow: 0 2px 10px rgba(6, 18, 36, 0.08); }
  .shots figcaption { margin-top: 0.7em; color: #666; font-size: 0.85em; line-height: 1.45; }
  @media (max-width: 600px) { .shots figure { flex: 0 0 230px; } }
`;

type PageOpts = { showUpdated?: boolean; subtitle?: string; css?: string };

// `subtitle` is what makes a page a landing page: it swaps the plain <h1> for the photo band, and
// brings in the styles for the screenshot strip below it. `css` appends a page's own rules to the
// same <style> block, which is what lets a page with more than prose in it (the stats dashboard)
// share this shell instead of growing a second one.
export const PAGE = (title: string, body: string, { showUpdated = true, subtitle, css }: PageOpts = {}) => `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>${title === BRAND ? BRAND : `${title} — ${BRAND}`}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; color: #1a1a1a; line-height: 1.55; }
  .wrap { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.15em; margin-top: 1.8em; }
  .updated { color: #666; font-size: 0.9em; }
  .cta { background: #f0f6fc; border: 1px solid #cfe2f5; border-radius: 8px; padding: 16px 20px; margin: 1.8em 0; }
  a { color: #0b62c4; }
  .appbtn { display: inline-block; background: #0b62c4; color: #fff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 0.6em 0 1.2em; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd; color: #666; font-size: 0.9em; }
${subtitle ? HERO_CSS + SHOTS_CSS : ""}${css ?? ""}</style>
</head>
<body>
${subtitle
  ? `<header class=hero>
  <div>
    <img class=appicon src="/img/icon-512.jpg" width=116 height=116 alt="">
    <h1>${title}</h1>
    <p class=subtitle>${subtitle}</p>
  </div>
</header>`
  : ""}
<div class=wrap>
${subtitle ? "" : `<h1>${title}</h1>`}
${showUpdated ? `<p class=updated>Last updated: ${LAST_UPDATED}</p>` : ""}
${body}
<footer>
  ${BRAND} is operated as a sole proprietorship by Lane Aasen.<br>
  <a href="/">Home</a> · <a href="/support">Support</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
</footer>
</div>
</body>
</html>`;

// The marketing copy is kept in step with the App Store listing's description — the two are read
// back to back by anyone deciding whether to install, so they should not tell different stories.
// The companion app is iOS-only and distributed through the App Store; the landing page links to
// it once the listing is live (drop an `<a class=appbtn href="...">` back in below).
//
// The page is marketing only: the SMS consent language, the opt-out wording and the safety
// disclaimer live on /support, /privacy and /terms, reached through the footer. If an A2P 10DLC
// campaign review asks for consent language on the public site, it goes back here.
const LANDING_BODY = `
<p>${BRAND} is a weather app designed specifically for satellite messengers. It was built for a
Denali ski expedition with one goal: to get you all the weather information you would have at
home, wherever you are. ${BRAND} uses a custom compression codec and decoder app to pack hundreds
of forecast data points into a single 160-character message.</p>

<div class=shots>
  <figure>
    <img src="/img/shot-meteogram-640.jpg" width=640 height=1391 loading=lazy
      alt="A seven-day meteogram: a temperature curve with weather icons along the top, and below it
      hourly temperature, precipitation, wind, cloud cover and pressure-level winds.">
    <figcaption>A week of weather, unpacked from one 160-character reply.</figcaption>
  </figure>
  <figure>
    <img src="/img/shot-detail-640.jpg" width=640 height=1391 loading=lazy
      alt="One hour selected in the meteogram, with a panel showing conditions, temperature, rain
      and snow totals, wind, sunrise, sunset and moon phase.">
    <figcaption>Tap any hour for its detail, down to the moon phase.</figcaption>
  </figure>
  <figure>
    <img src="/img/shot-wind-640.jpg" width=640 height=1391 loading=lazy
      alt="A Denali forecast showing freezing level, cloud cover split into high, mid and low, and
      winds at the 500, 600 and 700 hPa pressure levels.">
    <figcaption>Freezing level, cloud by height, and winds aloft.</figcaption>
  </figure>
  <figure>
    <img src="/img/shot-builder-640.jpg" width=640 height=1391 loading=lazy
      alt="The Builder tab, with location, priority, model and extra-variable choices above buttons
      to copy the message, send it by SMS, or fetch it over the internet.">
    <figcaption>Choose the location, model and variables, then send it whichever way you can.</figcaption>
  </figure>
  <figure>
    <img src="/img/shot-history-640.jpg" width=640 height=1391 loading=lazy
      alt="The Decoder tab's list of past forecasts, each row showing the time, model, coordinates
      and variables, with a Load button.">
    <figcaption>Every forecast you decode stays on your phone to compare against.</figcaption>
  </figure>
</div>

<h2>How it works</h2>
<ol>
  <li>Build a forecast request in the app. Choose the location, model, and variables that you
  care about.</li>
  <li>Send it from your satellite messenger, as a text message, or over the internet.</li>
  <li>Paste the reply back into the app's decoder to see a detailed meteogram.</li>
</ol>

<h2>Forecast details</h2>
<ul>
  <li>Support for any satellite messenger that works over SMS. Tested with Garmin inReach and
  ZOLEO. Also works over the internet if you are in service.</li>
  <li>Temperature, snow, rain, wind, and cloud cover included by default.</li>
  <li>Optional variables such as pressure-level winds, cloud cover by height, and freezing
  level.</li>
  <li>Over 30 high-resolution regional models from American, Canadian, and European forecast
  centers. Automatically use the highest resolution model for your location or pull multiple
  models to compare.</li>
  <li>Hourly detail or extended range up to 13 days.</li>
  <li>Past forecasts are saved on your device so that you can easily compare multiple forecasts
  and see trends without requesting a new forecast.</li>
</ul>

<h2>Open source</h2>
<p>${BRAND} is open source under the Apache License 2.0 and the source code is hosted at
<a href="${REPO_URL}">github.com/aaasen/goingblue</a>. Feedback is welcome! If you have suggestions or need weather data that is not included in the app,
file an issue on GitHub or email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

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
<p>Any satellite messenger that can send and receive SMS. We have tested Garmin inReach and ZOLEO.
The <strong>Setup</strong> section in the app walks through each one.</p>

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

<h2>How do I delete my account?</h2>
<p>Open <strong>Settings</strong> in the app and tap <strong>Delete account</strong>. That erases
the account from our servers immediately and permanently, and clears the forecasts saved on your
device. The account is an anonymous token with no name, email address, or phone number attached to
it. See our <a href="/privacy">Privacy Policy</a> for what we hold and for how long.</p>

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

const PRIVACY_BODY = `
<p>This Privacy Policy describes how Lane Aasen ("we," "us"), operating ${BRAND} as a sole
proprietorship, handles information when you request weather forecasts. It covers both the
SMS forecast service and the ${BRAND} mobile app (together, the "Service").</p>

<h2>The short version</h2>
<p>The only information you send us is <strong>the location you want a forecast for</strong>,
along with the forecast options you picked. We ask for nothing else: no name, no email address,
no account password. There is no analytics, advertising, or tracking of any kind in the app,
and we do not track you across apps or websites.</p>

<h2>The app</h2>
<p>The ${BRAND} app builds forecast requests and decodes the replies. It is the app's job to do
as much as possible on your device, and it does:</p>
<ul>
  <li><strong>Location</strong> — if you grant location permission, the app reads your device's
  current position to fill in the coordinates for a request. Granting permission is optional; you
  can instead pick any location on the map. Either way, the coordinates you choose are sent to us
  (and on to our weather data provider) for the sole purpose of retrieving that forecast. The app
  does not record where you have been, and it does not read your location in the background.</li>
  <li><strong>Stored on your device only</strong> — your account token, the forecasts you have
  decoded, and your unit and time-format preferences are kept on the device and are not uploaded
  to us. Deleting the app deletes them.</li>
  <li><strong>Decoding</strong> — forecast replies are decoded entirely on your device. A forecast
  you paste into the app is not sent anywhere.</li>
</ul>

<h2>Your account</h2>
<p>The app creates an account for you automatically. That account is a randomly generated token
and nothing else — it is not tied to your name, email address, phone number, or device
identifiers, and we use it only to count requests for usage limits. You can erase it at any time
from <strong>Settings &rarr; Delete account</strong> in the app, which deletes it from our servers
along with every link between it and any request it made. That deletion is immediate and
permanent.</p>

<h2>SMS text messaging</h2>
<p>${BRAND} sends SMS/text-message forecasts only in reply to a request you send first.
We never send marketing, promotional, recurring, or other unsolicited text messages.
Message frequency varies and is controlled entirely by you — it depends on how often you
request a forecast. Message and data rates may apply. Reply <strong>STOP</strong> at any
time to opt out, or <strong>HELP</strong> for help. <strong>Your mobile information and SMS
opt-in consent are never sold or shared with third parties or affiliates for any purpose,
including marketing.</strong></p>

<h2>Information we collect</h2>
<p>The Service only processes information that you send us when you request a forecast:</p>
<ul>
  <li><strong>Location coordinates</strong> — the latitude and longitude you include in a
  request, used to retrieve the forecast for that location.</li>
  <li><strong>Request parameters</strong> — the forecast options you specify (e.g. resolution,
  weather variables, protocol version).</li>
  <li><strong>Your account token</strong> — the anonymous token described above, when the
  request carries one, used to count requests against usage limits.</li>
  <li><strong>Your messaging address or phone number</strong> — <em>only</em> when you request a
  forecast by text message, in which case the satellite-messenger or mobile address that sent the
  request is used solely to deliver the forecast back to you. Requests the app sends over the
  internet carry no phone number or messaging address.</li>
</ul>

<h2>How we use it</h2>
<p>We use this information for one purpose: to generate the weather forecast you requested
and send it back to you. We do not build advertising or marketing profiles, and we do not
use your information for any purpose unrelated to fulfilling your forecast requests.</p>

<h2>How we share it</h2>
<p><strong>We do not sell, rent, or share your phone number, messaging address, or any
mobile information with third parties for marketing or promotional purposes.</strong>
SMS opt-in consent and phone numbers are never shared with third parties or affiliates
for their own marketing. We share information only as strictly necessary to operate the
Service:</p>
<ul>
  <li><strong>Weather data provider</strong> — request coordinates are sent to our forecast
  data source (Open-Meteo) to retrieve forecast data. No phone number or messaging address
  is sent to the weather provider.</li>
  <li><strong>Message delivery</strong> — messages are delivered through the satellite
  messenger and carrier networks you use to communicate with the Service.</li>
  <li><strong>Legal</strong> — where required by law or to protect the rights, safety, or
  property of users or the public.</li>
</ul>

<h2>Data retention</h2>
<p>We retain request and message data only as long as needed to operate and troubleshoot
the Service. Operational logs are kept for a limited period and then deleted. Deleting your
account removes the account record and unlinks it from any record of the requests it made.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>Location permission</strong> — you can decline it, or revoke it later in your
  device's settings, and still use the app by choosing locations on the map.</li>
  <li><strong>Delete your account</strong> — <strong>Settings &rarr; Delete account</strong> in
  the app erases it from our servers.</li>
  <li><strong>Delete the app</strong> — this removes everything stored on your device, including
  your saved forecasts. Delete your account first if you also want it erased from our
  servers.</li>
  <li><strong>Stop text messages</strong> — because the Service only replies to messages you
  send, the most direct way to stop receiving messages is to stop sending requests. You may also
  reply <strong>STOP</strong> at any time to opt out, or <strong>HELP</strong> for assistance.
  See our <a href="/terms">Terms &amp; Conditions</a> for details.</li>
</ul>

<h2>Children</h2>
<p>The Service is not directed to children under 13, and we do not knowingly collect personal
information from them.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. The "Last updated" date above reflects the
most recent revision.</p>

<h2>Contact</h2>
<p>For privacy questions, contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

const TERMS_BODY = `
<p>These Terms &amp; Conditions govern your use of ${BRAND} (the "Service") — both the SMS
forecast service and the ${BRAND} mobile app — operated as a sole proprietorship by Lane Aasen.
By using the app or texting the Service to request a forecast, you agree to these terms.</p>

<h2>The Service</h2>
<p>The Service provides weather forecasts on request, designed for use with satellite messenger
devices (such as Garmin inReach) and mobile phones. You send a location and forecast options; the
Service replies with a forecast. Requests can be sent as a text message or, where you have an
internet connection, directly from the app. Forecast responses may be sent in a compact encoded
format that the app decodes and displays, allowing a full forecast to fit within the size limits
of satellite messaging.</p>

<h2>Accounts</h2>
<p>The app creates an anonymous account token for you, which identifies your requests for the
purpose of usage limits. Keep it to yourself: anyone holding your token can make requests counted
against you. You may delete your account at any time from within the app. We may limit request
volume, or suspend or terminate access, where necessary to keep the Service running for
everyone.</p>

<h2>Acceptable use</h2>
<p>Do not use the Service to break the law, and do not attempt to disrupt, overload, or gain
unauthorized access to it or to any system it depends on.</p>

<h2>Consent and message frequency</h2>
<p>All messages from the Service are sent in direct response to a request you initiate.
The Service does not send unsolicited, marketing, or promotional messages. Message frequency
depends entirely on how often you choose to request forecasts.</p>

<h2>Rates</h2>
<p>Message and data rates may apply, including any charges from your satellite messenger
service or mobile carrier. You are responsible for those charges.</p>

<h2>Opt-out and help</h2>
<p>Reply <strong>STOP</strong> at any time to opt out and stop receiving messages. Reply
<strong>HELP</strong> for assistance, or contact
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

<h2>No warranty — forecasts are informational</h2>
<p>Weather forecasts are provided on an "as is" and "as available" basis for informational
purposes only. Forecasts are inherently uncertain and may be inaccurate, delayed, or
unavailable. <strong>Do not rely on the Service as your sole source of weather information
for decisions affecting safety, including in remote or backcountry settings.</strong> Always
use appropriate judgment and additional sources for safety-critical decisions.</p>

<h2>Limitation of liability</h2>
<p>To the fullest extent permitted by law, Lane Aasen shall not be liable for any damages
arising from your use of, or inability to use, the Service, including any reliance on
forecast information.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms from time to time. The "Last updated" date above reflects the
most recent revision. Continued use of the Service constitutes acceptance of the current terms.</p>

<h2>Contact</h2>
<p>For questions about these terms, contact
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

// vCard 3.0 carrying the SMS number. Served rather than bundled in the app so the app needs no
// Contacts permission of its own — the user taps through the system's own "add contact" flow —
// and so the card can be corrected without shipping an app update. Earthmate reads the phone's
// contacts, so adding this is what saves the user from typing the number by hand in the field.
// CRLF line endings and the trailing newline are required by RFC 6350; X-ABShowAs is an Apple
// extension that renders the card as a company rather than a person.
const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  `FN:${BRAND}`,
  "N:;;;;",
  `ORG:${BRAND}`,
  "X-ABShowAs:COMPANY",
  `TEL;TYPE=CELL:${FORECAST_NUMBER}`,
  "URL:https://going.blue",
  "END:VCARD",
  "",
].join("\r\n");

export function landing(c: Context) {
  return c.html(
    PAGE(BRAND, LANDING_BODY, {
      showUpdated: false,
      subtitle: "Weather forecasts over satellite",
    }),
  );
}

// Served inline (no Content-Disposition: attachment) so iOS offers to add the contact rather
// than filing it away in Files.
export function contactCard(c: Context) {
  c.header("Content-Type", "text/vcard; charset=utf-8");
  return c.body(VCARD);
}

// No "Last updated" stamp: that belongs on the legal documents, where the revision date carries
// meaning. On a support page it just looks stale the moment an answer stops changing.
export function support(c: Context) {
  return c.html(PAGE("Support", SUPPORT_BODY, { showUpdated: false }));
}

export function privacy(c: Context) {
  return c.html(PAGE("Privacy Policy", PRIVACY_BODY));
}

export function terms(c: Context) {
  return c.html(PAGE("Terms & Conditions", TERMS_BODY));
}
