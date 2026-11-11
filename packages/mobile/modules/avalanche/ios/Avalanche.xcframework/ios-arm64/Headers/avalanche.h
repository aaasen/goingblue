#ifndef AVALANCHE_H
#define AVALANCHE_H

// The avalanche library C ABI (avalanche-ffi/src/lib.rs). Strings are UTF-8; results are JSON,
// {"ok": ...} or {"error": "..."}, and are released with avalanche_free.

char *avalanche_model_info(const char *path);
void avalanche_free(char *s);

#endif
