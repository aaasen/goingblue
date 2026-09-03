import { img } from "../assets.js";
import { BRAND, LAST_UPDATED } from "../constants.js";

type PageOpts = { showUpdated?: boolean; updated?: string; header?: string; css?: string; head?: string };

// The shell every public page is served in: the document, the icons, the typographic defaults, the
// centered wrap, and the footer that carries the operator's name and the links between the pages.
// It knows nothing about any particular page — a page that wants more than prose brings it itself.
//
// `header` is raw HTML placed above the wrap, for a page whose heading is more than a line of type
// (the landing page's photo band). Passing one replaces the plain <h1>, which the page's own header
// is then responsible for carrying. `css` appends a page's own rules to the same <style> block,
// which is what lets a page with its own layout — the landing page's hero and screenshot strip, the
// stats dashboard's tables — share this shell instead of growing a second one. `head` is raw HTML
// appended to <head>, for a page that needs more than styles there (the stats map's stylesheet
// link).
//
// Text pages carry a brand bar pinned to the top of the viewport, the app icon beside the name,
// linking home, so a page reached from a store listing or a search result reads as Going Blue's
// wherever the reader is in it. It is sticky rather than fixed so the body needs no offset for it;
// scroll-padding keeps an in-page anchor from landing under it. The icon file is square, and the
// radius is 22.4% of the width, Apple's own icon proportion. A page that brings its own `header`
// (the landing masthead) replaces the bar along with the h1.
export const PAGE = (title: string, body: string, { showUpdated = true, updated = LAST_UPDATED, header, css, head }: PageOpts = {}) => `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<link rel=icon href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel=apple-touch-icon href="${img("icon-512.jpg")}">
<title>${title === BRAND ? BRAND : `${title} — ${BRAND}`}</title>
<style>
  html { scroll-padding-top: 64px; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; color: #1a1a1a; line-height: 1.55;
    overflow-x: clip; }
  .wrap { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.15em; margin-top: 1.8em; }
  .updated { color: #666; font-size: 0.9em; }
  .bar { position: sticky; top: 0; z-index: 1; background: #fff; border-bottom: 1px solid #ddd; }
  .bar .brand { display: flex; align-items: center; gap: 10px; max-width: 720px; margin: 0 auto;
    padding: 10px 20px; color: inherit; text-decoration: none; font-weight: 600; }
  .bar img { width: 32px; height: 32px; border-radius: 7px; }
  .cta { background: #f0f6fc; border: 1px solid #cfe2f5; border-radius: 8px; padding: 16px 20px; margin: 1.8em 0; }
  a { color: #0b62c4; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd; color: #666; font-size: 0.9em; }
${css ?? ""}</style>
${head ?? ""}</head>
<body>
${header ?? `<header class=bar><a class=brand href="/"><img src="${img("icon-512.jpg")}" width=32 height=32 alt="">${BRAND}</a></header>`}
<div class=wrap>
${header ? "" : `<h1>${title}</h1>`}
${showUpdated ? `<p class=updated>Last updated: ${updated}</p>` : ""}
${body}
<footer>
  ${BRAND} is operated as a sole proprietorship by Lane Aasen.<br>
  <a href="/">Home</a> · <a href="/support">Support</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
</footer>
</div>
</body>
</html>`;
