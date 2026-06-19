import type { Context } from "hono";

const BRAND = "Going Blue";
const LAST_UPDATED = "June 16, 2026";
const CONTACT_EMAIL = "laneaasen@gmail.com";

const PAGE = (title: string, body: string, showUpdated = true) => `<!doctype html>
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
  .tagline { color: #444; font-size: 1.1em; }
  .cta { background: #f0f6fc; border: 1px solid #cfe2f5; border-radius: 8px; padding: 16px 20px; margin: 1.8em 0; }
  a { color: #0b62c4; }
  .appbtn { display: inline-block; background: #0b62c4; color: #fff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 0.6em 0 1.2em; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd; color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<h1>${title}</h1>
${showUpdated ? `<p class=updated>Last updated: ${LAST_UPDATED}</p>` : ""}
${body}
<footer>
  ${BRAND} is operated as a sole proprietorship by Lane Aasen.
  Questions? Contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.<br>
  <a href="/">Home</a> · <a href="/app">App</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
</footer>
</body>
</html>`;

const LANDING_BODY = `
<p class=tagline>On-request weather forecasts delivered by text message — built for
satellite messengers like the Garmin inReach, and for mobile phones.</p>

<p>${BRAND} gives you better forecasts than the default satellite-messenger weather service.
You send a short text containing a location and the forecast options you want; ${BRAND}
replies with a compact, encoded forecast that the companion app decodes into a full
multi-day forecast — small enough to fit within satellite messaging size limits.</p>

<p><a class=appbtn href="/app">Open the ${BRAND} app →</a></p>

<h2>How it works</h2>
<ol>
  <li>Send a text message to ${BRAND} with a location (latitude and longitude) and your
  forecast options, from your satellite messenger or mobile phone.</li>
  <li>${BRAND} fetches the forecast for that location and replies to you with a single
  message.</li>
  <li>Open the <a href="/app">companion app</a> to decode and view the full forecast.</li>
</ol>

<div class=cta>
  <h2 style="margin-top:0">Opt-in &amp; consent</h2>
  <p>${BRAND} only ever replies to a message you send first. <strong>When you text ${BRAND}
  to request a forecast, you are opting in to receive a reply message with that forecast.</strong>
  We send no marketing, promotional, or recurring messages — every message we send is a
  one-to-one reply to a request you just made. Message frequency depends entirely on how often
  you choose to request a forecast.</p>
  <p>Message and data rates may apply. Reply <strong>STOP</strong> at any time to opt out, or
  <strong>HELP</strong> for assistance. We never sell or share your phone number or opt-in
  consent with third parties for their own marketing.</p>
</div>

<h2>Important: forecasts are informational</h2>
<p>Forecasts are provided for informational purposes only and may be inaccurate, delayed, or
unavailable. Do not rely on ${BRAND} as your sole source of weather information for decisions
affecting safety, including in remote or backcountry settings.</p>

<p>See our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms &amp; Conditions</a>
for full details. Questions? Contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

const PRIVACY_BODY = `
<p>This Privacy Policy describes how Lane Aasen ("we," "us"), operating the
${BRAND} SMS forecast service (the "Service") as a sole proprietorship,
handles information when you request weather forecasts by text message.</p>

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
  <li><strong>Your messaging address or phone number</strong> — the satellite-messenger
  or mobile address that sends the request, used solely to deliver the forecast back to you.</li>
  <li><strong>Location coordinates</strong> — the latitude and longitude you include in a
  request, used to retrieve the forecast for that location.</li>
  <li><strong>Request parameters and message content</strong> — the forecast options you
  specify (e.g. resolution, weather variables, protocol version).</li>
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
the Service. Operational logs are kept for a limited period and then deleted.</p>

<h2>Opting out</h2>
<p>Because the Service only replies to messages you send, the most direct way to stop
receiving messages is to stop sending requests. You may also reply <strong>STOP</strong>
at any time to opt out, or reply <strong>HELP</strong> for assistance. See our
<a href="/terms">Terms &amp; Conditions</a> for details.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. The "Last updated" date above reflects the
most recent revision.</p>

<h2>Contact</h2>
<p>For privacy questions, contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

const TERMS_BODY = `
<p>These Terms &amp; Conditions govern your use of the ${BRAND} SMS forecast
service (the "Service"), operated as a sole proprietorship by Lane Aasen. By texting the
Service to request a forecast, you agree to these terms.</p>

<h2>The Service</h2>
<p>The Service provides weather forecasts on request via text message, designed for use with
satellite messenger devices (such as Garmin inReach) and mobile phones. You send a message
containing a location and forecast options; the Service replies with a forecast. Forecast
responses may be sent in a compact encoded format that is decoded and displayed by the
companion app, allowing a full forecast to fit within the size limits of satellite messaging.</p>

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

export function landing(c: Context) {
  return c.html(PAGE(BRAND, LANDING_BODY, false));
}

export function privacy(c: Context) {
  return c.html(PAGE("Privacy Policy", PRIVACY_BODY));
}

export function terms(c: Context) {
  return c.html(PAGE("Terms & Conditions", TERMS_BODY));
}
