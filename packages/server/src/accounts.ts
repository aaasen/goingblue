import { randomBytes } from "node:crypto";
import { generateToken } from "@weather/protocol";
import { DAY_TZ, getPool, query } from "./db.js";
import type { RequestShape } from "./dispatch.js";
import { hashPhone } from "./phone.js";

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

// Erase an account. The token is the only thing we store that identifies a user, so dropping the
// row is a complete deletion of the link between them and us.
//
// The `requests` rows survive with a null token. They keep two things that outlive the account:
// `account_id`, an opaque number, and `phone_hash`, an unkeyed-lookup HMAC. Neither can be turned
// back into a person — the token is gone, and the hash is only matchable by someone who already
// knows the number — but keeping them is what makes the usage record stay true: nulling
// everything would retroactively erase this user from every past day's count, so the dashboard
// would report fewer people using the service last March than actually did. The per-version
// counts are the sunset metric for frozen codec containers (VERSIONING.md) and need the rows for
// the same reason.
//
// Locations are not a consideration here: they were never written to this table (see db.ts).
//
// Both statements run in one transaction so a failure can't leave requests pointing at a deleted
// account (the foreign key would reject that anyway) or orphan the rows from an account that
// still exists.
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

// One inbound message, as recorded. `phone` is the raw sending address and is hashed on the way
// into the database — it is never stored, and never leaves this function.
export interface RequestRecord {
  token: string | null;
  phone: string | null;
  chars: number | null;
  version: number | null;
  // 'ok' for a served forecast, a DispatchResult failure kind, or 'help' for the messages that
  // are answered without a forecast. Old rows may also carry 'probe' (removed field probes).
  outcome: string;
  // The `d:` device code the request named, or null when it named none (dispatch.ts,
  // extractDevice).
  device: string | null;
  shape: RequestShape | null;
}

// Record one inbound message, as two rows in two tables that cannot be joined to each other:
// who asked (`requests`) and what was asked for (`request_shapes`). See the header comment in
// db.ts for why they are kept apart.
//
// A token is stored only when it references a real account (the column has a foreign key);
// anything else — anonymous, or a token from another environment — is recorded with a null
// token and null account so the row still counts toward overall volume. Phase 1 is
// observe-only; quotas will later read these rows.
export async function recordRequest(r: RequestRecord): Promise<void> {
  // One lookup resolves both columns, replacing the accountExists round-trip: an unknown token
  // simply yields no row and the request is recorded as anonymous.
  const account = r.token
    ? (await query<{ id: string }>("select id from accounts where token = $1", [r.token])).rows[0]
    : undefined;
  await query(
    `insert into requests (token, account_id, phone_hash, chars, version, outcome, device)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [account ? r.token : null, account?.id ?? null, hashPhone(r.phone), r.chars, r.version,
     r.outcome, r.device],
  );

  // Deliberately a second, independent statement rather than part of a transaction: a shared
  // transaction is one more thing tying the two rows together, and if this insert fails the
  // usage record should still stand.
  if (!r.shape) return;
  await query(
    `insert into request_shapes (day, version, lat, lon, loc, mode, models, vars, max_chars, chars, messages)
     values ((now() at time zone $1)::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [DAY_TZ, r.version, r.shape.lat, r.shape.lon, r.shape.loc, r.shape.mode,
     r.shape.models, r.shape.vars, r.shape.maxChars, r.chars, r.shape.messages],
  );
}
