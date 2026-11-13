/**
 * Formatting marks in bulletin prose. A section's text is a plain string; these reserved
 * characters (private use, so no forecast contains them) carry its formatting:
 *
 *   BOLD ... BOLD_END, ITALIC ... ITALIC_END    around a run within one line
 *   INDENT* (ITEM | NUMBERED)                   at the start of a list item's line, one INDENT
 *                                               per nesting level below the first
 *
 * List items are separate paragraphs (blank line between). A numbered item's number is its
 * position among the numbered items before it at the same depth.
 */
export const BOLD = "";
export const BOLD_END = "";
export const ITALIC = "";
export const ITALIC_END = "";
export const ITEM = "";
export const NUMBERED = "";
export const INDENT = "";

const ANY = /[-]/g;

export function stripMarks(text: string): string {
  return text.replace(ANY, "");
}

export interface ProseRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface ProseBlock {
  // "" for a paragraph.
  list: "" | "bullet" | "numbered";
  // Nesting level of a list item, 0 for the first.
  depth: number;
  // A numbered item's number, else 0.
  number: number;
  // Lines of the block, each a list of runs.
  lines: ProseRun[][];
}

// The blocks of a section's text. Any string parses: styles are flags the marks switch, and
// every line starts unstyled.
export function parseMarks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  // Next number at each depth; a paragraph or a shallower item resets the deeper counters.
  const next: number[] = [];
  for (const para of text.split(/\n\n+/)) {
    if (!para) continue;
    const block: ProseBlock = { list: "", depth: 0, number: 0, lines: [] };
    let first = true;
    for (let line of para.split("\n")) {
      if (first) {
        const m = /^(*)([])/.exec(line);
        if (m) {
          block.list = m[2] === ITEM ? "bullet" : "numbered";
          block.depth = m[1].length;
          line = line.slice(m[0].length);
        }
        first = false;
      }
      const runs: ProseRun[] = [];
      let bold = false, italic = false, start = 0;
      const flush = (end: number) => {
        if (end > start) runs.push({ text: line.slice(start, end), bold, italic });
      };
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c < BOLD || c > INDENT) continue;
        flush(i);
        start = i + 1;
        if (c === BOLD) bold = true;
        else if (c === BOLD_END) bold = false;
        else if (c === ITALIC) italic = true;
        else if (c === ITALIC_END) italic = false;
      }
      flush(line.length);
      block.lines.push(runs);
    }
    if (block.list === "numbered") {
      next.length = block.depth + 1;
      block.number = next[block.depth] = (next[block.depth] ?? 0) + 1;
    } else {
      next.length = block.list ? block.depth + 1 : 0;
      if (block.list) next[block.depth] = 0;
    }
    blocks.push(block);
  }
  return blocks;
}
