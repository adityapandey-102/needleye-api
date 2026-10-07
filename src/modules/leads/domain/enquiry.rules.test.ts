import { describe, expect, it } from "vitest";
import { decideEnquiry, ENQUIRY_WINDOW_MS, normalizeFreeText, normalizeIndianMobile, normalizePersonName } from "./enquiry.rules";

describe("normalizeIndianMobile", () => {
  it("accepts common ways of typing a mobile number", () => {
    for (const raw of ["9876543210", "98765 43210", "+91 98765-43210", "919876543210", "09876543210", "(987) 654-3210"]) {
      expect(normalizeIndianMobile(raw), raw).toBe("9876543210");
    }
  });

  it("rejects landlines, short/long numbers, letters and injection attempts", () => {
    for (const raw of ["5876543210", "987654321", "98765432101", "98765abcde", "' OR 1=1 --", "9876543210; drop table leads", ""]) {
      expect(normalizeIndianMobile(raw), raw).toBeNull();
    }
  });
});

describe("normalizePersonName", () => {
  it("keeps real names in any script, tidying spaces", () => {
    expect(normalizePersonName("  Priya   Sharma ")).toBe("Priya Sharma");
    expect(normalizePersonName("D'Souza-Rao")).toBe("D'Souza-Rao");
    expect(normalizePersonName("प्रिया शर्मा")).toBe("प्रिया शर्मा");
    expect(normalizePersonName("Dr. Mehta")).toBe("Dr. Mehta");
  });

  it("rejects code, symbols, digits, too short / too long", () => {
    for (const raw of ["<script>alert(1)</script>", "Robert'); DROP TABLE leads;--", "=HYPERLINK(1)", "Agent 007", "A", "x".repeat(81), "   ", "-dash first"]) {
      expect(normalizePersonName(raw), raw).toBeNull();
    }
  });

  it("removes invisible control / direction-override characters", () => {
    expect(normalizePersonName("Ma‮ya\u0000")).toBe("Ma ya");
  });
});

describe("normalizeFreeText", () => {
  it("keeps the text (stored and shown as plain text) but strips control characters and squeezes blank lines", () => {
    expect(normalizeFreeText("  Lehenga for wedding\r\n\r\n\r\n\r\nBudget 50k\u0007  ")).toBe("Lehenga for wedding\n\nBudget 50k");
    expect(normalizeFreeText("<b>hi</b> ' OR 1=1")).toBe("<b>hi</b> ' OR 1=1"); // inert: never rendered as HTML, never put in SQL text
  });
});

describe("decideEnquiry", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

  it("creates a lead for a first-time number", () => {
    expect(decideEnquiry(null, now)).toEqual({ kind: "create" });
  });

  it("merges the 2nd enquiry within 24h of the first", () => {
    expect(decideEnquiry({ id: "L1", firstEnquiryAt: hoursAgo(5), enquiryCount: 1 }, now)).toEqual({ kind: "merge", leadId: "L1" });
  });

  it("declines a 3rd enquiry within the window", () => {
    expect(decideEnquiry({ id: "L1", firstEnquiryAt: hoursAgo(23.9), enquiryCount: 2 }, now)).toEqual({ kind: "limit" });
  });

  it("opens a new window (a new lead) 24h after the first enquiry", () => {
    expect(decideEnquiry({ id: "L1", firstEnquiryAt: new Date(now.getTime() - ENQUIRY_WINDOW_MS), enquiryCount: 2 }, now)).toEqual({ kind: "create" });
  });
});
