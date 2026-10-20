import { QUOTA_FREE_FORECASTS, type QuotaState } from "@weather/protocol";
import { log } from "./log.js";

// The gateway's `X-Quota` request header: the account's free-forecast quota as the weather
// reply should report it. The codec has no database, so this is the only way it learns the
// state; it writes it into the weather header and ignores it for avalanche replies, which
// carry no quota. Absent means none. The gateway and codec are the only two parties, so a value
// neither recognizes is a bug there, not a reason to refuse the forecast: it is logged and
// read as none.
//
//   none          no quota, show no quota UI
//   free:<n>      n free forecasts remain this month after this one, 0..QUOTA_FREE_FORECASTS
//   over          the month's free forecasts are used up
export const QUOTA_HEADER = "X-Quota";

export function parseQuotaHeader(value: string | undefined): QuotaState {
  if (value === undefined || value === "none") return { kind: "none" };
  if (value === "over") return { kind: "over" };
  const m = /^free:(\d+)$/.exec(value);
  const remaining = m ? Number(m[1]) : NaN;
  if (Number.isInteger(remaining) && remaining >= 0 && remaining <= QUOTA_FREE_FORECASTS) {
    return { kind: "free", remaining };
  }
  log.error("encode.quota_header_invalid", { value });
  return { kind: "none" };
}
