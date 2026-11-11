use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

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

#[napi]
pub fn model_info(bytes: Buffer) -> napi::Result<ModelInfo> {
    let m = avalanche::Model::parse(bytes.to_vec()).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let i = m.info();
    Ok(ModelInfo {
        name: i.name,
        dim: i.dim as u32,
        layers: i.layers as u32,
        ffn: i.ffn as u32,
        vocab: i.vocab as u32,
        codable: i.codable as u32,
        pieces: i.pieces as u32,
        markers: i.markers as u32,
        arrays: i.arrays as u32,
    })
}
