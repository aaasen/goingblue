//! SentencePiece BPE with identity normalization, no dummy prefix, and byte fallback. Spaces become U+2581; adjacent symbols merge, highest-scoring piece first and
//! leftmost among equal scores, until no adjacent pair is a piece; a symbol that is not a piece
//! is coded as its UTF-8 bytes.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::Error;

const NORMAL: u8 = 1;
const BYTE: u8 = 6;

pub(crate) struct Tokenizer {
    pieces: Vec<(String, f64, u8)>,
    ids: HashMap<String, usize>,
    // The piece id of byte b.
    bytes: [usize; 256],
}

// A candidate merge of the symbols starting at `left` and `right`.
struct Cand {
    score: f64,
    left: usize,
    right: usize,
    len: usize,
}

impl PartialEq for Cand {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for Cand {}
impl PartialOrd for Cand {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Cand {
    // Highest score first, then leftmost.
    fn cmp(&self, o: &Self) -> Ordering {
        self.score.total_cmp(&o.score).then(o.left.cmp(&self.left))
    }
}

impl Tokenizer {
    pub fn new(pieces: Vec<(String, f64, u8)>) -> Result<Tokenizer, Error> {
        let mut ids = HashMap::new();
        let mut bytes = [usize::MAX; 256];
        for (i, (p, _, t)) in pieces.iter().enumerate() {
            match *t {
                NORMAL => {
                    ids.insert(p.clone(), i);
                }
                BYTE => {
                    let b = p.strip_prefix("<0x").and_then(|h| h.strip_suffix('>')).and_then(|h| u8::from_str_radix(h, 16).ok());
                    let b = b.ok_or_else(|| Error::Model(format!("byte piece {p}")))?;
                    bytes[b as usize] = i;
                }
                _ => {}
            }
        }
        if bytes.contains(&usize::MAX) {
            return Err(Error::Model("the pieces lack a byte".into()));
        }
        Ok(Tokenizer { pieces, ids, bytes })
    }

    pub fn encode(&self, text: &str) -> Vec<usize> {
        // Symbols as byte ranges of the normalized text, linked left to right.
        let norm: String = text.chars().map(|c| if c == ' ' { '\u{2581}' } else { c }).collect();
        let starts: Vec<usize> = norm.char_indices().map(|(i, _)| i).collect();
        let n = starts.len();
        let mut end: Vec<usize> = (0..n).map(|i| starts.get(i + 1).copied().unwrap_or(norm.len())).collect();
        let mut next: Vec<usize> = (1..=n).collect();
        let mut prev: Vec<usize> = (0..n).map(|i| i.wrapping_sub(1)).collect();
        let mut alive = vec![true; n];
        let mut heap = BinaryHeap::new();
        let push = |heap: &mut BinaryHeap<Cand>, l: usize, r: usize, end: &[usize]| {
            if let Some(&id) = self.ids.get(&norm[starts[l]..end[r]]) {
                heap.push(Cand { score: self.pieces[id].1, left: l, right: r, len: end[r] - starts[l] });
            }
        };
        for i in 0..n.saturating_sub(1) {
            push(&mut heap, i, i + 1, &end);
        }
        while let Some(c) = heap.pop() {
            // Stale unless both symbols are unchanged and still adjacent.
            if !alive[c.left] || !alive[c.right] || next[c.left] != c.right || end[c.right] - starts[c.left] != c.len {
                continue;
            }
            end[c.left] = end[c.right];
            alive[c.right] = false;
            next[c.left] = next[c.right];
            if next[c.left] < n {
                prev[next[c.left]] = c.left;
                push(&mut heap, c.left, next[c.left], &end);
            }
            if prev[c.left] != usize::MAX {
                push(&mut heap, prev[c.left], c.left, &end);
            }
        }
        let mut out = Vec::new();
        let mut i = 0;
        while i < n {
            let sym = &norm[starts[i]..end[i]];
            match self.ids.get(sym) {
                Some(&id) => out.push(id),
                None => out.extend(sym.bytes().map(|b| self.bytes[b as usize])),
            }
            i = next[i];
        }
        out
    }

    pub fn decode(&self, ids: &[usize]) -> Result<String, Error> {
        let mut bytes = Vec::new();
        for &id in ids {
            let (p, _, t) = &self.pieces[id];
            if *t == BYTE {
                bytes.push(self.bytes.iter().position(|&b| b == id).unwrap() as u8);
            } else {
                bytes.extend(p.replace('\u{2581}', " ").bytes());
            }
        }
        String::from_utf8(bytes).map_err(|_| Error::Stream("decoded text is not UTF-8".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok() -> Tokenizer {
        let mut pieces = vec![("<unk>".to_string(), 0.0, 2)];
        pieces.extend((0..256).map(|b| (format!("<0x{b:02X}>"), 0.0, BYTE)));
        for (p, s) in [("a", -1.0), ("b", -1.0), ("ab", -2.0), ("ba", -2.0), ("\u{2581}", -1.0), ("\u{2581}a", -3.0)] {
            pieces.push((p.to_string(), s, NORMAL));
        }
        Tokenizer::new(pieces).unwrap()
    }

    #[test]
    fn merges_leftmost_on_ties_and_falls_back_to_bytes() {
        let t = tok();
        let ids = t.encode("aba é");
        let pieces: Vec<&str> = ids.iter().map(|&i| t.pieces[i].0.as_str()).collect();
        assert_eq!(pieces, ["ab", "a", "\u{2581}", "<0xC3>", "<0xA9>"]);
        assert_eq!(t.decode(&ids).unwrap(), "aba é");
    }

    #[test]
    fn rejects_broken_utf8() {
        let t = tok();
        assert!(t.decode(&[t.bytes[0xC3]]).is_err());
    }
}
