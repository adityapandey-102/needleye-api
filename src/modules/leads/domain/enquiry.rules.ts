/**
 * Public enquiry form rules -- pure, unit-tested. Inputs from the open form are
 * normalised here (never trusted), and a repeat enquiry from the same phone is
 * decided here: within 24 hours of the FIRST enquiry the 2nd one is merged
 * into that lead (and marks it urgent); a 3rd or later is politely declined.
 */

/** How long a phone's enquiry window lasts, from its first enquiry. */
export const ENQUIRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Enquiries accepted per phone per window (the 2nd is merged, not a new lead). */
export const MAX_ENQUIRIES_PER_WINDOW = 2;

export const ENQUIRY_LIMITS = { nameMin: 2, nameMax: 80, requirementMax: 1000 } as const;

/**
 * A 10-digit Indian mobile number from whatever was typed: drops spaces,
 * dashes, brackets, a leading +91 / 91 / 0. Returns null unless what remains
 * is 10 digits starting 6-9.
 */
export function normalizeIndianMobile(raw: string): string | null {
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Removes control characters (keeping newlines/tabs where allowed) and unusual whitespace. */
function stripControls(value: string, keepNewlines: boolean): string {
  const controls = keepNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g : /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
  return value.normalize("NFC").replace(controls, keepNewlines ? "" : " ");
}

/**
 * A person's name: letters (any script, with their accents), spaces, and . ' -
 * only; collapsed spaces; 2-80 characters. Returns null when it doesn't fit --
 * which also rejects anything code-like (<, >, ;, =, quotes, digits, ...).
 */
export function normalizePersonName(raw: string): string | null {
  const name = stripControls(raw, false).replace(/\s+/g, " ").trim();
  if (name.length < ENQUIRY_LIMITS.nameMin || name.length > ENQUIRY_LIMITS.nameMax) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name) ? name : null;
}

/** Free text (the requirement / a comment): control characters removed, blank lines squeezed, trimmed. */
export function normalizeFreeText(raw: string): string {
  return stripControls(raw, true)
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type EnquiryDecision =
  | { kind: "create" }
  | { kind: "merge"; leadId: string }
  | { kind: "limit" };

/**
 * What to do with an enquiry, given the phone's most recent lead (if any).
 * The 24-hour window runs from that lead's first enquiry.
 */
export function decideEnquiry(
  latest: { id: string; firstEnquiryAt: Date; enquiryCount: number } | null,
  now: Date,
): EnquiryDecision {
  if (!latest || now.getTime() - latest.firstEnquiryAt.getTime() >= ENQUIRY_WINDOW_MS) return { kind: "create" };
  if (latest.enquiryCount >= MAX_ENQUIRIES_PER_WINDOW) return { kind: "limit" };
  return { kind: "merge", leadId: latest.id };
}

/** What the customer sees -- the same calm wording whatever happened behind the scenes. */
export const ENQUIRY_MESSAGES = {
  received: "Thank you! We've received your enquiry. Our team will contact you shortly.",
  alreadyReceived:
    "Thank you for reaching out again. We've already received your enquiries today, and our team will contact you shortly. " +
    "Please share all your requirements on that call. We appreciate your patience.",
} as const;
