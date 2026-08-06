import type { Context } from "hono";

const BRAND = "Going Blue";
const LAST_UPDATED = "August 5, 2026";
const CONTACT_EMAIL = "help@going.blue";
const FORECAST_NUMBER = "+14254345858";

// The landing page is set on a photo of Sultana. It is a wide panorama, so it is anchored to
// the bottom edge: cover-cropping a 2.6:1 image into a portrait phone viewport keeps the summit
// and throws away only sky. Served at two widths from /img (assets.ts) — the small one is plenty
// for a phone and a quarter of the bytes.
const PHOTO_CSS = `
  body.photo::before {
    content: ""; position: fixed; inset: 0; z-index: -1;
    background: linear-gradient(rgba(12, 34, 64, 0.2), rgba(12, 34, 64, 0.42)),
      url(/img/sultana-1200.jpg) center bottom / cover no-repeat #0c2240;
  }
  @media (min-width: 801px) {
    body.photo::before {
      background-image: linear-gradient(rgba(12, 34, 64, 0.2), rgba(12, 34, 64, 0.42)),
        url(/img/sultana-2400.jpg);
    }
  }
  body.photo .card {
    background: rgba(255, 255, 255, 0.94);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border-radius: 14px; padding: 26px 30px 22px;
    box-shadow: 0 10px 40px rgba(8, 24, 48, 0.3);
  }
`;

// The app icon over the title, as a masthead. The icon file is square and unrounded (iOS applies
// the mask itself), so the corner radius is ours to draw: 22.4% of the width is Apple's own
// superellipse proportion, which is what makes it read as an app icon rather than a photo.
const MASTHEAD_CSS = `
  .masthead { text-align: center; margin-bottom: 2.2em; }
  .masthead h1 { margin: 0.55em 0 0.15em; font-size: 2em; letter-spacing: -0.02em; }
  .appicon { display: block; width: 116px; height: 116px; margin: 0 auto; border-radius: 26px;
    box-shadow: 0 5px 18px rgba(8, 24, 48, 0.24); }
  .subtitle { margin: 0; color: #4a5568; font-size: 1.15em; }
`;

type PageOpts = { showUpdated?: boolean; photo?: boolean; subtitle?: string };

const PAGE = (title: string, body: string, { showUpdated = true, photo = false, subtitle }: PageOpts = {}) => `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>${title === BRAND ? BRAND : `${title} — ${BRAND}`}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.15em; margin-top: 1.8em; }
  .updated { color: #666; font-size: 0.9em; }
  .cta { background: #f0f6fc; border: 1px solid #cfe2f5; border-radius: 8px; padding: 16px 20px; margin: 1.8em 0; }
  a { color: #0b62c4; }
  .appbtn { display: inline-block; background: #0b62c4; color: #fff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 0.6em 0 1.2em; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd; color: #666; font-size: 0.9em; }
${subtitle ? MASTHEAD_CSS : ""}${photo ? PHOTO_CSS : ""}</style>
</head>
<body${photo ? " class=photo" : ""}>
<div class=card>
${subtitle
  ? `<div class=masthead>
  <img class=appicon src="/img/icon-512.jpg" width=116 height=116 alt="">
  <h1>${title}</h1>
  <p class=subtitle>${subtitle}</p>
</div>`
  : `<h1>${title}</h1>`}
${showUpdated ? `<p class=updated>Last updated: ${LAST_UPDATED}</p>` : ""}
${body}
<footer>
  ${BRAND} is operated as a sole proprietorship by Lane Aasen.<br>
  <a href="/">Home</a> · <a href="/support">Support</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
</footer>
</div>
</body>
</html>`;

// The companion app is iOS-only and distributed through the App Store; the landing page links to
// it once the listing is live (drop an `<a class=appbtn href="...">` back in below).
const LANDING_BODY = `
<p>On-request weather forecasts delivered by text message — built for
satellite messengers like the Garmin inReach, and for mobile phones.</p>

<p>${BRAND} gives you better forecasts than the default satellite-messenger weather service.
You send a short text containing a location and the forecast options you want; ${BRAND}
replies with a compact, encoded forecast that the companion app decodes into a full
multi-day forecast — small enough to fit within satellite messaging size limits.</p>

<div class=cta>
  <h2 style="margin-top:0">Get weather forecasts by text</h2>
  <p><strong>Text START to (425) 434-5858 to get weather forecasts from ${BRAND}.</strong>
  One message is sent in response to each forecast request. Message and data rates may apply.
  Reply HELP for help, STOP to opt out.
  Terms: <a href="https://going.blue/terms">https://going.blue/terms</a>
  Privacy: <a href="https://going.blue/privacy">https://going.blue/privacy</a></p>
</div>

<h2>How it works</h2>
<ol>
  <li>Text <strong>START</strong> to (425) 434-5858 to opt in; ${BRAND} replies with a welcome
  message.</li>
  <li>Send a text message to ${BRAND} with a location (latitude and longitude) and your
  forecast options, from your satellite messenger or mobile phone.</li>
  <li>${BRAND} fetches the forecast for that location and replies to you with a single
  message.</li>
  <li>Open the ${BRAND} companion app to decode and view the full forecast.</li>
</ol>

<p>${BRAND} only ever replies to a message you send first and sends no marketing, promotional,
recurring, or unsolicited messages. Message frequency is controlled entirely by you. We never
sell or share your phone number or opt-in consent with third parties.</p>

<h2>Important: forecasts are informational</h2>
<p>Forecasts are provided for informational purposes only and may be inaccurate, delayed, or
unavailable. Do not rely on ${BRAND} as your sole source of weather information for decisions
affecting safety, including in remote or backcountry settings.</p>

<p>See our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms &amp; Conditions</a>
for full details. Questions? Contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
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
  <li>Send the request — <strong>Get Forecast</strong> over the internet, <strong>Send SMS</strong>
  from your phone, or <strong>Copy Message</strong> to paste into your messenger.</li>
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
      photo: true,
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
