import { randomBytes, createHash } from "node:crypto";

// Excludes visually-ambiguous characters (0/O, 1/l/I) since these passwords
// are meant to be read aloud or copied off a screen by hand.
const SUFFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[bytes[i]! % SUFFIX_ALPHABET.length];
  }
  return out;
}

/**
 * "Readable name + random suffix" password scheme: easy to read aloud or
 * write down for less tech-savvy staff, but the 8-char suffix (~47 bits of
 * entropy from a 57-symbol alphabet) means knowing the person's name gives
 * no real head start on guessing it.
 */
export function generatePassword(fullName: string): string {
  const firstName = fullName.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "") || "user";
  return `${firstName}-${randomSuffix(8)}`;
}

/** Opaque high-entropy token for QR login -- no personal info, unlike the password. */
export function generateQrToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the hash is ever stored -- same principle as a password, applied to the QR token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
