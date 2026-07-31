/**
 * The receiving half of Web Push, for tests only: what a browser (and the push
 * service in front of it) does with what `crypto.ts` produces. Living here
 * rather than in a `.test.ts` file so the route tests can prove the full
 * subscribe → trigger → deliver round-trip decrypts with the subscription's
 * own keys, without importing a test file into another test file.
 */
import crypto from "node:crypto";
import { toBase64Url } from "./crypto.ts";

/** A browser-side subscription key pair, in the shapes each side uses. */
export interface TestSubscription {
  /** What the subscribe payload carries. */
  keys: { p256dh: string; auth: string };
  /** What the "browser" decrypts with. */
  privateKey: Buffer;
  authSecret: Buffer;
}

/** Mints the keys a browser would: a P-256 pair and a 16-byte auth secret. */
export function makeTestSubscription(): TestSubscription {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();
  const privateKey = Buffer.alloc(32);
  scalar.copy(privateKey, 32 - scalar.length);
  const authSecret = crypto.randomBytes(16);
  return {
    keys: {
      p256dh: toBase64Url(ecdh.getPublicKey()),
      auth: toBase64Url(authSecret),
    },
    privateKey,
    authSecret,
  };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * Decrypts a complete `aes128gcm` message with the subscription's keys —
 * RFC 8291 § 3 run in reverse, delimiter and padding stripped.
 */
export function decryptPayload(
  message: Buffer,
  userAgentPrivateKey: Buffer,
  authSecret: Buffer,
): Buffer {
  const salt = message.subarray(0, 16);
  const keyIdLength = message.readUInt8(20);
  const appServerPublicKey = message.subarray(21, 21 + keyIdLength);
  const ciphertext = message.subarray(21 + keyIdLength);

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(userAgentPrivateKey);
  const userAgentPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(appServerPublicKey);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    userAgentPublicKey,
    appServerPublicKey,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const contentKey = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(body), decipher.final()]);

  // The record is plaintext, a 0x01/0x02 delimiter, then zero padding.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  if (end < 0 || (record[end] !== 0x01 && record[end] !== 0x02))
    throw new Error("record delimiter missing");
  return record.subarray(0, end);
}
