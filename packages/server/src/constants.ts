// The facts about the service that more than one public page has to state the same way: the name
// it is called by, the address to write to, the number to text, and where the app and the source
// live. They are here rather than in the page shell because pages are the things that read them —
// the shell is only one more reader.
export const BRAND = "Going Blue";
export const LAST_UPDATED = "August 17, 2026";
export const CONTACT_EMAIL = "help@going.blue";
export const FORECAST_NUMBER = "+14254345858";
export const REPO_URL = "https://github.com/aaasen/goingblue";

// No country segment and no name slug: apps.apple.com redirects an ID-only link to the visitor's
// own storefront, and the slug is regenerated from the app's name, so a rename would rot a link
// that carried it. The numeric ID is the only part of an App Store URL that never changes.
export const APP_STORE_URL = "https://apps.apple.com/app/id6798411927";
