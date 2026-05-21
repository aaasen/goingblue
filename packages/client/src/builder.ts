import { HEADER_CHARS, periodBitsForMask, nCharsForBits, VARS_BIT } from "@weather/protocol";
import { MODEL_UNAVAIL_VARS } from "./ui-constants.js";

const MAX_CHARS = 160;

export function builderChars(days: number, resHours: number, nModels: number, varsMask: number): number {
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const bodyBits = days * periodsPerDay * nModels * periodBitsForMask(varsMask);
  return HEADER_CHARS + nCharsForBits(bodyBits);
}

export function builderMsg(location: string, days: number, resHours: number, models: string[], vars: string[]): string {
  const res = resHours >= 24 ? "daily" : `${resHours}h`;
  return [location, `${days}d`, res, models.join(","), ...vars].filter(Boolean).join(" ");
}

export function updateBuilder(): void {
  const location =
    (document.querySelector('input[name="location"]:checked') as HTMLInputElement | null)?.value ??
    "upper";
  const days = parseInt(
    (document.getElementById("days-slider") as HTMLInputElement).value,
  );
  const resHours = parseInt(
    (document.querySelector('input[name="resolution"]:checked') as HTMLInputElement | null)
      ?.value ?? "24",
  );
  const models = [
    ...(document.querySelectorAll('input[name="model"]:checked') as NodeListOf<HTMLInputElement>),
  ].map((el) => el.value);

  // Disable var checkboxes not supported by any selected model
  const varCheckboxes = [...document.querySelectorAll('input[name="var"]')] as HTMLInputElement[];
  for (const cb of varCheckboxes) {
    const unavail = models.length > 0 && models.every((m) => MODEL_UNAVAIL_VARS[m]?.includes(cb.value));
    cb.disabled = unavail;
    if (unavail) cb.checked = false;
  }

  const vars = varCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  const varsMask = vars.reduce((mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)), 0);

  (document.getElementById("days-display") as HTMLElement).textContent =
    `${days} day${days > 1 ? "s" : ""}`;

  const nChars = models.length > 0 ? builderChars(days, resHours, models.length, varsMask) : 0;
  const bar = document.getElementById("len-bar") as HTMLElement;
  const txt = document.getElementById("len-text") as HTMLElement;
  const pct = Math.min((nChars / MAX_CHARS) * 100, 100);
  const over = nChars > MAX_CHARS;

  bar.style.width = pct + "%";
  bar.style.background = over ? "#cc2222" : "#2a8f5a";
  txt.className = "len-text " + (over ? "len-over" : "len-ok");
  txt.textContent =
    models.length === 0
      ? "Select at least one model"
      : over
        ? `${nChars} chars — exceeds ${MAX_CHARS}, reduce days or resolution`
        : `${nChars} / ${MAX_CHARS} chars`;

  const msg = models.length > 0 ? builderMsg(location, days, resHours, models, vars) : "";
  (document.getElementById("builder-msg") as HTMLElement).textContent = msg;
  const disabled = over || models.length === 0;
  (document.getElementById("builder-copy") as HTMLButtonElement).disabled = disabled;
  (document.getElementById("fetch-btn") as HTMLButtonElement).disabled = disabled;
}
