import { afterEach, describe, expect, it } from "vitest";
import { hasPepper, hashPhone } from "../src/phone.js";

const NUMBER = "+14155550123";

afterEach(() => {
  delete process.env["PHONE_PEPPER"];
});

describe("hashPhone", () => {
  it("is stable for the same number, so distinct-sender counts hold over time", () => {
    process.env["PHONE_PEPPER"] = "pepper";
    expect(hashPhone(NUMBER)).toEqual(hashPhone(NUMBER));
    expect(hashPhone(NUMBER)).not.toEqual(hashPhone("+14155550124"));
  });

  it("does not contain the number it came from", () => {
    process.env["PHONE_PEPPER"] = "pepper";
    const digest = hashPhone(NUMBER)!;
    expect(digest).toHaveLength(32);
    expect(digest.toString("hex")).not.toContain("4155550123");
    expect(digest.toString("latin1")).not.toContain("4155550123");
  });

  // The pepper is the whole defence: without it the ~10^10 E.164 numbers are enumerable, so two
  // deployments with different peppers must not produce matchable digests.
  it("is keyed by the pepper", () => {
    process.env["PHONE_PEPPER"] = "one";
    const first = hashPhone(NUMBER);
    process.env["PHONE_PEPPER"] = "two";
    expect(hashPhone(NUMBER)).not.toEqual(first);
  });

  // Failing closed, not open: an unkeyed digest would look just as opaque in the table while
  // being trivially reversible, so no pepper means no sender recorded at all.
  it("records nothing when no pepper is configured", () => {
    expect(hasPepper()).toBe(false);
    expect(hashPhone(NUMBER)).toBeNull();
    process.env["PHONE_PEPPER"] = "pepper";
    expect(hasPepper()).toBe(true);
    expect(hashPhone(NUMBER)).not.toBeNull();
  });

  it("ignores anything that is not an E.164 number", () => {
    process.env["PHONE_PEPPER"] = "pepper";
    expect(hashPhone(null)).toBeNull();
    expect(hashPhone(undefined)).toBeNull();
    expect(hashPhone("")).toBeNull();               // Twilio's From on a form with no sender
    expect(hashPhone("4155550123")).toBeNull();     // no country code
    expect(hashPhone("+0155550123")).toBeNull();    // country code can't start with 0
    expect(hashPhone("+14155")).toBeNull();         // shorter than any real E.164 number
    expect(hashPhone("+1415555012345678")).toBeNull(); // too long
    expect(hashPhone("+1 (415) 555-0123")).toBeNull(); // not normalized
  });
});
