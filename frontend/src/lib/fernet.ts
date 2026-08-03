import crypto from "crypto";

/**
 * Minimal Fernet-compatible encryptor (https://github.com/fernet/spec) -
 * interoperable with Python's cryptography.fernet.Fernet, which is what
 * scripts/provider_secrets.py uses to decrypt everything in
 * provider_credentials. Encrypt-only: this app's Python side is the only
 * thing that ever needs to decrypt these values, so there's no decrypt()
 * here. Not a general-purpose Fernet library - just enough to produce a
 * token scripts/provider_secrets.py's decrypt() can read.
 *
 * Token = base64url(version(1) ‖ timestamp(8, big-endian seconds) ‖
 * iv(16) ‖ AES-128-CBC(encryptionKey, iv, PKCS7(plaintext)) ‖
 * HMAC-SHA256(signingKey, version‖timestamp‖iv‖ciphertext))
 *
 * The 32-byte Fernet key (itself base64url-encoded, e.g.
 * PROVIDER_SECRETS_KEY) splits into signingKey (first 16 bytes) and
 * encryptionKey (last 16 bytes) - same split the spec and the Python
 * library both use.
 */
export function fernetEncrypt(base64UrlKey: string, plaintext: string): string {
  const keyBytes = Buffer.from(base64UrlKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (keyBytes.length !== 32) {
    throw new Error(`Fernet key must decode to 32 bytes, got ${keyBytes.length}`);
  }
  const signingKey = keyBytes.subarray(0, 16);
  const encryptionKey = keyBytes.subarray(16, 32);

  const version = Buffer.from([0x80]);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  const payload = Buffer.concat([version, timestamp, iv, ciphertext]);
  const hmac = crypto.createHmac("sha256", signingKey).update(payload).digest();

  const token = Buffer.concat([payload, hmac]);
  return token.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
