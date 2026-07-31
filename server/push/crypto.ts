/**
 * Web Push payload encryption — RFC 8291 (`aes128gcm`), on `node:crypto` and
 * nothing else.
 *
 * A push message is end-to-end encrypted to one browser: the payload is
 * readable only by the subscription that carries the matching key pair, never
 * by the push service relaying it. The scheme is ECDH on P-256 against the
 * browser's `p256dh` key, mixed with the 16-byte `auth` secret through HKDF
 * (RFC 8188 § 2.2 / RFC 8291 § 3), then a single AES-128-GCM record in the
 * `aes128gcm` framing (RFC 8188 § 2.1).
 *
 * Hand-rolled because the published package bundles everything and depends on
 * nothing (docs § Packaging), so it is pinned to the RFC 8291 Appendix A test
 * vectors in `crypto.test.ts` — the appendix exists precisely so an
 * implementation like this one can prove itself.
 */
import crypto from "node:crypto";

/** Base64url without padding — the alphabet every Web Push field uses. */
export function toBase64Url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

/** Decodes base64url (padding tolerated). Returns null on anything else. */
export function fromBase64Url(text: string): Buffer | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(text)) return null;
  try {
    return Buffer.from(text, "base64url");
  } catch {
    return null;
  }
}

/** One HKDF-SHA-256 step (RFC 5869), as both RFCs use it. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

/** An uncompressed P-256 point: 0x04 then two 32-byte coordinates. */
export function isP256Point(data: Buffer): boolean {
  return data.length === 65 && data[0] === 0x04;
}

/** The `auth` secret is always 16 bytes (RFC 8291 § 2). */
export const AUTH_SECRET_LENGTH = 16;

/**
 * The record size written into the `aes128gcm` header. One record holds
 * `rs - 17` bytes of plaintext; our payloads are a short JSON sentence, so a
 * single 4096-byte record always suffices — and 4096 is what every push
 * service accepts (RFC 8291 § 4 requires the message to fit one record).
 */
export const RECORD_SIZE = 4096;

/** The plaintext ceiling one record leaves: rs − 16 (tag) − 1 (delimiter). */
export const MAX_PLAINTEXT_LENGTH = RECORD_SIZE - 17;

export interface EncryptOverrides {
  /** Injected by the RFC 8291 vector test; random otherwise. */
  salt?: Buffer;
  /** The app server's ephemeral ECDH private key; generated otherwise. */
  ephemeralPrivateKey?: Buffer;
}

/**
 * Encrypts `plaintext` to a subscription's keys, returning the complete
 * `aes128gcm` body: header (salt, rs, keyid = our ephemeral public key) then
 * the one encrypted record.
 *
 * @param userAgentPublicKey the subscription's `p256dh`, a 65-byte point
 * @param authSecret the subscription's `auth`, 16 bytes
 */
export function encryptPayload(
  plaintext: Buffer,
  userAgentPublicKey: Buffer,
  authSecret: Buffer,
  overrides: EncryptOverrides = {},
): Buffer {
  if (!isP256Point(userAgentPublicKey))
    throw new Error("p256dh must be an uncompressed P-256 point");
  if (authSecret.length !== AUTH_SECRET_LENGTH)
    throw new Error("auth must be 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT_LENGTH)
    throw new Error("payload does not fit a single record");

  const salt = overrides.salt ?? crypto.randomBytes(16);
  const ecdh = crypto.createECDH("prime256v1");
  if (overrides.ephemeralPrivateKey) ecdh.setPrivateKey(overrides.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const appServerPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userAgentPublicKey);

  // RFC 8291 § 3.3–3.4: auth secret and both public keys bind the IKM, then
  // the RFC 8188 schedule derives the content key and nonce from the salt.
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    userAgentPublicKey,
    appServerPublicKey,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const contentKey = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  // A single, final record: plaintext then the 0x02 delimiter (RFC 8188 § 2).
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) | rs (4) | idlen (1) | keyid (our public key, 65).
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(appServerPublicKey.length, 20);
  return Buffer.concat([header, appServerPublicKey, ciphertext]);
}
