#ifndef AVALANCHE_H
#define AVALANCHE_H

// The avalanche library C ABI (avalanche-ffi/src/lib.rs). Each call names the model file, which
// is loaded once and kept. Strings are UTF-8; results are JSON, {"ok": ...} or {"error": "..."},
// and are released with avalanche_free.

// The model file's description.
char *avalanche_model_info(const char *path);

// doc: {"markers": [...], "sections": [{"markers": [...], "text": "..."}]}.
// Result: the stream's bytes as an array of numbers.
char *avalanche_encode(const char *path, const char *doc);

// request: {"bytes": [...], "markers": [...], "sections": [{"markers": [...]}]}.
// Result: the section texts.
char *avalanche_decode(const char *path, const char *request);

void avalanche_free(char *s);

#endif
