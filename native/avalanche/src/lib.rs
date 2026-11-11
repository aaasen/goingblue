//! The avalanche forecast prose model. The model file layout is specified in
//! avalanche/quant.py `write_model`.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 4] = b"GBNM";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug)]
pub enum Error {
    NotAModel,
    Version(u32),
    Header(String),
    Array(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotAModel => write!(f, "not a GBNM model file"),
            Error::Version(v) => write!(f, "model format version {v}, expected {FORMAT_VERSION}"),
            Error::Header(e) => write!(f, "bad model header: {e}"),
            Error::Array(e) => write!(f, "bad model array: {e}"),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Deserialize)]
struct Header {
    name: String,
    dim: usize,
    layers: usize,
    ffn: usize,
    vocab: usize,
    codable: usize,
    fmt: HashMap<String, i64>,
    pieces: Vec<(String, f64, u8)>,
    markers: Vec<String>,
    arrays: HashMap<String, (String, usize, usize)>,
}

/// What a model file holds, without its arrays.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub dim: usize,
    pub layers: usize,
    pub ffn: usize,
    pub vocab: usize,
    pub codable: usize,
    pub pieces: usize,
    pub markers: usize,
    pub arrays: usize,
}

/// A model file read into memory. Arrays are views into the file's bytes.
pub struct Model {
    header: Header,
    bytes: Vec<u8>,
    arrays_at: usize,
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, Error> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())).ok_or(Error::NotAModel)
}

impl Model {
    pub fn parse(bytes: Vec<u8>) -> Result<Model, Error> {
        if bytes.get(..4) != Some(MAGIC) {
            return Err(Error::NotAModel);
        }
        let version = u32_at(&bytes, 4)?;
        if version != FORMAT_VERSION {
            return Err(Error::Version(version));
        }
        let len = u32_at(&bytes, 8)? as usize;
        let text = bytes.get(12..12 + len).ok_or(Error::NotAModel)?;
        let header: Header = serde_json::from_slice(text).map_err(|e| Error::Header(e.to_string()))?;
        if header.pieces.len() + 1 != header.codable || header.codable + header.markers.len() != header.vocab {
            return Err(Error::Header("pieces, markers and vocab disagree".into()));
        }
        let arrays_at = (12 + len).next_multiple_of(8);
        let model = Model { header, bytes, arrays_at };
        for name in model.header.arrays.keys() {
            model.range(name)?;
        }
        Ok(model)
    }

    pub fn info(&self) -> ModelInfo {
        let h = &self.header;
        ModelInfo {
            name: h.name.clone(),
            dim: h.dim,
            layers: h.layers,
            ffn: h.ffn,
            vocab: h.vocab,
            codable: h.codable,
            pieces: h.pieces.len(),
            markers: h.markers.len(),
            arrays: h.arrays.len(),
        }
    }

    /// A fixed-point constant the file was exported with.
    pub fn fmt(&self, key: &str) -> Option<i64> {
        self.header.fmt.get(key).copied()
    }

    fn range(&self, name: &str) -> Result<(&str, std::ops::Range<usize>), Error> {
        let (dtype, offset, n) = self.header.arrays.get(name).ok_or_else(|| Error::Array(format!("{name} missing")))?;
        let width = match dtype.as_str() {
            "i8" => 1,
            "i32" => 4,
            _ => return Err(Error::Array(format!("{name} has dtype {dtype}"))),
        };
        let start = self.arrays_at + offset;
        let end = start + n * width;
        if offset % 8 != 0 || end > self.bytes.len() {
            return Err(Error::Array(format!("{name} is out of bounds or unaligned")));
        }
        Ok((dtype, start..end))
    }

    pub fn i8s(&self, name: &str) -> Result<&[i8], Error> {
        match self.range(name)? {
            ("i8", r) => Ok(bytemuck_i8(&self.bytes[r])),
            (dtype, _) => Err(Error::Array(format!("{name} is {dtype}, not i8"))),
        }
    }

    pub fn i32s(&self, name: &str) -> Result<Vec<i32>, Error> {
        match self.range(name)? {
            ("i32", r) => Ok(self.bytes[r].chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect()),
            (dtype, _) => Err(Error::Array(format!("{name} is {dtype}, not i32"))),
        }
    }
}

fn bytemuck_i8(b: &[u8]) -> &[i8] {
    // SAFETY: u8 and i8 have the same size and alignment.
    unsafe { std::slice::from_raw_parts(b.as_ptr().cast(), b.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(header: &str, arrays: &[u8]) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend(FORMAT_VERSION.to_le_bytes());
        b.extend((header.len() as u32).to_le_bytes());
        b.extend(header.as_bytes());
        b.resize(b.len().next_multiple_of(8), 0);
        b.extend(arrays);
        b
    }

    const HEADER: &str = r#"{"name":"t","dim":2,"layers":1,"ffn":4,"vocab":4,"codable":2,"fmt":{"FX":12},
        "pieces":[["a",0.0,1]],"markers":["center:x","kind:y"],
        "arrays":{"w.q":["i8",0,3],"w.mul":["i32",8,2]}}"#;

    #[test]
    fn reads_arrays() {
        let mut arrays = vec![1u8, 0xff, 3, 0, 0, 0, 0, 0];
        arrays.extend(7i32.to_le_bytes());
        arrays.extend((-2i32).to_le_bytes());
        let m = Model::parse(file(HEADER, &arrays)).unwrap();
        assert_eq!(m.i8s("w.q").unwrap(), &[1, -1, 3]);
        assert_eq!(m.i32s("w.mul").unwrap(), vec![7, -2]);
        assert_eq!(m.fmt("FX"), Some(12));
        assert_eq!(m.info().markers, 2);
    }

    #[test]
    fn rejects_truncated_arrays() {
        assert!(matches!(Model::parse(file(HEADER, &[0; 8])), Err(Error::Array(_))));
    }

    #[test]
    fn rejects_other_files() {
        assert!(matches!(Model::parse(b"PK\x03\x04".to_vec()), Err(Error::NotAModel)));
    }

    // The exported model, when data/neural has one.
    #[test]
    fn reads_exported_model() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/neural/s384c.int.bin");
        let Ok(bytes) = std::fs::read(path) else { return };
        let m = Model::parse(bytes).unwrap();
        let info = m.info();
        assert_eq!((info.dim, info.layers, info.codable, info.markers), (384, 6, 8001, 189));
        assert_eq!(m.i8s("head.q").unwrap().len(), 8001 * 384);
    }
}
