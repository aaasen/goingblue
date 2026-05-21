import { HEADER_CHARS, periodBitsForMask, nCharsForBits, VARS_BIT } from "@weather/protocol";
import { MODEL_UNAVAIL_VARS } from "./ui-constants.js";

const MAX_CHARS = 160;

let _coords: string | null = null;
let _coordsErr: string | null = null;
let _fetching = false;

function requestCoords(): void {
  if (_fetching || _coords !== null) return;
  _fetching = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _coords = `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
      _coordsErr = null;
      _fetching = false;
      updateBuilder();
    },
    (err) => {
      _coordsErr =
        err.code === 1
          ? "Location access denied — enable permissions or choose a different location."
          : "Location unavailable — try again or choose a different location.";
      _fetching = false;
      updateBuilder();
    },
    { timeout: 10000 },
  );
}

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
  const locationVal =
    (document.querySelector('input[name="location"]:checked') as HTMLInputElement | null)?.value ??
    "current";

  if (locationVal !== "current") {
    _coords = null;
    _coordsErr = null;
    _fetching = false;
  }

  const days = parseInt((document.getElementById("days-slider") as HTMLInputElement).value);
  const resHours = parseInt(
    (document.querySelector('input[name="resolution"]:checked') as HTMLInputElement | null)
      ?.value ?? "24",
  );
  const model =
    (document.querySelector('input[name="model"]:checked') as HTMLInputElement | null)?.value ??
    "hres";

  const varCheckboxes = [...document.querySelectorAll('input[name="var"]')] as HTMLInputElement[];
  for (const cb of varCheckboxes) {
    const unavail = MODEL_UNAVAIL_VARS[model]?.includes(cb.value) ?? false;
    cb.disabled = unavail;
    if (unavail) cb.checked = false;
  }

  const vars = varCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  const varsMask = vars.reduce((mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)), 0);

  (document.getElementById("days-display") as HTMLElement).textContent =
    `${days} day${days > 1 ? "s" : ""}`;

  const bar = document.getElementById("len-bar") as HTMLElement;
  const txt = document.getElementById("len-text") as HTMLElement;
  const msgEl = document.getElementById("builder-msg") as HTMLElement;
  const copyBtn = document.getElementById("builder-copy") as HTMLButtonElement;
  const fetchBtn = document.getElementById("fetch-btn") as HTMLButtonElement;

  if (locationVal === "current") {
    if (_fetching || _coords === null) {
      requestCoords();
      txt.textContent = "Getting location…";
      txt.className = "len-text";
      bar.style.width = "0%";
      msgEl.textContent = "";
      copyBtn.disabled = true;
      fetchBtn.disabled = true;
      return;
    }
    if (_coordsErr) {
      txt.textContent = _coordsErr;
      txt.className = "len-text len-over";
      bar.style.width = "0%";
      msgEl.textContent = "";
      copyBtn.disabled = true;
      fetchBtn.disabled = true;
      return;
    }
  }

  const location = locationVal === "current" ? _coords! : locationVal;

  const nChars = builderChars(days, resHours, 1, varsMask);
  const pct = Math.min((nChars / MAX_CHARS) * 100, 100);
  const over = nChars > MAX_CHARS;

  bar.style.width = pct + "%";
  bar.style.background = over ? "#cc2222" : "#2a8f5a";
  txt.className = "len-text " + (over ? "len-over" : "len-ok");
  txt.textContent = over
    ? `${nChars} chars — exceeds ${MAX_CHARS}, reduce days or resolution`
    : `${nChars} / ${MAX_CHARS} chars`;

  msgEl.textContent = builderMsg(location, days, resHours, [model], vars);
  copyBtn.disabled = over;
  fetchBtn.disabled = over;
}
