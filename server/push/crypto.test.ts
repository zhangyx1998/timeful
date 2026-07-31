import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptPayload,
  fromBase64Url,
  isP256Point,
  MAX_PLAINTEXT_LENGTH,
  toBase64Url,
} from "./crypto.ts";
import {
  generateVapidKeys,
  vapidAuthorization,
  VAPID_SUBJECT,
  VAPID_TOKEN_TTL_S,
} from "./vapid.ts";
import { decryptPayload, makeTestSubscription } from "./test-support.ts";

const b64 = (text: string): Buffer => {
  const parsed = fromBase64Url(text);
  if (!parsed) throw new Error("bad test vector");
  return parsed;
};

// ---------------------------------------------------------------------------
// RFC 8291 Appendix A — the published test vector for the whole scheme
// ---------------------------------------------------------------------------

/** Every input and the expected output, verbatim from RFC 8291 Appendix A. */
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: b64(
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ),
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  authSecret: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  asPublic: b64(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ),
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("encryptPayload (RFC 8291)", () => {
  it("reproduces Appendix A byte for byte", () => {
    const message = encryptPayload(
      Buffer.from(VECTOR.plaintext, "utf8"),
      VECTOR.uaPublic,
      VECTOR.authSecret,
      { salt: VECTOR.salt, ephemeralPrivateKey: VECTOR.asPrivate },
    );
    expect(toBase64Url(message)).toBe(VECTOR.message);
  });

  it("derives the Appendix A ephemeral public key from its private key", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(VECTOR.asPrivate);
    expect(ecdh.getPublicKey().equals(VECTOR.asPublic)).toBe(true);
  });

  it("decrypts back to the Appendix A plaintext with the browser's keys", () => {
    const message = b64(VECTOR.message);
    const plaintext = decryptPayload(message, VECTOR.uaPrivate, VECTOR.authSecret);
    expect(plaintext.toString("utf8")).toBe(VECTOR.plaintext);
  });

  it("round-trips a payload under fresh random keys", () => {
    const subscription = makeTestSubscription();
    const payload = JSON.stringify({ title: "Team Offsite", body: "Responses changed." });
    const message = encryptPayload(
      Buffer.from(payload, "utf8"),
      b64(subscription.keys.p256dh),
      subscription.authSecret,
    );
    // Random salt and ephemeral key: two encryptions never repeat.
    const again = encryptPayload(
      Buffer.from(payload, "utf8"),
      b64(subscription.keys.p256dh),
      subscription.authSecret,
    );
    expect(message.equals(again)).toBe(false);
    const plaintext = decryptPayload(message, subscription.privateKey, subscription.authSecret);
    expect(plaintext.toString("utf8")).toBe(payload);
  });

  it("writes the aes128gcm header the RFC describes", () => {
    const subscription = makeTestSubscription();
    const message = encryptPayload(
      Buffer.from("x"),
      b64(subscription.keys.p256dh),
      subscription.authSecret,
    );
    expect(message.readUInt32BE(16)).toBe(4096); // rs
    expect(message.readUInt8(20)).toBe(65); // idlen
    expect(isP256Point(message.subarray(21, 86))).toBe(true); // keyid
    // salt(16) + rs(4) + idlen(1) + keyid(65) + 1 byte + delimiter + tag(16)
    expect(message.length).toBe(16 + 4 + 1 + 65 + 1 + 1 + 16);
  });

  it("refuses malformed subscription keys and oversized payloads", () => {
    const subscription = makeTestSubscription();
    const p256dh = b64(subscription.keys.p256dh);
    expect(() =>
      encryptPayload(Buffer.from("x"), p256dh.subarray(1), subscription.authSecret),
    ).toThrow(/P-256/);
    expect(() =>
      encryptPayload(Buffer.from("x"), p256dh, Buffer.alloc(15)),
    ).toThrow(/16 bytes/);
    expect(() =>
      encryptPayload(Buffer.alloc(MAX_PLAINTEXT_LENGTH + 1), p256dh, subscription.authSecret),
    ).toThrow(/single record/);
  });
});

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

describe("vapidAuthorization", () => {
  const record = generateVapidKeys();

  /** Splits `vapid t=…, k=…` into its two parameters. */
  function parseHeader(header: string): { token: string; key: string } {
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    return { token: match![1], key: match![2] };
  }

  it("mints keys in the stored shape", () => {
    const point = fromBase64Url(record.publicKey);
    const scalar = fromBase64Url(record.privateKey);
    expect(point && isP256Point(point)).toBe(true);
    expect(scalar?.length).toBe(32);
  });

  it("signs a JWT the public key verifies", () => {
    const now = Date.now();
    const endpoint = "https://push.example.net/w/abc123";
    const { token, key } = parseHeader(vapidAuthorization(record, endpoint, now));
    expect(key).toBe(record.publicKey);

    const [headerPart, claimsPart, signaturePart] = token.split(".");
    const header = JSON.parse(b64(headerPart).toString("utf8")) as Record<string, unknown>;
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    const claims = JSON.parse(b64(claimsPart).toString("utf8")) as Record<string, unknown>;
    // The audience is the push service's origin, never the full endpoint.
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.sub).toBe(VAPID_SUBJECT);
    expect(claims.exp).toBe(Math.floor(now / 1000) + VAPID_TOKEN_TTL_S);

    // Raw JOSE form: 64 bytes of r||s, not DER.
    const signature = b64(signaturePart);
    expect(signature.length).toBe(64);

    const point = b64(record.publicKey);
    const publicKey = crypto.createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(point.subarray(1, 33)),
        y: toBase64Url(point.subarray(33, 65)),
      },
    });
    const verified = crypto.verify(
      "sha256",
      Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(verified).toBe(true);
  });

  it("scopes the audience to each endpoint's origin", () => {
    const { token } = parseHeader(
      vapidAuthorization(record, "https://fcm.googleapis.com/fcm/send/xyz"),
    );
    const claims = JSON.parse(b64(token.split(".")[1]).toString("utf8")) as {
      aud: string;
    };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
  });
});
