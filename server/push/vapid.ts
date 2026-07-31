/**
 * VAPID (RFC 8292): the server identifies itself to a push service with an
 * ES256-signed JWT, so a push endpoint only accepts messages from the
 * application server its subscription was created against.
 *
 * The key pair is minted on first use — the first time a browser asks for the
 * public key — and persisted in `var/vapid.json` through the storage layer,
 * because a subscription is bound to the public key it was created with:
 * regenerating the pair would orphan every existing subscription. There is no
 * third-party account behind any of this; the pair is just numbers this server
 * made up, exactly like a session secret.
 */
import crypto from "node:crypto";
import { readVapidKeys, updateVapidKeys } from "../storage.ts";
import type { VapidKeyRecord } from "../types.ts";
import { fromBase64Url, toBase64Url } from "./crypto.ts";

/**
 * How long a signed token is valid. RFC 8292 caps it at 24 hours; half that
 * leaves generous clock-skew room while still costing one cheap signature per
 * delivery batch.
 */
export const VAPID_TOKEN_TTL_S = 12 * 60 * 60;

/**
 * The `sub` claim: a contact for the push service's operator to reach, should
 * this server misbehave. Timeful's operator is anonymous by design — there is
 * no account and no email we could truthfully put here — so it names the
 * project, which is where such a report can actually land.
 */
export const VAPID_SUBJECT = "https://github.com/zhangyx1998/timeful";

/** Mints a fresh P-256 pair in the stored shape. */
export function generateVapidKeys(now = new Date()): VapidKeyRecord {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  // The scalar can come back short of 32 bytes (leading zeros); left-pad so
  // the stored form is always the same length.
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
  // Under the lock: two concurrent first asks must not each mint a pair and
  // race the write — the loser's key would already be in a browser's hands.
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

/**
 * The `Authorization` header for one delivery (RFC 8292 § 3): a JWT whose
 * `aud` is the push service's **origin** — never the full endpoint, which
 * would leak one subscription's identity into another's token — plus the
 * public key the signature verifies against.
 */
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
