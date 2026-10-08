import type { Context } from "hono";
import { CONTACT_EMAIL } from "../constants.js";
import { FAQ_CSS, FAQ_HTML } from "./faq.js";
import { PAGE } from "./shell.js";

// The App Store listing points its Support URL here rather than at the landing page: a reviewer
// checking that support exists should land on a page that is unambiguously support, and the
// landing page is marketing. Contact goes first, ahead of the FAQ the landing page also carries.
const SUPPORT_BODY = `
<div class=cta>
  <h2 style="margin-top:0">Get in touch</h2>
  <p><strong>Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></strong> with questions,
  bug reports, or anything the answers below don't cover.</p>
</div>

<h2>Frequently asked questions</h2>
${FAQ_HTML}
`;

// No "Last updated" stamp: that belongs on the legal documents, where the revision date carries
// meaning. On a support page it just looks stale the moment an answer stops changing.
export function support(c: Context) {
  return c.html(PAGE("Support", SUPPORT_BODY, { showUpdated: false, css: FAQ_CSS, path: "/support" }));
}
