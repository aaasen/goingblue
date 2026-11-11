//! The app's bindings: a C ABI that Swift calls (include/avalanche.h) and JNI functions that
//! Kotlin calls. Each call names the model file; a file is loaded once and kept. Requests and
//! results cross as JSON, results as {"ok": ...} or {"error": "..."}.

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

static MODELS: Mutex<Option<HashMap<String, Arc<avalanche::Model>>>> = Mutex::new(None);

fn model(path: &str) -> Result<Arc<avalanche::Model>, String> {
    if let Some(m) = MODELS.lock().unwrap().get_or_insert_default().get(path) {
        return Ok(m.clone());
    }
    // Loaded outside the lock, so other models stay usable meanwhile.
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let m = Arc::new(avalanche::Model::load(bytes).map_err(|e| e.to_string())?);
    Ok(MODELS.lock().unwrap().get_or_insert_default().entry(path.to_string()).or_insert(m).clone())
}

fn respond(result: Result<Value, String>) -> String {
    match result {
        Ok(v) => json!({ "ok": v }).to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

fn model_info(path: &str) -> String {
    respond(model(path).map(|m| json!(m.info())))
}

// doc: an avalanche::Doc. Result: the stream's bytes as an array of numbers.
fn encode(path: &str, doc: &str) -> String {
    respond((|| {
        let doc: avalanche::Doc = serde_json::from_str(doc).map_err(|e| format!("bad request: {e}"))?;
        let bytes = model(path)?.encode(&doc).map_err(|e| e.to_string())?;
        Ok(json!(bytes))
    })())
}

#[derive(Deserialize)]
struct DecodeRequest {
    bytes: Vec<u8>,
    #[serde(flatten)]
    layout: avalanche::Doc,
}

// request: {"bytes": [...], "markers": [...], "sections": [...]}. Result: the section texts.
fn decode(path: &str, request: &str) -> String {
    respond((|| {
        let r: DecodeRequest = serde_json::from_str(request).map_err(|e| format!("bad request: {e}"))?;
        let texts = model(path)?.decode(&r.bytes, &r.layout).map_err(|e| e.to_string())?;
        Ok(json!(texts))
    })())
}

unsafe fn str_of<'a>(s: *const c_char) -> std::borrow::Cow<'a, str> {
    unsafe { CStr::from_ptr(s) }.to_string_lossy()
}

fn c_string(s: String) -> *mut c_char {
    CString::new(s).unwrap().into_raw()
}

/// # Safety
/// `path` is a NUL-terminated UTF-8 string. Free the result with avalanche_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avalanche_model_info(path: *const c_char) -> *mut c_char {
    c_string(model_info(&unsafe { str_of(path) }))
}

/// # Safety
/// `path` and `doc` are NUL-terminated UTF-8 strings. Free the result with avalanche_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avalanche_encode(path: *const c_char, doc: *const c_char) -> *mut c_char {
    c_string(encode(&unsafe { str_of(path) }, &unsafe { str_of(doc) }))
}

/// # Safety
/// `path` and `request` are NUL-terminated UTF-8 strings. Free the result with avalanche_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avalanche_decode(path: *const c_char, request: *const c_char) -> *mut c_char {
    c_string(decode(&unsafe { str_of(path) }, &unsafe { str_of(request) }))
}

/// # Safety
/// `s` came from this library and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avalanche_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::JNIEnv;
    use jni::objects::{JObject, JString};
    use jni::sys::jstring;

    fn call(env: &mut JNIEnv, args: &[&JString], f: impl FnOnce(&[String]) -> String) -> jstring {
        let strings: Result<Vec<String>, _> = args.iter().map(|a| env.get_string(a).map(String::from)).collect();
        let json = match strings {
            Ok(s) => f(&s),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
        env.new_string(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
    }

    // The methods of blue.going.avalanche.AvalancheNative, each returning JSON.

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_blue_going_avalanche_AvalancheNative_modelInfo(mut env: JNIEnv, _this: JObject, path: JString) -> jstring {
        call(&mut env, &[&path], |s| super::model_info(&s[0]))
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_blue_going_avalanche_AvalancheNative_encode(mut env: JNIEnv, _this: JObject, path: JString, doc: JString) -> jstring {
        call(&mut env, &[&path, &doc], |s| super::encode(&s[0], &s[1]))
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_blue_going_avalanche_AvalancheNative_decode(mut env: JNIEnv, _this: JObject, path: JString, request: JString) -> jstring {
        call(&mut env, &[&path, &request], |s| super::decode(&s[0], &s[1]))
    }
}
