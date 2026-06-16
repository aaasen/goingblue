import { v1Codec } from "./versions/v1.js";
import { v2Codec } from "./versions/v2.js";
import type { VersionedCodec } from "./model.js";

export const CODECS: Record<number, VersionedCodec> = {
  1: v1Codec,
  2: v2Codec,
};
