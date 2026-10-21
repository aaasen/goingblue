import { QUOTA_FREE_FORECASTS, type QuotaState } from '@weather/protocol';

// The free-forecast quota as the app knows it. Weather forecasts over the messaging routes are
// limited to QUOTA_FREE_FORECASTS a UTC calendar month; the internet route and avalanche
// forecasts are not. The server states the quota two ways, and the app keeps whichever it heard
// last: the header of every weather reply pasted in, and POST /account/quota when online.
//
// `month` is the UTC month the state was heard in. A free or over state from an earlier month
// has reset, so the builder shows a fresh month's quota until the server says otherwise. A
// `none` state (an account with no quota) does not reset with the month.
export interface StoredQuota {
  state: QuotaState;
  month: string;
}

// "YYYY-MM" in UTC, the quota's window as the server counts it.
export function utcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// A state as heard at `heardAt`: the request's time for a pasted reply, since the server built
// its header for the month the request was made in, however late the paste; now for an answer
// from POST /account/quota.
export function storedQuota(state: QuotaState, heardAt: Date): StoredQuota {
  return { state, month: utcMonth(heardAt) };
}

export function isQuotaState(value: unknown): value is QuotaState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'none' || v.kind === 'over') return true;
  return v.kind === 'free' && Number.isInteger(v.remaining)
    && (v.remaining as number) >= 0 && (v.remaining as number) <= QUOTA_FREE_FORECASTS;
}

// The state that holds now: what was stored if it is still current, otherwise a fresh month.
export function currentQuota(stored: StoredQuota | null, now: Date): QuotaState {
  if (stored && (stored.state.kind === 'none' || stored.month === utcMonth(now))) return stored.state;
  return { kind: 'free', remaining: QUOTA_FREE_FORECASTS };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The quota the app shows: the server's last word, unless the store says the account is
// subscribed, which the app can know before the server has heard of the purchase and while
// offline. The server stays the one that enforces.
export function effectiveQuota(stored: StoredQuota | null, entitled: boolean, now: Date): StoredQuota | null {
  return entitled ? { state: { kind: 'none' }, month: utcMonth(now) } : stored;
}

// What the free plan includes before its monthly allowance.
const INCLUDED_BULLETS = [
  'Unlimited weather forecasts via the internet.',
  'Unlimited avalanche forecasts.',
];

// The Subscription section of Settings: the plan's name, a line of text, and on the free plan
// what it includes as bullets under the text, with this month's standing last. Not tied to a
// route, since the quota is one count across all of them.
export const SUBSCRIBED_TEXT =
  'You are subscribed to the Going Blue Expedition plan. Enjoy unlimited weather and avalanche '
  + 'forecasts via satellite. Thank you for supporting Going Blue!';
export const FREE_TEXT = 'You are not subscribed to Going Blue. The following features are available for free:';

// `standing` is this month's count on the free plan, the line just before the subscribe note.
export function quotaStatus(stored: StoredQuota | null, now: Date): {
  name: string; bullets: string[]; text: string | null; standing: string | null; subscribed: boolean;
} {
  const state = currentQuota(stored, now);
  if (state.kind === 'none') {
    return { name: 'Going Blue Expedition', bullets: [], text: SUBSCRIBED_TEXT, standing: null, subscribed: true };
  }
  const bullets = [...INCLUDED_BULLETS, `${QUOTA_FREE_FORECASTS} free SMS and satellite weather forecasts per month.`];
  const month = MONTH_NAMES[now.getUTCMonth()];
  if (state.kind === 'over') {
    const next = MONTH_NAMES[(now.getUTCMonth() + 1) % 12];
    return {
      name: 'Going Blue Free', bullets, text: FREE_TEXT,
      standing: `You have used all of your free weather forecasts for ${month}. The limit resets ${next} 1.`,
      subscribed: false,
    };
  }
  const noun = state.remaining === 1 ? 'forecast' : 'forecasts';
  return {
    name: 'Going Blue Free', bullets, text: FREE_TEXT,
    standing: `You have ${state.remaining} free weather ${noun} remaining in ${month}.`,
    subscribed: false,
  };
}

// The subscriber's plan and period, under the thank-you text in Settings. The plan sentence is
// left out when the plan is not known, the date sentence when the store has given no period.
export function subscriptionLine(
  plan: 'monthly' | 'annual' | null, period: { ends: Date; renews: boolean } | null,
): string | null {
  const parts: string[] = [];
  if (plan) parts.push(`You are on the ${plan} plan.`);
  if (period) {
    const date = period.ends.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    parts.push(`Your subscription will ${period.renews ? 'renew' : 'end'} on ${date}.`);
  }
  return parts.length ? parts.join(' ') : null;
}

// The line under the free plan's bullets, above the Subscribe button.
export const SUBSCRIBE_CTA = 'Subscribe to Going Blue Expedition for unlimited SMS and satellite weather forecasts.';

// The line under the action button while a messaging route is selected, naming the route
// (`device` is its label, "SMS" or "inReach"), or null when the account has no quota. The quota
// is one count across every messaging route; the line names the one the reader is about to
// spend it on.
export function quotaLine(stored: StoredQuota | null, now: Date, device: string): string | null {
  const state = currentQuota(stored, now);
  if (state.kind === 'none') return null;
  if (state.kind === 'over') {
    const next = MONTH_NAMES[(now.getUTCMonth() + 1) % 12];
    return `Free ${device} forecast limit exceeded. Limit resets ${next} 1. Subscribe for unlimited forecasts.`;
  }
  const month = MONTH_NAMES[now.getUTCMonth()];
  const noun = state.remaining === 1 ? 'forecast' : 'forecasts';
  return `${state.remaining} free ${device} ${noun} remaining in ${month}. Subscribe for unlimited forecasts.`;
}
