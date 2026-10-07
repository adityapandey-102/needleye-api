import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The public enquiry form's anti-bot timing token. When the form opens it gets
 * `issuedAt.signature` (HMAC-SHA256 of the timestamp with a server secret); the
 * submission must carry it back. That proves the submitter loaded the form from
 * us (no blind POSTs), lets us reject a form "filled" faster than a person can
 * type, and expires stale pages. Stateless -- nothing stored, works across
 * restarts and instances because the secret is stable (see config/env.ts).
 */
export const FORM_TOKEN_MIN_FILL_MS = 3_000;
export const FORM_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type FormTokenCheck = "ok" | "invalid" | "too_fast" | "expired";

function sign(issuedAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`enquiry-form:${issuedAt}`).digest("base64url");
}

export function issueFormToken(secret: string, now: number = Date.now()): string {
  return `${now}.${sign(now, secret)}`;
}

export function checkFormToken(token: unknown, secret: string, now: number = Date.now()): FormTokenCheck {
  if (typeof token !== "string" || token.length > 128) return "invalid";
  const dot = token.indexOf(".");
  const issuedAt = Number(token.slice(0, dot));
  if (dot <= 0 || !Number.isSafeInteger(issuedAt)) return "invalid";

  const expected = Buffer.from(sign(issuedAt, secret));
  const given = Buffer.from(token.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";

  const age = now - issuedAt;
  if (age < FORM_TOKEN_MIN_FILL_MS) return "too_fast"; // also catches a timestamp from the future
  if (age > FORM_TOKEN_MAX_AGE_MS) return "expired";
  return "ok";
}
