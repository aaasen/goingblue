import {
  messageFromString,
  type ForecastMessage,
  RESOLUTION_HOURS,
  CARDINALS,
  modelsFromMask,
} from "@weather/protocol";
import { render, type ForecastView, type DecodedPeriod } from "./render.js";
import { updateBuilder } from "./builder.js";
import { LOCATION_DISPLAY_NAMES } from "./ui-constants.js";

const VERSION = 2;

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
    })),
  );

  return {
    label: `${LOCATION_DISPLAY_NAMES[msg.location] ?? "Unknown"} · ${msg.days}d ${resLabel} · ${models.join(" + ")}`,
    models,
    timeStep: resHours,
    periods,
  };
}

const input = document.getElementById("input") as HTMLTextAreaElement;
const output = document.getElementById("output") as HTMLElement;

input.addEventListener("input", () => {
  const text = input.value.replace(/\s/g, "");
  if (!text) {
    output.innerHTML = "";
    return;
  }

  try {
    const msg = messageFromString(text);
    output.innerHTML = render(toView(msg));
  } catch (e) {
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

document.querySelector(".builder")?.addEventListener("change", updateBuilder);
(document.getElementById("days-slider") as HTMLInputElement).addEventListener(
  "input",
  updateBuilder,
);

document.getElementById("builder-copy")?.addEventListener("click", () => {
  const msg = (document.getElementById("builder-msg") as HTMLElement).textContent ?? "";
  navigator.clipboard.writeText(msg).then(() => {
    const btn = document.getElementById("builder-copy") as HTMLButtonElement;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
});

updateBuilder();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
