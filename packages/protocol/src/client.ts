// User agent is used as a cheap crawler filter.
// Requests to POST /account are rejected if the user agent doesn't match.

const APP_NAME = "GoingBlue";

export function appUserAgent(version: string): string {
  return `${APP_NAME}/${version} (setup)`;
}

// Whether a caller uses the app user agent.
export function isAppUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === "string" && ua.startsWith(`${APP_NAME}/`);
}
