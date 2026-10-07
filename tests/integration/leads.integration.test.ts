import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { leadsService } from "../../src/modules/leads/api/leads.routes";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb } from "./helpers";

/**
 * Leads end to end against the real database: the public enquiry form (its
 * defences, the 2-per-24h rule and merging), the owner's and designers' views,
 * stage rules, comments, the badge, and converting a lead by saving an order.
 */

interface LeadJson {
  id: string;
  leadNumber: string;
  status: string;
  source: string;
  assignedTo: string | null;
  assignedToName: string | null;
  followUpOn: string | null;
  urgent: boolean;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
}
interface DetailJson {
  lead: LeadJson;
  comments: { body: string; authorName: string }[];
  events: { kind: string; toStatus: string | null; note: string | null }[];
  actions: { canConvert: boolean };
}
interface ErrorJson {
  code: string;
}
type Res = request.Response;
const json = <T>(res: Res) => res.body as T;

describe("Leads (integration)", () => {
  const app = createApp();
  const userIds: string[] = [];
  const orderIds: string[] = [];
  const phones: string[] = [];

  /** A fresh mobile number per test, cleaned up afterwards. */
  function phone(): string {
    const p = `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
    phones.push(p);
    return p;
  }
  /** A distinct visitor IP per test, so the per-IP limit is exercised deliberately, not by accident. */
  let ipSeq = 0;
  const ip = () => `198.51.100.${(ipSeq += 1)}`;
  /** A form token issued 10s ago -- a person-paced submission. */
  const token = () => leadsService.publicFormConfig(Date.now() - 10_000).formToken;

  function enquire(body: Record<string, unknown>, fromIp = ip()) {
    return request(app).post("/api/v1/public/enquiries").set("X-Forwarded-For", fromIp).send(body);
  }
  async function leadsByPhone(p: string) {
    const res = await db.execute(sql`select id::text, status, urgent, enquiry_count, source, requirement from leads where phone = ${p}`);
    return res.rows as { id: string; status: string; urgent: boolean; enquiry_count: number; source: string; requirement: string }[];
  }
  async function signIn(role: "owner_manager" | "designer" | "accountant" | "production_manager", name: string) {
    const user = await createFixtureUser(role, name);
    userIds.push(user.id);
    const session = await authProvider.signInWithPassword(user.email, user.password);
    return { user, auth: `Bearer ${session.accessToken}` };
  }
  const get = (path: string, auth: string) => request(app).get(`/api/v1${path}`).set("Authorization", auth);
  const patch = (path: string, auth: string, body: object) => request(app).patch(`/api/v1${path}`).set("Authorization", auth).send(body);
  const post = (path: string, auth: string, body: object) => request(app).post(`/api/v1${path}`).set("Authorization", auth).send(body);
  const badge = async (auth: string) => json<{ count: number }>(await get("/leads/badge", auth)).count;

  afterEach(async () => {
    for (const id of orderIds.splice(0)) await deleteFixtureOrder(id);
    for (const p of phones.splice(0)) await db.execute(sql`delete from leads where phone = ${p}`);
    for (const id of userIds.splice(0)) await deleteFixtureUser(id);
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("public enquiry form", () => {
    it("serves a form token (and no Turnstile key while it's switched off)", async () => {
      const res = await request(app).get("/api/v1/public/enquiry-form");
      expect(res.status).toBe(200);
      const body = json<{ formToken: string; turnstileSiteKey: string | null }>(res);
      expect(body.formToken).toMatch(/^\d+\.[\w-]+$/);
      expect(body.turnstileSiteKey).toBeNull();
      expect(res.headers["cache-control"]).toContain("no-store");
    });

    it("1st enquiry creates a New lead; the 2nd within 24h merges + marks urgent; the 3rd is politely declined", async () => {
      const p = phone();
      const first = await enquire({ name: "Priya Sharma", phone: `+91 ${p.slice(0, 5)} ${p.slice(5)}`, requirement: "Bridal lehenga", formToken: token() });
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ result: "received", message: expect.stringContaining("contact you shortly") as unknown });
      let rows = await leadsByPhone(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "new", urgent: false, enquiry_count: 1, source: "public_form", requirement: "Bridal lehenga" });

      const second = await enquire({ name: "Priya S", phone: p, requirement: "Also a blouse", formToken: token() });
      expect(second.status).toBe(201);
      rows = await leadsByPhone(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ urgent: true, enquiry_count: 2 });
      const merged = await db.execute(sql`select note from lead_events where lead_id = ${rows[0]!.id}::uuid and kind = 'enquiry_merged'`);
      expect((merged.rows[0] as { note: string }).note).toBe("Name given: Priya S\nAlso a blouse");

      const third = await enquire({ name: "Priya Sharma", phone: p, requirement: "Again", formToken: token() });
      expect(third.status).toBe(200);
      const reply = json<{ result: string; message: string }>(third);
      expect(reply.result).toBe("already_received");
      expect(reply.message).toContain("already received your enquiries today");
      rows = await leadsByPhone(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.enquiry_count).toBe(2);
    });

    it("a repeat enquiry reopens a discarded lead for the owner", async () => {
      const p = phone();
      await enquire({ name: "Asha Rao", phone: p, requirement: "Kurta set", formToken: token() });
      const [lead] = await leadsByPhone(p);
      await db.execute(sql`update leads set status = 'discarded' where id = ${lead!.id}::uuid`);
      await enquire({ name: "Asha Rao", phone: p, requirement: "Please call", formToken: token() });
      expect((await leadsByPhone(p))[0]).toMatchObject({ status: "new", urgent: true });
    });

    it("bots get the same reply but nothing is stored: honeypot filled, or sent faster than a person types", async () => {
      const p = phone();
      const honeypot = await enquire({ name: "Bot Name", phone: p, requirement: "spam", formToken: token(), website: "http://spam.example" });
      expect(honeypot.status).toBe(201);
      expect(json<{ result: string }>(honeypot).result).toBe("received");
      const tooFast = await enquire({ name: "Bot Name", phone: p, requirement: "spam", formToken: leadsService.publicFormConfig().formToken });
      expect(tooFast.status).toBe(201);
      expect(await leadsByPhone(p)).toHaveLength(0);
    });

    it("refuses a missing, tampered or expired form token", async () => {
      const p = phone();
      const [ts, sig] = token().split(".");
      for (const formToken of ["", "garbage", `${Number(ts) - 1000}.${sig}`, leadsService.publicFormConfig(Date.now() - 3 * 60 * 60 * 1000).formToken]) {
        const res = await enquire({ name: "Real Person", phone: p, requirement: "Hello", formToken });
        expect(res.status, formToken).toBe(400);
        expect(json<ErrorJson>(res).code).toBe("ENQUIRY_FORM_EXPIRED");
      }
      expect(await leadsByPhone(p)).toHaveLength(0);
    });

    it("rejects hostile or malformed input with a 4xx -- never a 500, never stored", async () => {
      const p = phone();
      const base = { name: "Real Person", phone: p, requirement: "Hello", formToken: token() };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...base, name: "<script>alert(1)</script>" }, "script name"],
        [{ ...base, name: "Robert'); DROP TABLE leads;--" }, "sql in name"],
        [{ ...base, phone: "' OR 1=1 --" }, "sql in phone"],
        [{ ...base, phone: "12345" }, "short phone"],
        [{ ...base, requirement: "x".repeat(1001) }, "long requirement"],
        [{ ...base, requirement: "   " }, "empty requirement"],
        [{ ...base, status: "converted" }, "extra field"],
        [{ ...base, name: ["array"] }, "wrong type"],
      ];
      for (const [body, label] of cases) {
        const res = await enquire(body);
        expect(res.status, label).toBe(400);
        expect(json<ErrorJson>(res).code, label).toBe("VALIDATION_ERROR");
      }
      // SQL text in the free-text field is just text: stored verbatim, harmless.
      const sqlText = await enquire({ ...base, requirement: "'; DELETE FROM leads; --" });
      expect(sqlText.status).toBe(201);
      expect((await leadsByPhone(p))[0]!.requirement).toBe("'; DELETE FROM leads; --");

      const malformed = await request(app)
        .post("/api/v1/public/enquiries")
        .set("X-Forwarded-For", ip())
        .set("Content-Type", "application/json")
        .send("{bad json");
      expect(malformed.status).toBe(400);
      expect(json<ErrorJson>(malformed).code).toBe("MALFORMED_REQUEST");
      const huge = await enquire({ ...base, requirement: "y".repeat(9000) });
      expect(huge.status).toBe(413);
      expect(json<ErrorJson>(huge).code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("limits one visitor to 5 enquiries an hour (the 6th gets 429)", async () => {
      const visitor = ip();
      for (let i = 0; i < 5; i++) {
        // Invalid bodies still count -- the limit is checked before anything else.
        expect((await enquire({ name: "x" }, visitor)).status).toBe(400);
      }
      const sixth = await enquire({ name: "x" }, visitor);
      expect(sixth.status).toBe(429);
      expect(json<ErrorJson>(sixth).code).toBe("RATE_LIMITED");
    });
  });

  describe("working leads", () => {
    async function newLeadFromForm(name = "Meera Iyer") {
      const p = phone();
      await enquire({ name, phone: p, requirement: "Saree blouse", formToken: token() });
      return (await leadsByPhone(p))[0]!.id;
    }

    it("owner assigns; only that designer sees it; Received clears their badge; comments and history are kept", async () => {
      const { auth: owner } = await signIn("owner_manager", "Leads Owner");
      const { user: designer, auth: dAuth } = await signIn("designer", "Leads Designer");
      const { auth: otherDesigner } = await signIn("designer", "Other Designer");
      const leadId = await newLeadFromForm();

      expect(await badge(owner)).toBeGreaterThanOrEqual(1);
      expect((await get(`/leads/${leadId}`, dAuth)).status).toBe(404); // not theirs yet

      const assigned = await patch(`/leads/${leadId}/assign`, owner, { designerId: designer.id });
      expect(assigned.status).toBe(200);
      expect(json<{ lead: LeadJson }>(assigned).lead).toMatchObject({ status: "assigned", assignedTo: designer.id, assignedToName: "Leads Designer" });
      expect(await badge(dAuth)).toBe(1);

      const list = json<{ leads: LeadJson[] }>(await get("/leads?status=open", dAuth));
      expect(list.leads.map((l) => l.id)).toEqual([leadId]);
      expect((await get(`/leads/${leadId}`, otherDesigner)).status).toBe(404);

      // Designer can't skip "Received".
      expect((await patch(`/leads/${leadId}/status`, dAuth, { status: "attended" })).status).toBe(403);
      const received = await patch(`/leads/${leadId}/status`, dAuth, { status: "unattended" });
      expect(json<{ lead: LeadJson }>(received).lead.status).toBe("unattended");
      expect(await badge(dAuth)).toBe(0);

      expect((await post(`/leads/${leadId}/comments`, dAuth, { body: "Called, will visit Saturday" })).status).toBe(201);
      await post(`/leads/${leadId}/comments`, dAuth, { body: "Visited, wants 2 options" });
      const followUp = await patch(`/leads/${leadId}/status`, dAuth, { status: "follow_up", followUpOn: "2039-01-10" });
      expect(json<{ lead: LeadJson }>(followUp).lead).toMatchObject({ status: "follow_up", followUpOn: "2039-01-10" });
      // A follow-up date in the past is refused.
      expect((await patch(`/leads/${leadId}/status`, dAuth, { status: "follow_up", followUpOn: "2020-01-01" })).status).toBe(400);

      const detail = json<DetailJson>(await get(`/leads/${leadId}`, owner));
      expect(detail.comments.map((c) => [c.body, c.authorName])).toEqual([
        ["Called, will visit Saturday", "Leads Designer"],
        ["Visited, wants 2 options", "Leads Designer"],
      ]);
      expect(detail.events.map((e) => `${e.kind}:${e.toStatus}`)).toEqual([
        "created:new",
        "assigned:assigned",
        "status_changed:unattended",
        "status_changed:follow_up",
      ]);
      expect(detail.actions.canConvert).toBe(true);
    });

    it("owner-only actions: designers can't add, assign or discard; the owner discards only unassigned leads", async () => {
      const { auth: owner } = await signIn("owner_manager", "Discard Owner");
      const { user: designer, auth: dAuth } = await signIn("designer", "Discard Designer");
      const leadId = await newLeadFromForm();
      expect((await patch(`/leads/${leadId}/assign`, dAuth, { designerId: designer.id })).status).toBe(403);
      expect((await post("/leads", dAuth, { customerName: "X Y", phone: phone(), requirement: "", source: "walk_in" })).status).toBe(403);

      const discarded = await patch(`/leads/${leadId}/status`, owner, { status: "discarded" });
      expect(json<{ lead: LeadJson }>(discarded).lead.status).toBe("discarded");
      const restored = await patch(`/leads/${leadId}/status`, owner, { status: "new" });
      expect(json<{ lead: LeadJson }>(restored).lead.status).toBe("new");
      await patch(`/leads/${leadId}/assign`, owner, { designerId: designer.id });
      expect((await patch(`/leads/${leadId}/status`, owner, { status: "discarded" })).status).toBe(403);
      // Lost needs a reason.
      expect((await patch(`/leads/${leadId}/status`, owner, { status: "lost" })).status).toBe(400);
    });

    it("the owner's manual lead (optionally assigned at once) and the summary", async () => {
      const { auth: owner } = await signIn("owner_manager", "Manual Owner");
      const { user: designer } = await signIn("designer", "Manual Designer");
      const p = phone();
      const created = await post("/leads", owner, { customerName: "Walk In", phone: p, requirement: "Anarkali", source: "walk_in", assignTo: designer.id });
      expect(created.status).toBe(201);
      expect(json<{ lead: LeadJson }>(created).lead).toMatchObject({
        status: "assigned",
        source: "walk_in",
        assignedTo: designer.id,
        leadNumber: expect.stringMatching(/^LEAD-\d{4}-\d{3,}$/) as unknown,
      });

      const summary = json<{ byStatus: Record<string, number> }>(await get("/leads/summary", owner));
      expect(summary.byStatus.assigned).toBeGreaterThanOrEqual(1);

      // The Designers table: searched by name and paged in the API (owner only).
      type DesignersPage = { designers: { designerId: string; designerName: string; waiting: number; open: number }[]; total: number; limit: number };
      const found = json<DesignersPage>(await get("/leads/designers?q=Manual%20Desig&limit=5", owner));
      expect(found.limit).toBe(5);
      expect(found.designers.find((d) => d.designerId === designer.id)).toMatchObject({ designerName: "Manual Designer", waiting: 1, open: 1 });
      expect(found.designers.every((d) => d.designerName.includes("Manual Desig"))).toBe(true);
      const page = json<DesignersPage>(await get("/leads/designers?limit=1&offset=0", owner));
      expect(page.designers).toHaveLength(1);
      expect(page.total).toBeGreaterThanOrEqual(1);
      expect((await get("/leads/designers?limit=500", owner)).status).toBe(400); // capped at 50
      const { auth: dAuth } = await signIn("designer", "Nosy Stats Designer");
      expect((await get("/leads/designers", dAuth)).status).toBe(403);

      // The designer type-ahead (assign / filter) searches the team instead of loading everyone.
      const ta = json<{ members: { id: string; fullName: string }[] }>(await get("/team-members?role=designer&q=Manual%20Desig&limit=5", owner));
      expect(ta.members.map((m) => m.id)).toContain(designer.id);
      expect(ta.members.length).toBeLessThanOrEqual(5);
      expect((await get("/team-members?role=designer&limit=21", owner)).status).toBe(400);

      expect((await post("/leads", owner, { customerName: "Walk In", phone: p, requirement: "", source: "public_form" })).status).toBe(400);
      // Assigning to someone who isn't an active designer is refused.
      const { user: accountant } = await signIn("accountant", "Not A Designer");
      const wrong = await post("/leads", owner, { customerName: "Walk In", phone: phone(), requirement: "", source: "walk_in", assignTo: accountant.id });
      expect(json<ErrorJson>(wrong).code).toBe("LEAD_ASSIGNEE_INVALID");
    });

    it("saving an order for a lead converts it in the same transaction; a lead that can't convert blocks the order", async () => {
      const { auth: owner } = await signIn("owner_manager", "Convert Owner");
      const { user: designer, auth: dAuth } = await signIn("designer", "Convert Designer");
      const masterTailor = await createFixtureUser("master_tailor", "Convert Master");
      userIds.push(masterTailor.id);
      const leadId = await newLeadFromForm("Kavya Nair");
      await patch(`/leads/${leadId}/assign`, owner, { designerId: designer.id });

      const orderBody = (bill: string) => ({
        customerName: "Kavya Nair",
        phone: "9000000041",
        billNumber: bill,
        dueDate: "2039-02-01",
        designerId: designer.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "From lead",
        totalAmount: 5000,
        productionStatus: "design_pending",
        leadId,
      });

      // Not received yet -> the designer can't convert, and no order is created.
      const blocked = await post("/orders", dAuth, orderBody(`LEAD-BLOCK-${Date.now()}`));
      expect(blocked.status).toBe(409);
      expect(json<ErrorJson>(blocked).code).toBe("LEAD_NOT_CONVERTIBLE");
      const none = await db.execute(sql`select count(*)::int as n from orders where bill_number like 'LEAD-BLOCK-%'`);
      expect((none.rows[0] as { n: number }).n).toBe(0);

      await patch(`/leads/${leadId}/status`, dAuth, { status: "unattended" });
      const made = await post("/orders", dAuth, orderBody(`LEAD-OK-${Date.now()}`));
      expect(made.status).toBe(201);
      const order = json<{ order: { id: string; orderNumber: string } }>(made).order;
      orderIds.push(order.id);

      const detail = json<DetailJson>(await get(`/leads/${leadId}`, dAuth));
      expect(detail.lead).toMatchObject({ status: "converted", convertedOrderId: order.id, convertedOrderNumber: order.orderNumber, urgent: false });
      expect(detail.events.at(-1)).toMatchObject({ kind: "converted", toStatus: "converted", note: `Order ${order.orderNumber}` });

      // Converted is final: a second order for it is refused.
      expect((await post("/orders", owner, orderBody(`LEAD-AGAIN-${Date.now()}`))).status).toBe(409);
    });

    it("no access to leads for the other roles", async () => {
      for (const role of ["accountant", "production_manager"] as const) {
        const { auth } = await signIn(role, `No Leads ${role}`);
        expect((await get("/leads", auth)).status, role).toBe(403);
        expect((await get("/leads/badge", auth)).status, role).toBe(403);
      }
    });
  });
});
