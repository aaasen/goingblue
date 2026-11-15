// A hash of the sources the mobile libraries are built from. build-mobile.sh stamps it beside each
// platform's libraries, and a mobile test compares the stamps against the sources.
// Usage: node source-hash.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const INPUTS = [
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "build-mobile.sh",
  "avalanche/Cargo.toml", "avalanche/src",
  "avalanche-ffi/Cargo.toml", "avalanche-ffi/src", "avalanche-ffi/include",
];

function files(path) {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : [path];
}

export function sourceHash() {
  const hash = createHash("sha256");
  const paths = INPUTS.flatMap((p) => files(join(ROOT, p))).map((p) => relative(ROOT, p)).sort();
  for (const p of paths) hash.update(`${p}\0`).update(readFileSync(join(ROOT, p))).update("\0");
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(sourceHash());
