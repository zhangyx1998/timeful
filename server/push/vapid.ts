/**
 * VAPID (RFC 8292): ES256 JWTs identifying this server to push services. The
 * pair is minted on first use and kept — subscriptions are bound to the public
 * key, so regenerating would orphan them all. No third-party account involved.
 */
import crypto from "node:crypto";
import { readVapidKeys, updateVapidKeys } from "../storage.ts";
import type { VapidKeyRecord } from "../types.ts";
import { fromBase64Url, toBase64Url } from "./crypto.ts";

/** RFC 8292 caps token lifetime at 24h; half that leaves clock-skew room. */
export const VAPID_TOKEN_TTL_S = 12 * 60 * 60;

/** The `sub` contact claim: the operator is anonymous by design, so it names the project. */
export const VAPID_SUBJECT = "https://github.com/zhangyx1998/timeful";

/** Mints a fresh P-256 pair in the stored shape. */
export function generateVapidKeys(now = new Date()): VapidKeyRecord {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  // The scalar can come back short of 32 bytes (leading zeros); left-pad.
  const scalar = ecdh.getPrivateKey();
  const d = Buffer.alloc(32);
  scalar.copy(d, 32 - scalar.length);
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(d),
    createdAt: now.toISOString(),
  };
}

/** The stored pair, minting one under the file lock if none exists yet. */
export async function ensureVapidKeys(): Promise<VapidKeyRecord> {
  const existing = await readVapidKeys();
  if (existing) return existing;
  // Under the lock: two concurrent first asks must not each mint a pair.
  const record = await updateVapidKeys((current) => current ?? generateVapidKeys());
  if (!record) throw new Error("VAPID key generation failed");
  return record;
}

/** The stored private key as a signing key object. */
function signingKey(record: VapidKeyRecord): crypto.KeyObject {
  const point = fromBase64Url(record.publicKey);
  const d = fromBase64Url(record.privateKey);
  if (!point || point.length !== 65 || !d || d.length !== 32)
    throw new Error("Stored VAPID keys are malformed");
  return crypto.createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
      d: toBase64Url(d),
    },
  });
}

/** RFC 8292 § 3: `aud` is the push service's origin — never the full endpoint, which would leak. */
export function vapidAuthorization(
  record: VapidKeyRecord,
  endpoint: string,
  nowMs = Date.now(),
): string {
  const audience = new URL(endpoint).origin;
  const encode = (value: unknown): string =>
    toBase64Url(Buffer.from(JSON.stringify(value), "utf8"));
  const signingInput = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_TTL_S,
    sub: VAPID_SUBJECT,
  })}`;
  // JOSE wants the raw 64-byte r||s form, not ASN.1 DER.
  const signature = crypto.sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: signingKey(record),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${record.publicKey}`;
}
