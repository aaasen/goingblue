/**
 * Bulletin prose. The API delivers every text field as an HTML fragment; the codec models plain
 * text with formatting marks (see marks.ts in the protocol), and htmlToText is the one place HTML
 * is turned into the strings that get compressed.
 */
import { BOLD, BOLD_END, INDENT, ITALIC, ITALIC_END, ITEM, NUMBERED, stripMarks } from "@weather/protocol";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  deg: "°", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? stripMarks(String.fromCodePoint(code)) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Tags to marks and breaks: <br> is a line break, block-level closers are paragraph breaks, bold
// and italic tags (and spans styled so) become marks, a list item starts with its marks, a
// heading is a bold paragraph, and every other tag disappears.
function markTags(html: string): string {
  const lists: string[] = [];
  const spans: string[] = [];
  // Plain <br>s first, so one inside another tag's attribute does not end that tag early.
  return html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>/gi, (_, close: string, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return close ? BOLD_END : BOLD;
    if (tag === "em" || tag === "i") return close ? ITALIC_END : ITALIC;
    if (tag === "span") {
      if (close) return spans.pop() ?? "";
      const bold = /font-weight\s*:\s*(bold|[6-9]00)/i.test(attrs), italic = /font-style\s*:\s*italic/i.test(attrs);
      spans.push((italic ? ITALIC_END : "") + (bold ? BOLD_END : ""));
      return (bold ? BOLD : "") + (italic ? ITALIC : "");
    }
    if (/^h\d$/.test(tag)) return close ? BOLD_END + "\n\n" : BOLD;
    if (tag === "ul" || tag === "ol") {
      if (close) lists.pop(); else lists.push(tag);
      return close ? "" : "\n\n";
    }
    if (tag === "li") {
      if (close) return "\n\n";
      return INDENT.repeat(Math.max(0, lists.length - 1)) + (lists[lists.length - 1] === "ol" ? NUMBERED : ITEM);
    }
    if (close && (tag === "p" || tag === "div" || tag === "tr")) return "\n\n";
    return "";
  }).replace(/<[^>]+>/g, "");
}

const SPACE = /[ \t\r\f\v]/;

// The canonical form of marked text. Whitespace collapses within lines and blank runs collapse to
// one blank line, as if the marks were not there. A style run never crosses a line, never starts
// or ends with a space, and is never empty; a list item's marks start its paragraph.
function canonical(s: string): string {
  interface Line { prefix: string; chars: string[]; styles: number[] }
  const fresh = (): Line => ({ prefix: "", chars: [], styles: [] });
  const lines: Line[] = [fresh()];
  let bold = 0, italic = 0;
  for (const c of s) {
    let line = lines[lines.length - 1];
    if (c === "\n") lines.push(fresh());
    else if (c === BOLD) bold++;
    else if (c === BOLD_END) bold = Math.max(0, bold - 1);
    else if (c === ITALIC) italic++;
    else if (c === ITALIC_END) italic = Math.max(0, italic - 1);
    else if (c === INDENT || c === ITEM || c === NUMBERED) {
      // An item's marks open a paragraph, also after text that no break ended.
      if (line.chars.some((x) => x.trim()) || /[\uE004\uE005]/.test(line.prefix)) {
        lines.push(fresh(), fresh());
        line = lines[lines.length - 1];
      }
      line.prefix += c;
    } else {
      line.chars.push(c);
      line.styles.push((bold ? 1 : 0) | (italic ? 2 : 0));
    }
  }
  const out = lines.map((line) => {
    // Collapse and trim.
    const chars: string[] = [], styles: number[] = [];
    line.chars.forEach((c, i) => {
      const space = SPACE.test(c);
      if (space && chars.length && chars[chars.length - 1] === " ") return;
      chars.push(space ? " " : c);
      styles.push(line.styles[i]);
    });
    let a = 0, b = chars.length;
    while (a < b && !chars[a].trim()) a++;
    while (b > a && !chars[b - 1].trim()) b--;
    if (a === b) return "";
    // Whitespace takes only the styles both its neighbors share.
    for (let i = a; i < b; i++) {
      if (chars[i].trim()) continue;
      let j = i;
      while (!chars[j].trim()) j++;
      const shared = styles[i - 1] & styles[j];
      for (; i < j; i++) styles[i] = shared;
    }
    let text = /[\uE004\uE005]$/.test(line.prefix) ? line.prefix : "";
    let cur = 0;
    for (let i = a; i <= b; i++) {
      const next = i < b ? styles[i] : 0;
      if (cur & ~next & 2) text += ITALIC_END;
      if (cur & ~next & 1) text += BOLD_END;
      if (next & ~cur & 1) text += BOLD;
      if (next & ~cur & 2) text += ITALIC;
      cur = next;
      if (i < b) text += chars[i];
    }
    return text;
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return canonical(decodeEntities(markTags(stripMarks(html))).replace(/\u00a0/g, " "));
}
