import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReplyPage } from "../src/garmin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "fixtures/garmin_reply_page.html"), "utf8");

describe("parseReplyPage", () => {
  it("extracts Guid and MessageId from real page HTML", () => {
    const result = parseReplyPage(fixture);
    expect(result).not.toBeNull();
    expect(result!.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(result!.messageId).toMatch(/^\d+$/);
  });

  it("returns null when Guid is missing", () => {
    expect(parseReplyPage("<html>no fields here</html>")).toBeNull();
  });

  it("returns null when MessageId is missing", () => {
    const html = `<input id="Guid" name="Guid" type="hidden" value="08deb6c3-e65e-d8e2-0022-487bd4040000" />`;
    expect(parseReplyPage(html)).toBeNull();
  });
});
