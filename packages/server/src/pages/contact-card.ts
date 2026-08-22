import type { Context } from "hono";
import { BRAND, FORECAST_NUMBER } from "../constants.js";

// vCard 3.0 carrying the SMS number. Served rather than bundled in the app so the app needs no
// Contacts permission of its own — the user taps through the system's own "add contact" flow —
// and so the card can be corrected without shipping an app update. Earthmate reads the phone's
// contacts, so adding this is what saves the user from typing the number by hand in the field.
// CRLF line endings and the trailing newline are required by RFC 6350; X-ABShowAs is an Apple
// extension that renders the card as a company rather than a person. N carries the brand split
// into given and family names anyway, because contact lists that sort or search by first and last
// name — Earthmate's among them — have nothing to show for a card whose only name is the org.
const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  `FN:${BRAND}`,
  "N:Blue;Going;;;",
  `ORG:${BRAND}`,
  "X-ABShowAs:COMPANY",
  `TEL;TYPE=CELL:${FORECAST_NUMBER}`,
  "URL:https://going.blue",
  "END:VCARD",
  "",
].join("\r\n");

// Served inline (no Content-Disposition: attachment) so iOS offers to add the contact rather
// than filing it away in Files.
export function contactCard(c: Context) {
  c.header("Content-Type", "text/vcard; charset=utf-8");
  return c.body(VCARD);
}
