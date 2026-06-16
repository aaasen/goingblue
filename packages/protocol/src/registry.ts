import { v1Codec } from "./versions/v1.js";
import type { VersionedCodec } from "./message.js";

export const CODECS: Record<number, VersionedCodec> = {
  1: v1Codec,
};
