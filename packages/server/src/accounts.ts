import { randomBytes } from "node:crypto";
import { generateToken } from "@weather/protocol";
import { getPool, query } from "./db.js";
import type { RequestShape } from "./dispatch.js";

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
// The `requests` rows survive with a null token, keeping `account_id`, an opaque number that
// cannot be turned back into a person once the token is gone. Keeping it is what makes the usage
// record stay true: nulling it would retroactively erase this user from every past day's count,
// so the dashboard would report fewer people using the service last March than actually did. The
// per-version counts are the sunset metric for frozen codec containers (VERSIONING.md) and need
// the rows for the same reason. The locations on those rows lose their identity the same way:
// with the token gone they belong to an opaque id that maps to nobody.
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

// One inbound message, as recorded. The sending number is deliberately not part of it — see the
// header comment in db.ts.
export interface RequestRecord {
  // The gateway's id for this message, carried by every log line it produced (log.ts).
  requestId: string;
  token: string | null;
  chars: number | null;
  version: number | null;
  // 'ok' for a served forecast, a DispatchResult failure kind, or 'help' for the messages that
  // are answered without a forecast. Old rows may also carry 'probe' (removed field probes).
  outcome: string;
  // Wall time of the codec call as the gateway saw it, on every path that reached a codec —
  // null when none was called (missing/unsupported version, HELP).
  codecMs: number | null;
  // What was asked for, as the codec reported it (dispatch.ts, parseShapeHeader). Null for
  // failures and for containers frozen before the header existed; the row's shape columns are
  // all null then.
  shape: RequestShape | null;
}

// Record one inbound message as one row.
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
  const s = r.shape;
  await query(
    `insert into requests (request_id, token, account_id, chars, version, outcome, codec_ms,
                           lat, lon, loc, mode, model, vars, max_chars, messages, device, platform,
                           periods, fetch_ms, encode_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [r.requestId, account ? r.token : null, account?.id ?? null, r.chars, r.version, r.outcome, r.codecMs,
     s?.lat ?? null, s?.lon ?? null, s?.loc ?? null, s?.mode ?? null, s?.model ?? null,
     s?.vars ?? null, s?.maxChars ?? null, s?.messages ?? null, s?.device ?? null, s?.platform ?? null,
     s?.periods ?? null, s?.fetchMs ?? null, s?.encodeMs ?? null],
  );
}
