/**
 * Generated slugs are capability URLs: 12 crypto-random base62 chars (~71 bits).
 * Legality rules live in `src/lib/slug-rules.ts`, shared with the event form.
 */
import crypto from "node:crypto";

export {
  MAX_SLUG_LENGTH,
  RESERVED_SLUGS,
  slugProblem,
} from "../src/lib/slug-rules.ts";

export const SLUG_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const SLUG_LENGTH = 12;

/** Uniform base62 via rejection sampling: bytes >= 248 are discarded. */
export function randomSlug(length: number = SLUG_LENGTH): string {
  const limit = 256 - (256 % SLUG_ALPHABET.length); // 248
  let out = "";
  while (out.length < length) {
    const bytes = crypto.randomBytes((length - out.length) * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
