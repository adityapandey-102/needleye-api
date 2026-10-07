import { describe, expect, it } from "vitest";
import {
  allowedNextStatuses,
  assertAssignable,
  assertStatusChange,
  clearsUrgent,
  convertibleFrom,
  statusAfterRepeatEnquiry,
} from "./lead-status.rules";
import { AppError } from "../../../common/errors/app-error";

const ok = (input: Parameters<typeof assertStatusChange>[0]) => expect(() => assertStatusChange(input)).not.toThrow();
const refused = (input: Parameters<typeof assertStatusChange>[0], status: number) => {
  try {
    assertStatusChange(input);
    throw new Error("expected a refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(status);
  }
};

describe("designer moves (own leads, forward)", () => {
  it("Received: assigned -> unattended", () => ok({ actor: "designer", from: "assigned", to: "unattended", hasAssignee: true }));

  it("works the lead: unattended -> attended -> follow_up (again) -> attended", () => {
    ok({ actor: "designer", from: "unattended", to: "attended", hasAssignee: true });
    ok({ actor: "designer", from: "attended", to: "follow_up", hasAssignee: true });
    ok({ actor: "designer", from: "follow_up", to: "follow_up", hasAssignee: true });
    ok({ actor: "designer", from: "follow_up", to: "attended", hasAssignee: true });
  });

  it("can mark lost with a reason, never without", () => {
    ok({ actor: "designer", from: "attended", to: "lost", hasAssignee: true, lostReason: "Went elsewhere" });
    refused({ actor: "designer", from: "attended", to: "lost", hasAssignee: true }, 400);
  });

  it("can't skip Received, go backwards, discard, reopen or touch closed leads", () => {
    refused({ actor: "designer", from: "assigned", to: "attended", hasAssignee: true }, 403);
    refused({ actor: "designer", from: "attended", to: "unattended", hasAssignee: true }, 403);
    refused({ actor: "designer", from: "new", to: "discarded", hasAssignee: false }, 403);
    refused({ actor: "designer", from: "lost", to: "unattended", hasAssignee: true }, 403);
    expect(allowedNextStatuses("designer", "converted")).toEqual([]);
  });
});

describe("owner moves", () => {
  it("discards only an unassigned (new) lead and can restore it", () => {
    ok({ actor: "owner", from: "new", to: "discarded", hasAssignee: false });
    refused({ actor: "owner", from: "assigned", to: "discarded", hasAssignee: true }, 403);
    ok({ actor: "owner", from: "discarded", to: "new", hasAssignee: false });
  });

  it("can set any working stage, and reopen a lost lead for its designer", () => {
    ok({ actor: "owner", from: "assigned", to: "attended", hasAssignee: true });
    ok({ actor: "owner", from: "follow_up", to: "unattended", hasAssignee: true });
    ok({ actor: "owner", from: "lost", to: "unattended", hasAssignee: true });
    refused({ actor: "owner", from: "lost", to: "unattended", hasAssignee: false }, 409);
  });

  it("nobody reaches converted or assigned through a plain stage change", () => {
    refused({ actor: "owner", from: "attended", to: "converted", hasAssignee: true }, 400);
    refused({ actor: "owner", from: "new", to: "assigned", hasAssignee: false }, 400);
    expect(allowedNextStatuses("owner", "converted")).toEqual([]);
  });
});

describe("urgent, assign, convert, repeat enquiry", () => {
  it("contacting or closing clears urgent; Received alone doesn't", () => {
    expect(clearsUrgent("attended")).toBe(true);
    expect(clearsUrgent("follow_up")).toBe(true);
    expect(clearsUrgent("lost")).toBe(true);
    expect(clearsUrgent("unattended")).toBe(false);
  });

  it("only open leads can be assigned", () => {
    expect(() => assertAssignable("follow_up")).not.toThrow();
    expect(() => assertAssignable("lost")).toThrow(AppError);
    expect(() => assertAssignable("converted")).toThrow(AppError);
  });

  it("a designer converts only after Received; the owner from any open stage", () => {
    expect(convertibleFrom("designer")).not.toContain("assigned");
    expect(convertibleFrom("designer")).toContain("follow_up");
    expect(convertibleFrom("owner")).toContain("new");
    expect(convertibleFrom("owner")).not.toContain("lost");
  });

  it("a repeat enquiry reopens discarded (to the owner) and lost (to its designer); converted stays", () => {
    expect(statusAfterRepeatEnquiry("discarded", false)).toBe("new");
    expect(statusAfterRepeatEnquiry("lost", true)).toBe("unattended");
    expect(statusAfterRepeatEnquiry("lost", false)).toBe("new");
    expect(statusAfterRepeatEnquiry("converted", true)).toBe("converted");
    expect(statusAfterRepeatEnquiry("attended", true)).toBe("attended");
  });
});
