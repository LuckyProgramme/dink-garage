import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key() {
  const value = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (value.length !== 32) throw new Error("Set a 32-byte TOKEN_ENCRYPTION_KEY.");
  return value;
}
export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString("base64url")).join(".");
}
export function decryptSecret(value: string) {
  const parts = value.split(".").map(v => Buffer.from(v, "base64url"));
  if (parts.length !== 3) throw new Error("Invalid encrypted token.");
  const decipher = createDecipheriv("aes-256-gcm", key(), parts[0]);
  decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
}
