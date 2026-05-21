import {
  messageFromString,
  type ForecastMessage,
  RESOLUTION_HOURS,
  RESOLUTION_LABEL,
  CARDINALS,
  modelsFromMask,
  startDatetime,
} from "@weather/protocol";
import { render, type ForecastView, type DecodedPeriod } from "./render.js";
import { updateBuilder, requestCoords } from "./builder.js";
import { LOCATION_DISPLAY_NAMES } from "./ui-constants.js";

const VERSION = 4;

function toView(msg: ForecastMessage): ForecastView {
  const models = modelsFromMask(msg.models_mask);
  const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
  const daily = resHours >= 24;
  const resLabel = daily ? "daily" : `${resHours}h`;

  const now = new Date();
  const start = new Date(now.getFullYear(), msg.month - 1, msg.day, msg.hour);
  if (now.getTime() - start.getTime() > 180 * 86400000) start.setFullYear(start.getFullYear() + 1);
  const stepMs = resHours * 3600000;

  const periods: DecodedPeriod[][] = msg.periods.map((modelPeriods) =>
    modelPeriods.map((p, i) => ({
      date: new Date(start.getTime() + i * stepMs),
      wc: p.weathercode,
      precip: p.precip,
      temp_f: p.temp_f,
      temp_min_f: p.temp_min_f,
      fz_ft: p.freeze_ft,
      snow: p.snow_in,
      snowUnit: daily ? 1 : 0.1,
      p_sfc: p.wind_sfc_mph != null
        ? { ws: p.wind_sfc_mph, dir: CARDINALS[p.wind_sfc_dir!] }
        : undefined,
      p500: p.wind_500_mph != null
        ? { ws: p.wind_500_mph, dir: CARDINALS[p.wind_500_dir!] }
        : undefined,
      p600: p.wind_600_mph != null
        ? { ws: p.wind_600_mph, dir: CARDINALS[p.wind_600_dir!] }
        : undefined,
      p700: p.wind_700_mph != null
        ? { ws: p.wind_700_mph, dir: CARDINALS[p.wind_700_dir!] }
        : undefined,
      cloud_total: p.cloud_total,
      cloud_high:  p.cloud_high,
      cloud_mid:   p.cloud_mid,
      cloud_low:   p.cloud_low,
      vis_km:      p.vis_km,
    })),
  );

  const latStr = `${Math.abs(msg.lat).toFixed(3)}°${msg.lat >= 0 ? "N" : "S"}`;
  const lonStr = `${Math.abs(msg.lon).toFixed(3)}°${msg.lon >= 0 ? "E" : "W"}`;

  const elevStr = msg.location === 0 && msg.elevation != null
    ? ` · ${Math.round(msg.elevation * 3.28084).toLocaleString()}ft`
    : "";

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const startStr = daily
    ? `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()}`
    : `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()} ${start.getHours()}h`;

  return {
    label: `${LOCATION_DISPLAY_NAMES[msg.location] ?? "Unknown"} · ${latStr} ${lonStr}${elevStr} · ${msg.days}d ${resLabel} from ${startStr} · ${models.join(" + ")}`,
    models,
    timeStep: resHours,
    periods,
  };
}

const input = document.getElementById("input") as HTMLTextAreaElement;
const output = document.getElementById("output") as HTMLElement;

let suppressNextCache = false;

input.addEventListener("input", () => {
  const text = input.value.replace(/\s/g, "");
  if (!text) {
    output.innerHTML = "";
    return;
  }

  try {
    const msg = messageFromString(text);
    output.innerHTML = render(toView(msg));
    if (!suppressNextCache) addToCache(text);
    suppressNextCache = false;
  } catch (e) {
    suppressNextCache = false;
    const msg = String(e);
    if (msg.includes("Version mismatch")) {
      const match = msg.match(/encoded v(\d+)/);
      const encoded = match ? match[1] : "?";
      output.innerHTML = `<p class="empty" style="color:#c03030">Version mismatch: message used protocol v${encoded}, decoder expects v${VERSION}. Request a new forecast.</p>`;
    } else {
      output.innerHTML = `<p class="empty">Could not decode forecast.</p>`;
    }
  }
});

const fetchBtn = document.getElementById("fetch-btn") as HTMLButtonElement;
const fetchStatus = document.getElementById("fetch-status") as HTMLElement;

fetchBtn.addEventListener("click", async () => {
  const locationVal =
    (document.querySelector('input[name="location"]:checked') as HTMLInputElement | null)?.value ??
    "current";

  if (locationVal === "current") {
    fetchBtn.disabled = true;
    fetchStatus.textContent = "Getting location…";
    fetchStatus.className = "fetch-status";
    try {
      await requestCoords();
    } catch (e) {
      fetchStatus.textContent = (e as Error).message;
      fetchStatus.className = "fetch-status fetch-error";
      fetchBtn.disabled = false;
      return;
    }
  }

  const msg = (document.getElementById("builder-msg") as HTMLElement).textContent ?? "";
  if (!msg) return;

  fetchBtn.disabled = true;
  fetchStatus.textContent = "Fetching…";
  fetchStatus.className = "fetch-status";

  try {
    const resp = await fetch("/forecast", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: msg,
    });
    if (!resp.ok) throw new Error(await resp.text());
    const encoded = await resp.text();
    input.value = encoded;
    input.dispatchEvent(new Event("input"));
    fetchStatus.textContent = "";
    input.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    fetchStatus.textContent = String(e);
    fetchStatus.className = "fetch-status fetch-error";
    fetchBtn.disabled = false;
  }
});

function clearFetchError() {
  if (fetchStatus.className.includes("fetch-error")) {
    fetchStatus.textContent = "";
    fetchStatus.className = "fetch-status";
  }
}

document.querySelector(".builder")?.addEventListener("change", () => {
  updateBuilder();
  clearFetchError();
});
(document.getElementById("days-slider") as HTMLInputElement).addEventListener("input", () => {
  updateBuilder();
  clearFetchError();
});

document.getElementById("builder-copy")?.addEventListener("click", () => {
  const msg = (document.getElementById("builder-msg") as HTMLElement).textContent ?? "";
  navigator.clipboard.writeText(msg).then(() => {
    const btn = document.getElementById("builder-copy") as HTMLButtonElement;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
});

updateBuilder();

// --- Past forecast cache ---

const CACHE_KEY = "past_forecasts";

interface CacheEntry {
  encoded: string;
  savedAt: number;
}

function loadCache(): CacheEntry[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const valid: CacheEntry[] = [];
    let dirty = false;
    for (const item of arr) {
      if (
        typeof item !== "object" || item === null ||
        typeof (item as CacheEntry).encoded !== "string" ||
        typeof (item as CacheEntry).savedAt !== "number"
      ) { dirty = true; continue; }
      try {
        messageFromString((item as CacheEntry).encoded);
        valid.push(item as CacheEntry);
      } catch {
        dirty = true;
      }
    }
    if (dirty) persistCache(valid);
    return valid;
  } catch {
    return [];
  }
}

function persistCache(entries: CacheEntry[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch {}
}

function addToCache(encoded: string): void {
  try { messageFromString(encoded); } catch { return; }
  const entries = loadCache().filter((e) => e.encoded !== encoded);
  entries.unshift({ encoded, savedAt: Date.now() });
  persistCache(entries);
  renderPastForecasts();
}

function deleteFromCache(encoded: string): void {
  persistCache(loadCache().filter((e) => e.encoded !== encoded));
  renderPastForecasts();
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderPastForecasts(): void {
  const list = document.getElementById("past-forecasts-list") as HTMLElement;
  const entries = loadCache();

  list.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.style.padding = "12px 0";
    empty.textContent = "No past forecasts.";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    let meta = "Unknown";
    try {
      const msg = messageFromString(entry.encoded);
      const models = modelsFromMask(msg.models_mask).join(" + ");
      const resLabel = RESOLUTION_LABEL[msg.resolution] ?? "?";
      const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
      const start = startDatetime(msg);
      const startStr = resHours >= 24
        ? `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()}`
        : `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()} ${start.getHours()}h`;
      const location = LOCATION_DISPLAY_NAMES[msg.location] ?? "Unknown";
      meta = `${location} · ${startStr} · ${msg.days}d ${resLabel} · ${models}`;
    } catch { /* filtered by loadCache */ }

    const item = document.createElement("div");
    item.className = "past-forecast-item";

    const metaSpan = document.createElement("span");
    metaSpan.className = "past-forecast-meta";
    metaSpan.textContent = meta;

    const btns = document.createElement("div");
    btns.className = "past-forecast-btns";

    const loadBtn = document.createElement("button");
    loadBtn.className = "past-load-btn";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => {
      suppressNextCache = true;
      input.value = entry.encoded;
      input.dispatchEvent(new Event("input"));
      input.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "past-delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteFromCache(entry.encoded));

    btns.append(loadBtn, deleteBtn);
    item.append(metaSpan, btns);
    list.appendChild(item);
  }
}

renderPastForecasts();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
