use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

fn err(e: avalanche::Error) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct ModelInfo {
    pub name: String,
    pub dim: u32,
    pub layers: u32,
    pub ffn: u32,
    pub vocab: u32,
    pub codable: u32,
    pub pieces: u32,
    pub markers: u32,
    pub arrays: u32,
}

/// A forecast's prose with its context markers. To decode, give the same markers; texts are
/// ignored.
#[napi(object)]
pub struct Doc {
    pub markers: Vec<String>,
    pub sections: Vec<Section>,
}

#[napi(object)]
pub struct Section {
    pub markers: Vec<String>,
    pub text: Option<String>,
}

fn doc_of(d: Doc) -> avalanche::Doc {
    avalanche::Doc {
        markers: d.markers,
        sections: d.sections.into_iter().map(|s| avalanche::Section { markers: s.markers, text: s.text.unwrap_or_default() }).collect(),
    }
}

#[napi]
pub struct AvalancheModel {
    model: Arc<avalanche::Model>,
}

#[napi]
impl AvalancheModel {
    #[napi(constructor)]
    pub fn new(bytes: Buffer) -> napi::Result<Self> {
        Ok(AvalancheModel { model: Arc::new(avalanche::Model::load(bytes.to_vec()).map_err(err)?) })
    }

    #[napi]
    pub fn info(&self) -> ModelInfo {
        let i = self.model.info();
        ModelInfo {
            name: i.name.clone(),
            dim: i.dim as u32,
            layers: i.layers as u32,
            ffn: i.ffn as u32,
            vocab: i.vocab as u32,
            codable: i.codable as u32,
            pieces: i.pieces as u32,
            markers: i.markers as u32,
            arrays: i.arrays as u32,
        }
    }

    /// The prose as one rANS stream, with the tokens fed to the model, computed off the main thread.
    #[napi(ts_return_type = "Promise<Encoded>")]
    pub fn encode(&self, doc: Doc) -> AsyncTask<Encode> {
        AsyncTask::new(Encode { model: self.model.clone(), doc: doc_of(doc) })
    }

    /// The section texts of a stream, computed off the main thread.
    #[napi(ts_return_type = "Promise<string[]>")]
    pub fn decode(&self, bytes: Buffer, layout: Doc) -> AsyncTask<Decode> {
        AsyncTask::new(Decode { model: self.model.clone(), bytes: bytes.to_vec(), layout: doc_of(layout) })
    }
}

#[napi(object)]
pub struct Encoded {
    pub bytes: Buffer,
    pub steps: u32,
}

pub struct Encode {
    model: Arc<avalanche::Model>,
    doc: avalanche::Doc,
}

impl Task for Encode {
    type Output = (Vec<u8>, usize);
    type JsValue = Encoded;

    fn compute(&mut self) -> napi::Result<(Vec<u8>, usize)> {
        self.model.encode_counted(&self.doc).map_err(err)
    }

    fn resolve(&mut self, _env: Env, (bytes, steps): (Vec<u8>, usize)) -> napi::Result<Encoded> {
        Ok(Encoded { bytes: bytes.into(), steps: steps as u32 })
    }
}

pub struct Decode {
    model: Arc<avalanche::Model>,
    bytes: Vec<u8>,
    layout: avalanche::Doc,
}

impl Task for Decode {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Vec<String>> {
        self.model.decode(&self.bytes, &self.layout).map_err(err)
    }

    fn resolve(&mut self, _env: Env, out: Vec<String>) -> napi::Result<Vec<String>> {
        Ok(out)
    }
}
