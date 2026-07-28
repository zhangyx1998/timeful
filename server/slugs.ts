/**
 * Slugs are the public path of an event, and — when generated — the only
 * secret protecting it. Defaults are 12 crypto-random base62 characters
 * (~71 bits), i.e. capability URLs. Custom slugs stay allowed for the admin.
 *
 * Generation lives here because it needs `node:crypto`. What makes a slug
 * *legal* does not, and lives in `src/lib/slug-rules.ts` so the event form can
 * apply exactly the same rules as the admin types — one definition, both
 * halves, the same wording. They are re-exported here so every existing
 * importer keeps working.
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

/**
 * A uniformly random base62 string. Bytes >= 248 are discarded so that the
 * 62-symbol alphabet is not skewed by the modulo (rejection sampling).
 */
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
