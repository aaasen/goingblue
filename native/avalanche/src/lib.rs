//! The avalanche forecast prose model: the model file, integer RWKV-4 inference, the tokenizer,
//! and rANS, so that every platform encodes and decodes the same bytes.
//!
//! A forecast is one token sequence: the document's markers, then for each section its markers,
//! its text pieces and END. Markers are context both sides know, given by name; names the model
//! does not know are dropped on both sides. Pieces and END are coded, each under the model's
//! prediction after every token before it.

mod file;
mod rans;
mod rwkv;
mod tokenizer;

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

pub use file::{FORMAT_VERSION, ModelInfo};

// A section longer than this decodes as an error rather than running on through garbage.
const MAX_SECTION_TOKENS: usize = 16384;

#[derive(Debug)]
pub enum Error {
    NotAModel,
    Version(u32),
    Model(String),
    Input(String),
    Stream(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotAModel => write!(f, "not a GBNM model file"),
            Error::Version(v) => write!(f, "model format version {v}, expected {FORMAT_VERSION}"),
            Error::Model(e) => write!(f, "bad model: {e}"),
            Error::Input(e) => write!(f, "bad input: {e}"),
            Error::Stream(e) => write!(f, "bad stream: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// A forecast's prose with its context. To decode, give the same markers with the texts empty.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Doc {
    pub markers: Vec<String>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Section {
    pub markers: Vec<String>,
    #[serde(default)]
    pub text: String,
}

pub struct Model {
    info: ModelInfo,
    rwkv: rwkv::Rwkv,
    tokenizer: tokenizer::Tokenizer,
    markers: HashMap<String, usize>,
}

// Feeds tokens one step behind, so a coded symbol's table comes from every token before it.
struct Runner<'a> {
    rwkv: &'a rwkv::Rwkv,
    state: rwkv::State,
    pending: Option<usize>,
    freqs: Vec<u32>,
}

impl Runner<'_> {
    fn marker(&mut self, m: usize) {
        if let Some(p) = self.pending.replace(m) {
            self.rwkv.step(&mut self.state, p, None);
        }
    }

    // The table for the next symbol, which the caller then passes to `coded`.
    fn predict(&mut self) -> Result<&[u32], Error> {
        let p = self.pending.take().ok_or_else(|| Error::Input("the first token must be a marker".into()))?;
        self.rwkv.step(&mut self.state, p, Some(&mut self.freqs));
        Ok(&self.freqs)
    }

    fn coded(&mut self, sym: usize) {
        self.pending = Some(sym);
    }
}

impl Model {
    pub fn load(bytes: Vec<u8>) -> Result<Model, Error> {
        let f = file::ModelFile::parse(bytes)?;
        let rwkv = rwkv::Rwkv::load(&f)?;
        let codable = f.header.codable;
        let markers = f.header.markers.iter().enumerate().map(|(i, m)| (m.clone(), codable + i)).collect();
        let info = f.info();
        let tokenizer = tokenizer::Tokenizer::new(f.header.pieces)?;
        Ok(Model { info, rwkv, tokenizer, markers })
    }

    pub fn info(&self) -> &ModelInfo {
        &self.info
    }

    fn end(&self) -> usize {
        self.rwkv.codable - 1
    }

    fn marker_ids(&self, names: &[String]) -> Vec<usize> {
        names.iter().filter_map(|n| self.markers.get(n).copied()).collect()
    }

    fn runner(&self) -> Runner<'_> {
        Runner { rwkv: &self.rwkv, state: self.rwkv.state(), pending: None, freqs: vec![0; self.rwkv.codable] }
    }

    /// The text of `doc` as one rANS stream.
    pub fn encode(&self, doc: &Doc) -> Result<Vec<u8>, Error> {
        let mut run = self.runner();
        let mut steps = Vec::new();
        for m in self.marker_ids(&doc.markers) {
            run.marker(m);
        }
        for s in &doc.sections {
            for m in self.marker_ids(&s.markers) {
                run.marker(m);
            }
            let mut toks = self.tokenizer.encode(&s.text);
            if toks.len() >= MAX_SECTION_TOKENS {
                return Err(Error::Input(format!("a section of {} tokens is over the limit", toks.len())));
            }
            toks.push(self.end());
            for t in toks {
                let freqs = run.predict()?;
                steps.push((freqs[..t].iter().sum(), freqs[t]));
                run.coded(t);
            }
        }
        Ok(rans::encode(&steps))
    }

    /// How many tokens `encode` feeds the model for `doc`: the work encoding it takes.
    pub fn steps(&self, doc: &Doc) -> usize {
        let sections = doc.sections.iter().map(|s| self.marker_ids(&s.markers).len() + self.tokenizer.encode(&s.text).len() + 1);
        self.marker_ids(&doc.markers).len() + sections.sum::<usize>()
    }

    /// The section texts of a stream `encode` wrote for a doc with these markers.
    pub fn decode(&self, bytes: &[u8], layout: &Doc) -> Result<Vec<String>, Error> {
        let mut run = self.runner();
        let mut dec = rans::Decoder::new(bytes)?;
        for m in self.marker_ids(&layout.markers) {
            run.marker(m);
        }
        let mut out = Vec::new();
        for s in &layout.sections {
            for m in self.marker_ids(&s.markers) {
                run.marker(m);
            }
            let mut toks = Vec::new();
            loop {
                let sym = dec.get(run.predict()?)?;
                run.coded(sym);
                if sym == self.end() {
                    break;
                }
                if toks.len() == MAX_SECTION_TOKENS {
                    return Err(Error::Stream("a section runs past the token limit".into()));
                }
                toks.push(sym);
            }
            out.push(self.tokenizer.decode(&toks)?);
        }
        dec.finish()?;
        Ok(out)
    }

    /// Feeds `tokens` (piece, END and marker ids) and returns the frequency table after each
    /// token but the last, for conformance tests against the exported test vectors.
    pub fn tables(&self, tokens: &[usize]) -> Result<Vec<Vec<u32>>, Error> {
        if let Some(&t) = tokens.iter().find(|&&t| t >= self.rwkv.vocab) {
            return Err(Error::Input(format!("token {t} is out of range")));
        }
        let mut state = self.rwkv.state();
        let mut out = Vec::new();
        for &t in &tokens[..tokens.len().saturating_sub(1)] {
            let mut freqs = vec![0; self.rwkv.codable];
            self.rwkv.step(&mut state, t, Some(&mut freqs));
            out.push(freqs);
        }
        Ok(out)
    }

    /// The pieces of `text`, for comparing tokenizers.
    pub fn tokenize(&self, text: &str) -> Vec<usize> {
        self.tokenizer.encode(text)
    }
}
