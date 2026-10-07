import { describe, expect, it, vi } from "vitest";
import { CloudflareTurnstile } from "./cloudflare-turnstile";

function reply(status: number, body: unknown) {
  return vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe("CloudflareTurnstile", () => {
  it("passes only when Cloudflare says success, sending secret + token + visitor IP", async () => {
    const fetchImpl = reply(200, { success: true });
    expect(await new CloudflareTurnstile("sekret", fetchImpl as unknown as typeof fetch).verify("tok", "1.2.3.4")).toBe(true);
    const body = fetchImpl.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("secret")).toBe("sekret");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("1.2.3.4");
  });

  it("fails closed: no token, a failed check, a bad status, or Cloudflare unreachable", async () => {
    const ts = (impl: ReturnType<typeof vi.fn>) => new CloudflareTurnstile("s", impl);
    expect(await ts(reply(200, { success: true })).verify("", "1.2.3.4")).toBe(false);
    expect(await ts(reply(200, { success: false, "error-codes": ["invalid-input-response"] })).verify("t", undefined)).toBe(false);
    expect(await ts(reply(500, {})).verify("t", undefined)).toBe(false);
    expect(await ts(vi.fn(() => Promise.reject(new Error("ECONNRESET")))).verify("t", undefined)).toBe(false);
  });
});
