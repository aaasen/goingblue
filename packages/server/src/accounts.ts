import { randomBytes } from "node:crypto";
import { generateToken } from "@weather/protocol";
import { getPool, query } from "./db.js";

// CSPRNG for token minting, supplied to the shared generator (which is platform-neutral and
// takes its randomness as a parameter).
const rng = (n: number) => Uint8Array.from(randomBytes(n));

// Mint and persist a new account, returning its token. The token only identifies the user for
// usage limits; messaging opt-in is consumer-initiated (the user opts in by texting a forecast
// request), so account creation records no consent. The token is the primary key, so a collision
// surfaces as a unique-violation; we retry (astronomically unlikely at 80 bits, but the loop
// keeps minting correct).
export async function createAccount(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken(rng);
    try {
      await query("insert into accounts (token) values ($1)", [token]);
      return token;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") continue; // unique_violation
      throw e;
    }
  }
  throw new Error("failed to mint a unique token after several attempts");
}

export async function accountExists(token: string): Promise<boolean> {
  const r = await query("select 1 from accounts where token = $1", [token]);
  return (r.rowCount ?? 0) > 0;
}

// Erase an account. The token is the only thing we store about a user, so dropping the row is a
// complete deletion. The `requests` rows survive with a null token: they hold no location and no
// message content — only a timestamp, a character count and a protocol version — and the
// per-version counts are the sunset metric for frozen codec containers (VERSIONING.md). Nulling
// the column severs every link back to the user while leaving that metric intact. Both statements
// run in one transaction so a failure can't leave requests pointing at a deleted account (the
// foreign key would reject that anyway) or orphan the rows from an account that still exists.
//
// Returns false when the token names no account, so a repeat delete reports honestly instead of
// claiming a fresh success.
export async function deleteAccount(token: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("update requests set token = null where token = $1", [token]);
    const r = await client.query("delete from accounts where token = $1", [token]);
    await client.query("commit");
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Record one forecast request. A token is stored only when it references a real account
// (the column has a foreign key); anything else — anonymous or an unregistered token — is
// recorded with a null token so the row still counts toward overall volume. Phase 1 is
// observe-only; quotas will later read these rows.
export async function recordRequest(token: string | null, chars: number, version: number | null): Promise<void> {
  const known = token && (await accountExists(token)) ? token : null;
  await query("insert into requests (token, chars, version) values ($1, $2, $3)", [known, chars, version]);
}
