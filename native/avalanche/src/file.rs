//! The model file:
//!
//!   "GBNM"         magic
//!   u32 LE         format version
//!   u32 LE         header length in bytes
//!   header         UTF-8 JSON
//!   zero padding   to a multiple of 8
//!   arrays         each little-endian, 8-byte aligned, offsets relative to here
//!
//! The header holds the name; dim, layers and ffn; vocab (embedding rows) and codable (pieces
//! and END, the head's rows); fmt, the fixed-point constants; pieces as [piece, score, type]
//! (SentencePiece types: 1 normal, 2 unknown, 6 byte); markers, where markers[i] is token
//! codable + i; and arrays as name -> [dtype, offset, length], dtype i8 or i32.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::Error;

const MAGIC: &[u8; 4] = b"GBNM";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub(crate) struct Header {
    pub name: String,
    pub dim: usize,
    pub layers: usize,
    pub ffn: usize,
    pub vocab: usize,
    pub codable: usize,
    pub fmt: HashMap<String, i64>,
    pub pieces: Vec<(String, f64, u8)>,
    pub markers: Vec<String>,
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

pub(crate) struct ModelFile {
    pub header: Header,
    bytes: Vec<u8>,
    arrays_at: usize,
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, Error> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())).ok_or(Error::NotAModel)
}

impl ModelFile {
    pub fn parse(bytes: Vec<u8>) -> Result<ModelFile, Error> {
        if bytes.get(..4) != Some(MAGIC) {
            return Err(Error::NotAModel);
        }
        let version = u32_at(&bytes, 4)?;
        if version != FORMAT_VERSION {
            return Err(Error::Version(version));
        }
        let len = u32_at(&bytes, 8)? as usize;
        let text = bytes.get(12..12 + len).ok_or(Error::NotAModel)?;
        let header: Header = serde_json::from_slice(text).map_err(|e| Error::Model(format!("header: {e}")))?;
        if header.pieces.len() + 1 != header.codable || header.codable + header.markers.len() != header.vocab {
            return Err(Error::Model("pieces, markers and vocab disagree".into()));
        }
        let arrays_at = (12 + len).next_multiple_of(8);
        let file = ModelFile { header, bytes, arrays_at };
        for name in file.header.arrays.keys() {
            file.range(name)?;
        }
        Ok(file)
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

    fn range(&self, name: &str) -> Result<(&str, std::ops::Range<usize>), Error> {
        let (dtype, offset, n) = self.header.arrays.get(name).ok_or_else(|| Error::Model(format!("array {name} missing")))?;
        let width = match dtype.as_str() {
            "i8" => 1,
            "i32" => 4,
            _ => return Err(Error::Model(format!("array {name} has dtype {dtype}"))),
        };
        let start = self.arrays_at + offset;
        let end = start + n * width;
        if offset % 8 != 0 || end > self.bytes.len() {
            return Err(Error::Model(format!("array {name} is out of bounds or unaligned")));
        }
        Ok((dtype, start..end))
    }

    pub fn i8s(&self, name: &str) -> Result<Vec<i8>, Error> {
        match self.range(name)? {
            ("i8", r) => Ok(self.bytes[r].iter().map(|&b| b as i8).collect()),
            (dtype, _) => Err(Error::Model(format!("array {name} is {dtype}, not i8"))),
        }
    }

    pub fn i32s(&self, name: &str) -> Result<Vec<i64>, Error> {
        match self.range(name)? {
            ("i32", r) => Ok(self.bytes[r].chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap()) as i64).collect()),
            (dtype, _) => Err(Error::Model(format!("array {name} is {dtype}, not i32"))),
        }
    }
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
        let m = ModelFile::parse(file(HEADER, &arrays)).unwrap();
        assert_eq!(m.i8s("w.q").unwrap(), vec![1, -1, 3]);
        assert_eq!(m.i32s("w.mul").unwrap(), vec![7, -2]);
        assert_eq!(m.info().markers, 2);
    }

    #[test]
    fn rejects_truncated_arrays() {
        assert!(matches!(ModelFile::parse(file(HEADER, &[0; 8])), Err(Error::Model(_))));
    }

    #[test]
    fn rejects_other_files() {
        assert!(matches!(ModelFile::parse(b"PK\x03\x04".to_vec()), Err(Error::NotAModel)));
    }
}
