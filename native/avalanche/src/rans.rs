//! rANS over the model's frequency tables: totals of 2^24, state in [2^32, 2^40), renormalized a
//! byte at a time, flushed in 5 bytes.
//!
//! As in the protocol's coder (packages/protocol/src/avalanche-codec/rans.ts): the encoder walks
//! its symbols backwards and reverses its output; reads past the end of the buffer are zeros, so
//! a transport that drops trailing zero bytes loses nothing, and more than OVERRUN_LIMIT of them
//! means the bytes are not a stream; a stream decoded to its end leaves the state where the
//! encoder started, with every byte consumed.

use crate::Error;
use crate::rwkv::SCALE_BITS;

const SCALE: u64 = 1 << SCALE_BITS;
const L: u64 = 1 << 32;
const FLUSH: usize = 5;
const OVERRUN_LIMIT: usize = 8;

/// Encodes (start, freq) decisions given in decode order.
pub(crate) fn encode(steps: &[(u32, u32)]) -> Vec<u8> {
    let mut x = L;
    let mut out = Vec::new();
    for &(start, freq) in steps.iter().rev() {
        let (start, freq) = (start as u64, freq as u64);
        let x_max = ((L >> SCALE_BITS) << 8) * freq;
        while x >= x_max {
            out.push(x as u8);
            x >>= 8;
        }
        x = ((x / freq) << SCALE_BITS) + x % freq + start;
    }
    for _ in 0..FLUSH {
        out.push(x as u8);
        x >>= 8;
    }
    debug_assert_eq!(x, 0);
    out.reverse();
    out
}

pub(crate) struct Decoder<'a> {
    buf: &'a [u8],
    pos: usize,
    x: u64,
}

impl<'a> Decoder<'a> {
    pub fn new(buf: &'a [u8]) -> Result<Decoder<'a>, Error> {
        let mut d = Decoder { buf, pos: 0, x: 0 };
        for _ in 0..FLUSH {
            d.x = d.x << 8 | d.next()?;
        }
        Ok(d)
    }

    fn next(&mut self) -> Result<u64, Error> {
        if self.pos >= self.buf.len() + OVERRUN_LIMIT {
            return Err(Error::Stream("read past the end of the stream".into()));
        }
        let b = self.buf.get(self.pos).copied().unwrap_or(0);
        self.pos += 1;
        Ok(b as u64)
    }

    /// Reads one symbol under `freqs`, which sum to 2^24.
    pub fn get(&mut self, freqs: &[u32]) -> Result<usize, Error> {
        let slot = self.x & (SCALE - 1);
        let (mut i, mut start) = (0, 0u64);
        while start + freqs[i] as u64 <= slot {
            start += freqs[i] as u64;
            i += 1;
        }
        self.x = freqs[i] as u64 * (self.x >> SCALE_BITS) + slot - start;
        while self.x < L {
            self.x = self.x << 8 | self.next()?;
        }
        Ok(i)
    }

    pub fn finish(&self) -> Result<(), Error> {
        if self.x != L || self.buf.get(self.pos..).is_some_and(|rest| rest.iter().any(|&b| b != 0)) {
            return Err(Error::Stream("stream did not end cleanly".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let tables: Vec<Vec<u32>> = vec![vec![1, (1 << 24) - 2, 1], vec![1 << 23, 1 << 22, 1 << 22], vec![(1 << 24) - 1, 1]];
        let symbols = [0usize, 1, 2, 1, 0, 0, 1, 2, 2, 0, 1];
        let steps: Vec<(u32, u32)> = symbols.iter().enumerate().map(|(k, &s)| {
            let t = &tables[k % tables.len()];
            let s = s.min(t.len() - 1);
            (t[..s].iter().sum(), t[s])
        }).collect();
        let mut bytes = encode(&steps);
        while bytes.last() == Some(&0) {
            bytes.pop();
        }
        let mut d = Decoder::new(&bytes).unwrap();
        for (k, &s) in symbols.iter().enumerate() {
            let t = &tables[k % tables.len()];
            assert_eq!(d.get(t).unwrap(), s.min(t.len() - 1));
        }
        d.finish().unwrap();
    }
}
