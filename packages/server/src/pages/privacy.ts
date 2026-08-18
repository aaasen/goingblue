import type { Context } from "hono";
import { BRAND, CONTACT_EMAIL } from "../constants.js";
import { PAGE } from "./shell.js";

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
and nothing else — it is not tied to your name, email address, or device identifiers, and we use
it only to count requests for usage limits. You can erase it at any time from
<strong>Settings &rarr; Delete account</strong> in the app, which deletes the token from our
servers. That deletion is immediate and permanent, and once it is done nothing we hold can be
traced back to you.</p>
<p>Our record of past requests survives that deletion, with the token removed and replaced by a
meaningless number. We keep it so that counts of how many people used the Service on a past day
stay accurate — erasing those rows would rewrite our own history — and because that number
identifies nobody: it is not derived from your token, and there is nothing left to match it
against.</p>

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
  request is used to deliver the forecast back to you. Requests the app sends over the internet
  carry no phone number or messaging address.</li>
</ul>
<p>Of those, two things are written down after your forecast has been sent:</p>
<ul>
  <li><strong>A record of the request</strong> — the time, the size of the reply, the protocol
  version, the kind of device it named (an iPhone, a satellite messenger, and so on), your
  account token if the request carried one, and a one-way scrambled form of your number if it
  arrived by text message. We keep the scrambled form, and not the number itself, so that we can
  count how many different people use the Service and notice a single account being used from
  several handsets. It cannot be turned back into your number, and we cannot contact you with
  it.</li>
  <li><strong>An approximate location</strong> — the coordinates you asked about, rounded to
  about a kilometre, stored with the date and the forecast options you chose. We use it to see
  where the Service is being used and to build realistic test cases for the forecast encoding.
  It is kept <em>separately</em>, with no link to your account, your number, or the record above,
  and with no time of day attached — so it cannot be matched back to you or assembled into a
  history of where you have been.</li>
</ul>

<h2>How we use it</h2>
<p>First and foremost, to generate the weather forecast you requested and send it back to you.
Beyond that we use the two records described above to run the Service itself: to count usage
against limits and to see how many people the Service has, and to improve how much forecast we
can fit into a single message. We do not build advertising or marketing profiles, we do not
profile you individually, and we do not use your information for any purpose unrelated to
operating and improving the Service.</p>

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
<p>The two records described above — the request record and the approximate location — are kept
for as long as we operate the Service, because both are cumulative measures: usage counts and
encoding test cases lose their meaning if the older half is thrown away. Neither contains your
name, your number, or a precise position, and the two cannot be matched to each other.
Operational logs, which do briefly contain the full contents of a message, are kept for a limited
period and then deleted. Deleting your account removes the account token; the request record
stays, with nothing in it that points to you.</p>

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

export function privacy(c: Context) {
  return c.html(PAGE("Privacy Policy", PRIVACY_BODY));
}
