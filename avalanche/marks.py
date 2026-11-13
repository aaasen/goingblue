"""
Formatting marks in section text (marks.ts in the protocol) and the readable tags the teacher
sees in their place. repair() brings the marks of a teacher sample to the form htmlToText writes.
"""
import re

BOLD, BOLD_END, ITALIC, ITALIC_END, ITEM, NUMBERED, INDENT = MARKS = ""
MARK_NAMES = ["bold", "bold end", "italic", "italic end", "item", "numbered", "indent"]
# No forecast contains these strings.
TAGS = ["<b>", "</b>", "<i>", "</i>", "<li>", "<nli>", "<in>"]

_MARK = re.compile("[-]")
_TAG = re.compile("|".join(re.escape(t) for t in TAGS))
# What JavaScript's trim() removes.
_WS = set("\t\n\v\f\r       　﻿") | {chr(c) for c in range(0x2000, 0x200b)}


def to_tags(text):
    return _MARK.sub(lambda m: TAGS[MARKS.index(m.group())], text)


def from_tags(text):
    """Marked text from text with tags; marks already present are dropped."""
    return repair(_TAG.sub(lambda m: MARKS[TAGS.index(m.group())], _MARK.sub("", text)))


def repair(s):
    """The marks of s in the form htmlToText writes, with every other character untouched: a style
    run never crosses a line, never starts or ends with whitespace and is never empty, and list
    marks stay only at the start of a line."""
    out = []
    bold = italic = 0
    for line in s.split("\n"):
        prefix, chars, styles = "", [], []
        for c in line:
            if c == BOLD:
                bold += 1
            elif c == BOLD_END:
                bold = max(0, bold - 1)
            elif c == ITALIC:
                italic += 1
            elif c == ITALIC_END:
                italic = max(0, italic - 1)
            elif c in (INDENT, ITEM, NUMBERED):
                if not chars and prefix[-1:] in ("", INDENT):
                    prefix += c
            else:
                chars.append(c)
                styles.append((1 if bold else 0) | (2 if italic else 0))
        n = len(chars)
        i = 0
        while i < n:
            if chars[i] not in _WS:
                i += 1
                continue
            j = i
            while j < n and chars[j] in _WS:
                j += 1
            shared = styles[i - 1] & styles[j] if i > 0 and j < n else 0
            styles[i:j] = [shared] * (j - i)
            i = j
        text = [prefix if prefix[-1:] in (ITEM, NUMBERED) and any(c not in _WS for c in chars) else ""]
        cur = 0
        for i in range(n + 1):
            nxt = styles[i] if i < n else 0
            if cur & ~nxt & 2: text.append(ITALIC_END)
            if cur & ~nxt & 1: text.append(BOLD_END)
            if nxt & ~cur & 1: text.append(BOLD)
            if nxt & ~cur & 2: text.append(ITALIC)
            cur = nxt
            if i < n:
                text.append(chars[i])
        out.append("".join(text))
    return "\n".join(out)


if __name__ == "__main__":
    # Every corpus text is already canonical and survives the trip through tags.
    import json, sys
    n = bad = 0
    for l in open(sys.argv[1]):
        for s in json.loads(l)["sections"]:
            n += 1
            if repair(s["text"]) != s["text"] or from_tags(to_tags(s["text"])) != s["text"]:
                bad += 1
                if bad <= 3:
                    print(repr(s["text"][:200]), "\n ->", repr(repair(s["text"])[:200]))
    print(f"{n} sections, {bad} not canonical")
