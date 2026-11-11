//! The app's bindings: a C ABI that Swift calls (include/avalanche.h) and JNI functions
//! that Kotlin calls. Results cross as JSON: {"ok": ...} or {"error": "..."}.

use std::ffi::{CStr, CString, c_char};

fn model_info(path: &str) -> String {
    let result = std::fs::read(path)
        .map_err(|e| format!("{path}: {e}"))
        .and_then(|bytes| avalanche::Model::parse(bytes).map_err(|e| e.to_string()));
    match result {
        Ok(m) => serde_json::json!({ "ok": m.info() }).to_string(),
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// The model file's description as JSON. Free the result with avalanche_free.
///
/// # Safety
/// `path` is a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avalanche_model_info(path: *const c_char) -> *mut c_char {
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    CString::new(model_info(&path)).unwrap().into_raw()
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

    // blue.going.avalanche.AvalancheNative.modelInfo(path: String): String
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_blue_going_avalanche_AvalancheNative_modelInfo(
        mut env: JNIEnv,
        _this: JObject,
        path: JString,
    ) -> jstring {
        let json = match env.get_string(&path) {
            Ok(p) => super::model_info(&String::from(p)),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
        env.new_string(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
    }
}
