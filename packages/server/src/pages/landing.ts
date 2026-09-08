import type { Context } from "hono";
import { img } from "../assets.js";
import { APP_STORE_URL, BRAND, CONTACT_EMAIL, REPO_URL } from "../constants.js";
import { PAGE } from "./shell.js";

// The landing page is headed by a full-bleed photo of Sultana in a band of its own, with the
// masthead over it — the photo is a defined section of the page, not the backdrop behind all of
// it. Served at two widths from /img (assets.ts); the small one is plenty for a phone and a
// quarter of the bytes.
//
// The source photo is cropped so the summit is the center of the frame, which is what lets the
// band crop around it: horizontally `center` holds the summit in the middle at any width. The
// vertical is `top` rather than `center` because the summit sits a tenth of a frame below the
// upper edge — on a band wider than the photo's 2.46:1 the `cover` crop eats height, and any
// anchor but the top carries the peak up and out of the band.
//
// The app icon sits above the title. The icon file is square and unrounded (iOS applies the mask
// itself), so the corner radius is ours to draw: 22.4% of the width is Apple's own superellipse
// proportion, which is what makes it read as an app icon rather than a photo.
//
// The photo credit sits in the band's lower right, out of the masthead's way — the centered block
// is vertically centered, so the bottom corner is empty at every width. It is positioned against
// the band rather than placed in the flow because the band is a single centered flex item, and a
// second child would pull the masthead off center.
//
// The store buttons close the masthead, under the subtitle: the band is what sells the app, so
// the one thing to do about it belongs inside the band rather than a scroll below it. They are the
// stores' own badge artwork (assets.ts) — Apple's black badge and Google's only one, which is also
// black — and the artwork comes with rules from both: at least 40px tall for Apple and 28px for
// Google, clear space around each of a quarter its height, and no redrawing, recoloring, adding
// effects, or setting the words beside it in live text. Apple adds that where another platform's
// badge shares the layout, its badge is the black one and comes first in the lineup; Google adds
// that its badge be the same size or larger than any other store badge beside it, which the shared
// 50px height satisfies. That height clears both floors, and the 16px gaps clear the 12.5px of space
// a 50px badge is owed; nothing here may grow into a text-shadow like the type above it. Apple's art
// is 119.66x40, so its box is drawn at 3:1 and the SVG's own viewBox letterboxes the half-pixel
// rather than stretching it; Google's is 238.96x70.87, which at 50px tall is 169px wide, and the
// box is drawn at that width for the same reason. The row centers the pair and stacks it if a phone
// is too narrow to hold both on one line (a 360px phone is), which keeps each badge at its full
// size rather than shrinking it to fit. The band's height is a minimum, not a fixed size, for the
// same reason: the band grows to hold the stack rather than letting the lower badge run over the
// photo credit, and the 40px padding keeps the credit's corner clear of it when the band does grow.
//
// The Google Play badge links to /android rather than to the Play listing: the app is in closed
// testing, so the listing only opens for someone already enrolled, and /android is where the
// enrollment steps are. Point it at the listing itself once the app is in production.
const HERO_CSS = `
  .hero {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box; min-height: 480px; padding: 40px 20px; text-align: center; color: #fff;
    background: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
      url(${img("sultana-1200.jpg")}) center top / cover no-repeat #0c2240;
  }
  @media (min-width: 801px) {
    .hero {
      background-image: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
        url(${img("sultana-2400.jpg")});
    }
  }
  @media (max-width: 600px) { .hero { min-height: 380px; } }
  .hero h1 { margin: 0.5em 0 0.12em; font-size: 2.2em; letter-spacing: -0.02em;
    text-shadow: 0 2px 10px rgba(6, 18, 36, 0.55); }
  .hero .subtitle { margin: 0; font-size: 1.2em;
    text-shadow: 0 2px 10px rgba(6, 18, 36, 0.55); }
  .appicon { display: block; width: 116px; height: 116px; margin: 0 auto; border-radius: 26px;
    box-shadow: 0 6px 22px rgba(6, 18, 36, 0.45); }
  .herocredit { position: absolute; right: 16px; bottom: 12px; margin: 0;
    color: #fff; font-size: 0.8em; letter-spacing: 0.01em;
    text-shadow: 0 1px 6px rgba(6, 18, 36, 0.7); }
  .badges { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; margin-top: 1.1em; }
  .appbtn { display: block; width: 150px; }
  .appbtn img { display: block; width: 150px; height: 50px; }
  .playbtn { display: block; width: 169px; }
  .playbtn img { display: block; width: 169px; height: 50px; }
  @media (max-width: 600px) {
    .appicon { width: 92px; height: 92px; border-radius: 21px; }
    .hero h1 { font-size: 1.85em; }
    .hero .subtitle { font-size: 1.05em; }
    .herocredit { font-size: 0.72em; right: 12px; bottom: 10px; }
  }
`;

// The screenshots run in one horizontally scrolling strip rather than a stacked column: they are
// portrait phone shots, and five of them down the page would push every word of the copy below
// the fold. The strip is what buys them their width: a shot is 300px in the text column and 230px
// on a phone — big enough to read the meteogram rather than just recognize one — where a row that
// had to fit them all would have to draw each at a third of that. Nothing says "scroll me" except
// a shot cut off by the edge, so the widths also leave one mid-frame: two and a good part of the
// third in the text column, one and half of the second on a phone.
//
// The strip is full-bleed: `width: 100vw` with a `calc(50% - 50vw)` left margin pulls it out of the
// wrap to span the viewport. That calc degrades on its own — a margin `%` resolves against the
// wrap's content box, so on a screen narrower than the max-width it collapses to the old -20px,
// leaving the phone layout as it was.
//
// Centring is two mechanisms, because one does not cover the range. The figures shrink — `flex: 0
// 1 300px` off a 200px floor — so on any desktop the five fit in a single row and the row fills the
// strip between symmetric gutters. From about 1604px they stop shrinking at their 300px basis, and
// from there the auto margins on the first and last figure take the slack and centre the group.
//
// The auto margins are deliberate, not `justify-content: center`: centring a scroll container that
// way puts the left-hand overflow outside the scrollable region, where no amount of scrolling
// reaches it. Auto margins resolve to zero once the content outgrows the strip, so the row centres
// while it fits and start-aligns when it does not, with both ends reachable either way.
//
// Below roughly 1104px even the 200px floor stops fitting and the row goes back to scrolling, which
// is what the floor is for — a row divided into a small laptop is illegible long before it is
// merely cramped. The phone breakpoint skips all of this and pins a 230px scrolling strip.
//
// The scrollbar is hidden (`scrollbar-width` plus the WebKit pseudo-element) because the strip is
// a glance and a permanent trough under it reads as chrome. Nothing is lost: a shot cut off by the
// edge is what says "scroll me", and that is exactly the state the bar would have appeared in.
//
// `box-sizing: border-box` on the strip is load-bearing, not tidiness: the page sets no global
// border-box, so under the default content-box a `width: 100vw` would have the side padding added
// on top of it — on a desktop that is a strip half again as wide as the screen.
//
// 100vw counts the desktop scrollbar, so the strip ends up a scrollbar wider than the viewport and
// would raise a horizontal scrollbar on the body. `overflow-x: clip` on the body is what makes the
// full-bleed safe; `hidden` would also contain it but makes the body a scroll container, which
// silently breaks `position: sticky` for anything added later, and `clip` does not.
//
// The shots carry their own captions, baked into the image by
// packages/mobile/scripts/frame-screenshots.py — the same frames the App Store listing uses. There
// is deliberately no figcaption under them: a second caption in the page's voice under a caption in
// the listing's voice reads as two different pages arguing. The "How it works" section is a second
// strip of the same class, its three step frames (assets.ts) drawn at the same 750px width, so
// the two scroll the same way. Those frames are
// the opposite case: cards on white with their own shadows inside and no caption, so the strip's
// shadow comes off them (`.howto`) and each carries a figcaption above the image with a title
// and a line of text. Each figure is a column with the image pushed to its bottom: the figures
// stretch to the row's height and the images are one size, so the images start level whether a
// caption wraps to one line or three, with no more gap than the tallest caption needs. With only
// three, the frames are drawn a
// little wider than the five shots. Captions sit inside the figure's padding so the text stays
// flush with the cards, which are inset in the frame by their own shadow margin.
//
// `scroll-snap-type: proximity`, not `mandatory`: the strip is a glance, not a carousel, and
// mandatory snapping fights a user who is flicking through it.
//
// The top margin is 40px, not the 1.8em the bottom one is, so that the opening paragraph is framed
// evenly: the gap above it is the wrap's own 40px (the paragraph's 1em collapses through it), and
// this margin collapses with the paragraph's 1em to set the gap below. 40px in px rather than 2.5em
// because the number it has to match is the wrap's, which is in px and does not scale with the
// reader's font size.
const SHOTS_CSS = `
  .shots { display: flex; gap: 16px; box-sizing: border-box; width: 100vw;
    margin: 40px 0 1.8em calc(50% - 50vw); padding: 0 20px 10px;
    overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none; }
  .shots::-webkit-scrollbar { display: none; }
  .shots figure { flex: 0 1 300px; min-width: 200px; margin: 0; scroll-snap-align: center; }
  .shots figure:first-child { margin-left: auto; }
  .shots figure:last-child { margin-right: auto; }
  .shots img { display: block; width: 100%; height: auto; border-radius: 14px;
    box-shadow: 0 2px 10px rgba(6, 18, 36, 0.08); }
  @media (max-width: 600px) { .shots figure { flex: 0 0 230px; min-width: 0; } }
  .stripHead { text-align: center; font-size: 1.7em; margin-bottom: 0; }
  .howto figure { flex-basis: 340px; }
  .howto figure { display: flex; flex-direction: column; }
  .howto img { box-shadow: none; margin-top: auto; }
  .howto figcaption { padding: 0 20px 0.8em; text-align: center; }
  .howto h3 { margin: 0 0 0.3em; font-size: 1.05em; }
  .howto figcaption p { margin: 0; color: #555; font-size: 0.85em; line-height: 1.4; }
  @media (max-width: 600px) { .howto figure { flex-basis: 260px; } }
`;

// The masthead the shell hangs above the wrap. It carries the <h1> itself, which is why the shell
// draws none of its own for a page that brings a header.
const HERO = `<header class=hero>
  <div>
    <img class=appicon src="${img("icon-512.jpg")}" width=116 height=116 alt="">
    <h1>${BRAND}</h1>
    <p class=subtitle>Expedition weather forecasts via satellite</p>
    <div class=badges>
      <a class=appbtn href="${APP_STORE_URL}"><img src="${img("appstore-badge-black.svg")}" width=150
        height=50 alt="Download on the App Store"></a>
      <a class=playbtn href="/android"><img src="${img("googleplay-badge.svg")}" width=169
        height=50 alt="Get it on Google Play"></a>
    </div>
  </div>
  <p class=herocredit>Sultana from Denali, May 2026</p>
</header>`;

// The marketing copy is kept in step with the App Store listing's description — the two are read
// back to back by anyone deciding whether to install, so they should not tell different stories.
// The companion app is distributed through the App Store and, while its closed test runs, through
// /android, both of which the masthead links to above everything here.
//
// The page is marketing only: the SMS consent language, the opt-out wording and the safety
// disclaimer live on /support, /privacy and /terms, reached through the footer. If an A2P 10DLC
// campaign review asks for consent language on the public site, it goes back here.
const LANDING_BODY = `
<p>${BRAND} is an expedition weather app designed specifically for satellite messengers. It was
built for a Denali ski expedition with one goal: to get you all the weather information you would
have at home, wherever you are. ${BRAND} uses a custom codec to pack hundreds of forecast data
points into a single message that can be sent over SMS, Garmin inReach, ZOLEO, or iPhone
satellite messaging.</p>

<div class=shots>
  <figure>
    <img src="${img("shot-overview.jpg")}" width=750 height=1630 loading=lazy
      alt="Expedition weather forecasts via inReach, ZOLEO, and iPhone satellite">
  </figure>
  <figure>
    <img src="${img("shot-altitude.jpg")}" width=750 height=1630 loading=lazy
      alt="High-altitude winds and freezing level forecasts for mountaineering">
  </figure>
  <figure>
    <img src="${img("shot-cloud.jpg")}" width=750 height=1630 loading=lazy
      alt="Avoid whiteouts and flat light with detailed cloud cover">
  </figure>
  <figure>
    <img src="${img("shot-aqi.jpg")}" width=750 height=1630 loading=lazy
      alt="Plan around wildfire smoke with AQI forecasts">
  </figure>
  <figure>
    <img src="${img("shot-agreement.jpg")}" width=750 height=1630 loading=lazy
      alt="Compare forecasts from NOAA, ECMWF, GEM, and ICON models">
  </figure>
</div>

<h2 class=stripHead>How it works</h2>
<div class="shots howto">
  <figure>
    <figcaption>
      <h3>Build a forecast request</h3>
      <p>Choose the location, weather model, and variables that you care about.</p>
    </figcaption>
    <img src="${img("howto-build.jpg")}" width=750 height=1351 loading=lazy
      alt="The request builder: Denali pinned on the map, the weather model selector, and the
      extra variable toggles">
  </figure>
  <figure>
    <figcaption>
      <h3>Send the request</h3>
      <p>Send the request via the internet, SMS, Garmin inReach, ZOLEO, or iPhone satellite
      messaging.</p>
    </figcaption>
    <img src="${img("howto-send.jpg")}" width=750 height=1351 loading=lazy
      alt="The device selector with SMS chosen and the Send SMS button, the request in the
      Messages compose field, and the Copy menu on the encoded reply">
  </figure>
  <figure>
    <figcaption>
      <h3>View the forecast</h3>
      <p>Paste the forecast response into the app to visualize the forecast.</p>
    </figcaption>
    <img src="${img("howto-view.jpg")}" width=750 height=1351 loading=lazy
      alt="The Paste Forecast button and the decoded Denali meteogram">
  </figure>
</div>

<h2>Features</h2>
<ul>
  <li><strong>Satellite ready</strong>: Get forecasts anywhere in the world, without cell
  reception. Works with Garmin inReach, ZOLEO, and iPhone satellite messaging.</li>
  <li><strong>Hundreds of data points per message</strong>: Uses custom compression optimized for
  weather data to fit a detailed weather forecast into a single message.</li>
  <li><strong>30+ weather models</strong>: Forecasts from high-resolution models like HRRR (3km),
  HRDPS (2.5km), ICON-D2 (2km), and MET Norway (1km). Automatically chooses the best model for
  your location.</li>
  <li><strong>Detailed cloud cover</strong>: See up to 10 levels in the atmosphere to
  differentiate between high clouds, valley fog, and whiteout conditions.</li>
  <li><strong>Mountain forecasts</strong>: Pressure-level winds and freezing level for
  high-altitude mountaineering.</li>
  <li><strong>Air quality</strong>: Plan around wildfire smoke and other pollution with AQI
  forecasts.</li>
  <li><strong>Model agreement</strong>: See how well the forecast agrees with models from NOAA,
  ECMWF, ECCC, and DWD.</li>
  <li><strong>Works offline</strong>: All forecasts are saved on your device for comparing
  multiple models and past forecasts while offline.</li>
  <li><strong>Private</strong>: ${BRAND} requires no account and does not store your name, email,
  or phone number.</li>
</ul>

<h2>Open source</h2>
<p>${BRAND} is open source under the Apache License 2.0 and the source code is hosted at
<a href="${REPO_URL}">github.com/aaasen/goingblue</a>. Feedback is welcome! If you have suggestions or need weather data that is not included in the app,
file an issue on GitHub or email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

export function landing(c: Context) {
  return c.html(
    PAGE(BRAND, LANDING_BODY, {
      showUpdated: false,
      header: HERO,
      css: HERO_CSS + SHOTS_CSS,
    }),
  );
}
