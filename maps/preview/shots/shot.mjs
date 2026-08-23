// Screenshot work.html at a few views: node shots/shot.mjs [pack-id]
import puppeteer from "puppeteer-core";
const pack = process.argv[2] || "";
const VIEWS = [["world", 30, -100, 2.5], ["colorado_z8", 39.1, -106.5, 8],
               ["cascades_z9", 47.6, -121.5, 9], ["rainier_z11", 46.85, -121.76, 11]];
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
page.on("console", (m) => { const t = m.text(); if (/error/i.test(t)) console.log("CONSOLE:", t.slice(0, 300)); });
await page.goto("http://localhost:8471/work.html", { waitUntil: "load" });
await page.waitForFunction(() => window.map, { timeout: 20000 });
const idle = () => page.evaluate(() => new Promise((res) => { map.once("idle", res); setTimeout(res, 30000); }));
await idle();
if (pack) { await page.select("#pack", pack); await page.click("#online"); await idle(); }
for (const [name, lat, lon, z] of VIEWS) {
  await page.evaluate((lat, lon, z) => map.jumpTo({ center: [lon, lat], zoom: z }), lat, lon, z);
  await idle(); await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `shots-out/${pack || "online"}_${name}.png` });
  console.log("shot", name);
}
await browser.close();
