import type { Context } from "hono";
import { BRAND } from "../constants.js";
import { PAGE } from "./shell.js";

// The page sent to anyone who wants the Android app while it is in closed testing. Google gates a
// production listing behind a testing period, so until that clears there is no Play Store link to
// hand out, only these three steps. Meant to be replaced by the Play listing once the app is live.
export const ANDROID_GROUP_EMAIL = "going-blue-android@googlegroups.com";
export const ANDROID_GROUP_URL = "https://groups.google.com/g/going-blue-android";
export const ANDROID_TESTING_URL = "https://play.google.com/apps/testing/com.laneaasen.weather";
export const ANDROID_PLAY_URL = "https://play.google.com/store/apps/details?id=com.laneaasen.weather";
export const FEEDBACK_EMAIL = "android@going.blue";

const ANDROID_BODY = `
<p>${BRAND} supports Android but it is not currently available on the Play Store. Google requires
apps to go through 2 weeks of closed testing with at least 12 testers before they can be listed on
the Play Store. If you would like to test ${BRAND} on Android, follow these steps:</p>
<ol>
  <li>Join the Google Group <a href="${ANDROID_GROUP_URL}">${ANDROID_GROUP_EMAIL}</a>.</li>
  <li>Join the <a href="${ANDROID_TESTING_URL}">closed test</a>.</li>
  <li>Install the app from <a href="${ANDROID_PLAY_URL}">Google Play</a>. If you see "We're sorry, the requested URL was not found on this server", check back again in a few minutes.</li>
  <li>Get a forecast in the app. Google considers engagement when applying for Google Play access so try to pull a forecast weekly.</li>
</ol>
<p>Thank you for your help getting ${BRAND} on the Play Store! If you find any bugs or have any
feedback, please email <a href="mailto:${FEEDBACK_EMAIL}">${FEEDBACK_EMAIL}</a>.</p>
`;

export function android(c: Context) {
  return c.html(PAGE("Android Support", ANDROID_BODY, { showUpdated: false }));
}
