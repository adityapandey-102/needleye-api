import { logger } from "../../../common/logger/logger";
import type { HumanCheck } from "../application/ports/human-check.port";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare Turnstile server-side check (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
 * Fails CLOSED: a timeout, network error or bad answer counts as "not verified".
 * Used only when TURNSTILE_ENABLED=true -- see docs/guides/turn-on-turnstile.md.
 */
export class CloudflareTurnstile implements HumanCheck {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string, remoteIp: string | undefined): Promise<boolean> {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    try {
      const res = await this.fetchImpl(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        logger.warn({ status: res.status }, "Turnstile siteverify returned a non-OK status");
        return false;
      }
      const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
      if (!data.success) logger.info({ errorCodes: data["error-codes"] }, "Turnstile check failed");
      return data.success === true;
    } catch (err) {
      logger.warn({ err }, "Turnstile siteverify unreachable -- treating the enquiry as unverified");
      return false;
    }
  }
}
