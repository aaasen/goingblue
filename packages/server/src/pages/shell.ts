import { img } from "../assets.js";
import { BRAND, LAST_UPDATED } from "../constants.js";

type PageOpts = { showUpdated?: boolean; header?: string; css?: string };

// The shell every public page is served in: the document, the icons, the typographic defaults, the
// centered wrap, and the footer that carries the operator's name and the links between the pages.
// It knows nothing about any particular page — a page that wants more than prose brings it itself.
//
// `header` is raw HTML placed above the wrap, for a page whose heading is more than a line of type
// (the landing page's photo band). Passing one replaces the plain <h1>, which the page's own header
// is then responsible for carrying. `css` appends a page's own rules to the same <style> block,
// which is what lets a page with its own layout — the landing page's hero and screenshot strip, the
// stats dashboard's tables — share this shell instead of growing a second one.
export const PAGE = (title: string, body: string, { showUpdated = true, header, css }: PageOpts = {}) => `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<link rel=icon href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel=apple-touch-icon href="${img("icon-512.jpg")}">
<title>${title === BRAND ? BRAND : `${title} — ${BRAND}`}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; color: #1a1a1a; line-height: 1.55;
    overflow-x: clip; }
  .wrap { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.15em; margin-top: 1.8em; }
  .updated { color: #666; font-size: 0.9em; }
  .cta { background: #f0f6fc; border: 1px solid #cfe2f5; border-radius: 8px; padding: 16px 20px; margin: 1.8em 0; }
  a { color: #0b62c4; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd; color: #666; font-size: 0.9em; }
${css ?? ""}</style>
</head>
<body>
${header ?? ""}
<div class=wrap>
${header ? "" : `<h1>${title}</h1>`}
${showUpdated ? `<p class=updated>Last updated: ${LAST_UPDATED}</p>` : ""}
${body}
<footer>
  ${BRAND} is operated as a sole proprietorship by Lane Aasen.<br>
  <a href="/">Home</a> · <a href="/support">Support</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a>
</footer>
</div>
</body>
</html>`;
