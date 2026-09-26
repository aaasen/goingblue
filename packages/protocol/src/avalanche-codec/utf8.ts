// UTF-8 to string without TextDecoder, which the app's JavaScript engine is not guaranteed to
// provide. The WHATWG decoder's algorithm, so malformed input decodes exactly as TextDecoder
// decodes it: one U+FFFD per broken sequence. Everything the codec writes is well formed.
export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  let cp = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) {
        out += String.fromCharCode(b);
      } else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0xf;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x7;
      } else {
        out += "�";
      }
      continue;
    }
    if (b < lower || b > upper) {
      // The sequence breaks here; this byte starts over.
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      out += "�";
      i--;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen === needed) {
      out += String.fromCodePoint(cp);
      cp = needed = seen = 0;
    }
  }
  if (needed !== 0) out += "�";
  return out;
}
