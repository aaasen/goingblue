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
// The source button stands beside the App Store badge, drawn to match it: the page already links
// the repo from the Open source section, but that is prose at the bottom of the listing, and
// someone who came to read the code rather than to read about the app should not have to scroll the
// whole pitch to find it.
//
// Matching Apple's badge means measuring it rather than guessing at it. The white variant is a
// white fill with black artwork and a 1px black edge — not, as it reads at a glance over the photo,
// a dark button — and rasterizing it at its drawn size puts the corner radius at 6.5px on a 50px
// box. So the source button is white too, 150x50 like the badge, with the same radius and edge. The
// point is a pair that looks issued together rather than a button someone added next to a badge.
//
// The mark is GitHub's own, the 16px `mark-github` octicon copied byte for byte from
// @primer/octicons, which is the size of the set drawn for small rendering — this is a 20px icon,
// not a logo scaled down to one. GitHub's guidelines allow the mark for linking to GitHub, in black
// or white, but not redrawn, not with effects like shadows, and not over a busy background. The
// white button satisfies the last two by construction, which the earlier corner placement did not:
// a mark laid on the photo needed a drop shadow to hold it off the sky, and that shadow was itself
// the prohibited thing. The words beside it are ours, not GitHub's wordmark set in our type — that
// lockup is theirs to draw, and "View source" says what the button does anyway.
//
// The mark is inline rather than a file under /img like Apple's badge, for two reasons the badge
// does not share: it has to take its color from the button (an <img> cannot, and the shell's link
// blue would otherwise win), and at a few hundred bytes a second request would cost more than the
// markup. Being artwork with live text beside it, it is hidden from the accessibility tree, and the
// link carries the fuller name in aria-label — which contains the visible words, so the two agree
// for anyone driving the page by voice.
//
// The App Store button closes the masthead, under the subtitle: the band is what sells the app, so
// the one thing to do about it belongs inside the band rather than a scroll below it. It is Apple's
// own badge artwork (assets.ts) — the white variant, because the band is a dark background — and
// the artwork comes with rules: at least 40px tall, clear space around it of a quarter its height,
// and no redrawing it, recoloring it, adding effects to it, or setting the words beside it in live
// text. 50px tall clears the floor, and the 16px gap to the source button clears the 12.5px of
// space a 50px badge is owed; nothing here may grow into a text-shadow like the type above it. The
// art is 119.66x40, so the box is drawn at 3:1 and the SVG's own viewBox letterboxes the half-pixel
// rather than stretching it. The row centers the pair and wraps it to a column if a phone is too
// narrow to hold both, which keeps the badge at its full size rather than shrinking it to fit.
const HERO_CSS = `
  .hero {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    height: 480px; padding: 0 20px; text-align: center; color: #fff;
    background: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
      url(${img("sultana-1200.jpg")}) center top / cover no-repeat #0c2240;
  }
  @media (min-width: 801px) {
    .hero {
      background-image: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
        url(${img("sultana-2400.jpg")});
    }
  }
  @media (max-width: 600px) { .hero { height: 380px; } }
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
  .srcbtn { box-sizing: border-box; display: flex; align-items: center; justify-content: center;
    gap: 8px; width: 150px; height: 50px; border: 1px solid #000; border-radius: 6.5px;
    background: #fff; color: #000; font-size: 17px; font-weight: 500; text-decoration: none; }
  .srcbtn svg { width: 20px; height: 20px; fill: currentColor; }
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
// the listing's voice reads as two different pages arguing.
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
`;

// GitHub's `mark-github` octicon at 16px, as distributed. The fill is left to CSS (currentColor)
// and the drawing is hidden from screen readers, which read the link's aria-label instead.
const GITHUB_MARK = `<svg viewBox="0 0 16 16" aria-hidden=true><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;

// The masthead the shell hangs above the wrap. It carries the <h1> itself, which is why the shell
// draws none of its own for a page that brings a header.
const HERO = `<header class=hero>
  <div>
    <img class=appicon src="${img("icon-512.jpg")}" width=116 height=116 alt="">
    <h1>${BRAND}</h1>
    <p class=subtitle>Weather forecasts over satellite</p>
    <div class=badges>
      <a class=appbtn href="${APP_STORE_URL}"><img src="${img("appstore-badge-white.svg")}" width=150
        height=50 alt="Download on the App Store"></a>
      <a class=srcbtn href="${REPO_URL}" aria-label="View source on GitHub">${GITHUB_MARK}<span>View
        source</span></a>
    </div>
  </div>
  <p class=herocredit>Sultana from Denali, May 2026</p>
</header>`;

// The marketing copy is kept in step with the App Store listing's description — the two are read
// back to back by anyone deciding whether to install, so they should not tell different stories.
// The companion app is iOS-only and distributed through the App Store, which the page links to
// from the masthead itself, above everything here.
//
// The page is marketing only: the SMS consent language, the opt-out wording and the safety
// disclaimer live on /support, /privacy and /terms, reached through the footer. If an A2P 10DLC
// campaign review asks for consent language on the public site, it goes back here.
const LANDING_BODY = `
<p>${BRAND} is a weather app designed specifically for satellite messengers. It was built for a
Denali ski expedition with one goal: to get you all the weather information you would have at
home, wherever you are. ${BRAND} uses a custom compression codec and decoder app to pack hundreds
of forecast data points into a single message that can be sent over SMS, Garmin inReach, ZOLEO,
or iPhone satellite messaging.</p>

<div class=shots>
  <figure>
    <img src="${img("shot-mont-blanc.jpg")}" width=750 height=1630 loading=lazy
      alt="&ldquo;Detailed forecasts up to 13 days without cell reception&rdquo; — a thirteen-day
      Mont Blanc forecast, with hourly weather icons, temperature, snow, wind and gusts below it.">
  </figure>
  <figure>
    <img src="${img("shot-builder.jpg")}" width=750 height=1630 loading=lazy
      alt="&ldquo;30+ weather models over SMS, inReach, ZOLEO, and iPhone satellite&rdquo; — the
      forecast request builder, with location, priority, model and extra-variable choices above a
      device picker.">
  </figure>
  <figure>
    <img src="${img("shot-denali.jpg")}" width=750 height=1630 loading=lazy
      alt="&ldquo;High-altitude winds and freezing level forecasts for mountaineering&rdquo; — a
      Denali forecast showing freezing level and winds at 10, 14, 18 and 24 thousand feet.">
  </figure>
  <figure>
    <img src="${img("shot-cloud.jpg")}" width=750 height=1630 loading=lazy
      alt="&ldquo;Avoid whiteouts and flat light with detailed cloud cover&rdquo; — a forecast in
      Norway's Lyngen Alps with a clouds-by-altitude band from two to thirty thousand feet.">
  </figure>
  <figure>
    <img src="${img("shot-air-quality.jpg")}" width=750 height=1630 loading=lazy
      alt="&ldquo;Plan around wildfire smoke with air quality forecasts&rdquo; — a forecast with an
      air quality section listing AQI, the leading pollutant, and rows for PM2.5, PM10, ozone,
      nitrogen dioxide and sulfur dioxide.">
  </figure>
</div>

<h2>How it works</h2>
<ol>
  <li>Build a forecast request in the app. Choose the location, model, and variables that you
  care about.</li>
  <li>Send the forecast request to ${BRAND} via the internet, SMS, Garmin inReach, ZOLEO, or
  iPhone satellite messaging.</li>
  <li>Receive an encoded message from ${BRAND}. Paste it into the app to see a detailed
  forecast.</li>
</ol>

<h2>Features</h2>
<ul>
  <li>Works via the internet, SMS, Garmin inReach, ZOLEO, and iPhone satellite messaging.</li>
  <li>Uses a custom compression codec optimized for weather data that packs hundreds of data
  points into a single message. Choose between hourly detail and extended range up to 13
  days.</li>
  <li>Temperature, snow, rain, wind, and cloud cover included by default. Optional variables
  include pressure-level winds for high-altitude mountaineering, AQI for planning around wildfire
  smoke, detailed cloud cover with 8 levels, and freezing level.</li>
  <li>Weather forecasts from over 30 models including HRRR (3km), HRDPS (2.5km), ICON-D2 (2km),
  and MET Norway (1km). Automatically chooses the best model for your location.</li>
  <li>Compare forecasts from American, Canadian, and European forecast centers.</li>
  <li>All forecasts are saved on your device for comparing multiple models and past
  forecasts.</li>
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
