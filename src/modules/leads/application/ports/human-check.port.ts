/**
 * The public form's "is this a person?" check -- Cloudflare Turnstile today
 * (infrastructure/cloudflare-turnstile.ts). Null in the service when switched
 * off (TURNSTILE_ENABLED=false), so the form works without it.
 */
export interface HumanCheck {
  /** True when the widget token is valid for this visitor; false on any failure (fails closed). */
  verify(token: string, remoteIp: string | undefined): Promise<boolean>;
}
