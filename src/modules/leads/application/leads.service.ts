import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { businessToday } from "../../../common/time/business-date";
import { getCapabilityScope, type Role } from "../../../domain";
import { ENQUIRY_MESSAGES } from "../domain/enquiry.rules";
import {
  allowedNextStatuses,
  assertAssignable,
  assertStatusChange,
  clearsUrgent,
  convertibleFrom,
  type LeadActor,
} from "../domain/lead-status.rules";
import type { LeadEntity, LeadStatus } from "../domain/lead.entity";
import type { LeadScope, LeadsRepository } from "./ports/leads-repository.port";
import type { HumanCheck } from "./ports/human-check.port";
import { checkFormToken, issueFormToken } from "./form-token";
import type {
  AddLeadCommentDto,
  AssignLeadDto,
  ChangeLeadStatusDto,
  CreateLeadDto,
  DesignerStatsQuery,
  ListLeadsQuery,
  PublicEnquiryDto,
} from "../api/dto/leads.dto";

/** The signed-in person acting on leads. */
export interface LeadsCaller {
  userId: string;
  role: Role;
}

export interface PublicFormSettings {
  /** Signs the form's timing token. */
  formSecret: string;
  /** Present only when Turnstile is switched on -- the form then shows the widget. */
  turnstileSiteKey: string | null;
}

/** What the form shows after a submit -- the same calm wording whatever happened behind the scenes. */
export interface EnquiryReply {
  result: "received" | "already_received";
  message: string;
}

export class LeadsService {
  constructor(
    private readonly repo: LeadsRepository,
    private readonly options: { timeZone: string; publicForm: PublicFormSettings },
    private readonly humanCheck: HumanCheck | null,
  ) {}

  // -- who may do what ---------------------------------------------------------

  /** owner = leads:manage (all leads, every action); designer = their own leads; anyone else has no leads. */
  private actorOf(caller: LeadsCaller): LeadActor {
    if (getCapabilityScope(caller.role, "leads:manage") === true) return "owner";
    if (getCapabilityScope(caller.role, "leads:read") === "assigned") return "designer";
    throw new ForbiddenError("Your role has no access to leads");
  }

  private scopeOf(caller: LeadsCaller): LeadScope {
    return this.actorOf(caller) === "owner" ? { kind: "all" } : { kind: "assigned", userId: caller.userId };
  }

  /** The lead, if the caller may see it. A designer asking for someone else's lead gets 404 -- not even its existence leaks. */
  private async visibleLead(caller: LeadsCaller, id: string): Promise<LeadEntity> {
    const lead = await this.repo.findById(id);
    if (!lead || (this.actorOf(caller) === "designer" && lead.assignedTo !== caller.userId)) {
      throw new NotFoundError("Lead not found", ERROR_CODES.LEAD_NOT_FOUND);
    }
    return lead;
  }

  private requireOwner(caller: LeadsCaller): void {
    if (this.actorOf(caller) !== "owner") throw new ForbiddenError("Only the owner can do this", ERROR_CODES.LEAD_STATUS_FORBIDDEN);
  }

  // -- reading ------------------------------------------------------------------

  async list(caller: LeadsCaller, query: ListLeadsQuery) {
    const scope = this.scopeOf(caller);
    const { leads, total } = await this.repo.list({
      scope,
      status: query.status,
      urgentOnly: query.urgent,
      q: query.q,
      // A designer's view is their own leads, full stop.
      assignedTo: scope.kind === "all" ? query.assignedTo : undefined,
      limit: query.limit,
      offset: query.offset,
    });
    return { leads, total, limit: query.limit, offset: query.offset };
  }

  summary(caller: LeadsCaller) {
    return this.repo.summary(this.scopeOf(caller));
  }

  /** Owner: the Designers table -- searched and paged in the database, never the whole team at once. */
  async designerStats(caller: LeadsCaller, query: DesignerStatsQuery) {
    this.requireOwner(caller);
    const { designers, total } = await this.repo.designerStats(query);
    return { designers, total, limit: query.limit, offset: query.offset };
  }

  async badge(caller: LeadsCaller): Promise<{ count: number }> {
    return { count: await this.repo.badgeCount(this.scopeOf(caller)) };
  }

  /** One lead with its comments, history, and what the caller may do next (the UI shows only those buttons). */
  async detail(caller: LeadsCaller, id: string) {
    const actor = this.actorOf(caller);
    const lead = await this.visibleLead(caller, id);
    const [comments, events, samePhone] = await Promise.all([
      this.repo.listComments(id),
      this.repo.listEvents(id),
      actor === "owner" ? this.repo.findSamePhone(lead.phone, id, 5) : Promise.resolve([]),
    ]);
    const nextStatuses = allowedNextStatuses(actor, lead.status).filter(
      (s) => !(lead.status === "lost" && s === "unattended" && !lead.assignedTo),
    );
    return {
      lead,
      comments,
      events,
      samePhone,
      actions: {
        nextStatuses,
        canAssign: actor === "owner" && !["converted", "lost", "discarded"].includes(lead.status),
        canConvert: convertibleFrom(actor).includes(lead.status),
        canComment: true,
      },
    };
  }

  // -- writing ------------------------------------------------------------------

  async createManual(caller: LeadsCaller, dto: CreateLeadDto) {
    this.requireOwner(caller);
    const assignTo = dto.assignTo ?? null;
    if (assignTo) await this.assertDesigner(assignTo);
    return this.repo.createManual({
      customerName: dto.customerName,
      phone: dto.phone,
      requirement: dto.requirement,
      source: dto.source as Exclude<LeadEntity["source"], "public_form">,
      assignTo,
      createdBy: caller.userId,
    });
  }

  async assign(caller: LeadsCaller, id: string, dto: AssignLeadDto) {
    this.requireOwner(caller);
    await this.assertDesigner(dto.designerId);
    return this.repo.assign(id, dto.designerId, caller.userId, (current) => assertAssignable(current.status), dto.version);
  }

  async changeStatus(caller: LeadsCaller, id: string, dto: ChangeLeadStatusDto) {
    const actor = this.actorOf(caller);
    await this.visibleLead(caller, id);
    const followUpOn = dto.status === "follow_up" ? (dto.followUpOn ?? null) : null;
    if (followUpOn && followUpOn < businessToday(new Date(), this.options.timeZone)) {
      throw new BadRequestError("The follow-up date can't be in the past", ERROR_CODES.VALIDATION_ERROR);
    }
    return this.repo.changeStatus(
      id,
      caller.userId,
      (current) => {
        // Re-checked against the LOCKED row: the stage may have moved since the visibility read.
        if (actor === "designer" && current.assignedTo !== caller.userId) {
          throw new NotFoundError("Lead not found", ERROR_CODES.LEAD_NOT_FOUND);
        }
        assertStatusChange({ actor, from: current.status, to: dto.status, hasAssignee: current.assignedTo !== null, lostReason: dto.lostReason });
        return {
          to: dto.status,
          followUpOn,
          lostReason: dto.status === "lost" ? (dto.lostReason ?? null) : null,
          clearUrgent: clearsUrgent(dto.status),
          note: noteFor(dto.status, followUpOn, dto.lostReason ?? null),
        };
      },
      dto.version,
    );
  }

  async addComment(caller: LeadsCaller, id: string, dto: AddLeadCommentDto) {
    await this.visibleLead(caller, id);
    return this.repo.addComment(id, caller.userId, dto.body);
  }

  private async assertDesigner(userId: string): Promise<void> {
    if (!(await this.repo.isActiveDesigner(userId))) {
      throw new BadRequestError("Leads can only be assigned to an active designer", ERROR_CODES.LEAD_ASSIGNEE_INVALID);
    }
  }

  // -- the public enquiry form --------------------------------------------------

  /** What the open form needs before showing: its signed open-time, and the Turnstile site key if switched on. */
  publicFormConfig(now: number = Date.now()) {
    return { formToken: issueFormToken(this.options.publicForm.formSecret, now), turnstileSiteKey: this.options.publicForm.turnstileSiteKey };
  }

  /**
   * A submission from the open form. The customer always gets a calm answer;
   * bot-like submissions (honeypot filled, sent faster than a person types) get
   * the same "received" reply but nothing is stored, so a bot learns nothing.
   */
  async submitPublicEnquiry(dto: PublicEnquiryDto, meta: { ip: string | undefined; now?: Date }): Promise<{ reply: EnquiryReply; stored: boolean }> {
    const now = meta.now ?? new Date();
    const received: EnquiryReply = { result: "received", message: ENQUIRY_MESSAGES.received };

    if (dto.website && dto.website.trim() !== "") return { reply: received, stored: false };

    const token = checkFormToken(dto.formToken, this.options.publicForm.formSecret, now.getTime());
    if (token === "too_fast") return { reply: received, stored: false };
    if (token !== "ok") {
      throw new BadRequestError("This form has expired — please reload the page and try again", ERROR_CODES.ENQUIRY_FORM_EXPIRED);
    }

    if (this.humanCheck) {
      const passed = await this.humanCheck.verify(dto.turnstileToken ?? "", meta.ip);
      if (!passed) throw new BadRequestError("We couldn't verify the form — please try again", ERROR_CODES.ENQUIRY_VERIFICATION_FAILED);
    }

    const outcome = await this.repo.submitEnquiry({ customerName: dto.name, phone: dto.phone, requirement: dto.requirement }, now);
    if (outcome === "limit") return { reply: { result: "already_received", message: ENQUIRY_MESSAGES.alreadyReceived }, stored: false };
    return { reply: received, stored: true };
  }
}

function noteFor(to: LeadStatus, followUpOn: string | null, lostReason: string | null): string | null {
  if (to === "follow_up" && followUpOn) return `Follow up on ${followUpOn}`;
  if (to === "lost" && lostReason) return lostReason;
  return null;
}
