import type { Context } from "hono";
import { BRAND, CONTACT_EMAIL } from "../constants.js";
import { PAGE } from "./shell.js";

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

<h2>Data sources</h2>
<p>Weather forecasts are derived from data provided by <a href="https://open-meteo.com">Open-Meteo</a>.
Maps are built from data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
contributors (via <a href="https://protomaps.com">Protomaps</a>), the
<a href="https://overturemaps.org">Overture Maps Foundation</a>,
<a href="https://mapterhorn.com">Mapterhorn</a> (Copernicus DEM), the
<a href="https://land.copernicus.eu/en/products/global-dynamic-land-cover">Copernicus Global Land
Service</a>, and <a href="https://www.naturalearthdata.com">Natural Earth</a>.</p>

<h2>Trademarks</h2>
<p>Apple and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries.
Garmin, inReach, Earthmate, and Messenger are trademarks of Garmin Ltd. or its subsidiaries.
ZOLEO is a trademark of Zoleo Inc. ${BRAND} is not affiliated with, endorsed by, or sponsored by
these companies; their names are used only to describe the devices and services the Service works
with.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms from time to time. The "Last updated" date above reflects the
most recent revision. Continued use of the Service constitutes acceptance of the current terms.</p>

<h2>Contact</h2>
<p>For questions about these terms, contact
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

export function terms(c: Context) {
  return c.html(PAGE("Terms & Conditions", TERMS_BODY));
}
