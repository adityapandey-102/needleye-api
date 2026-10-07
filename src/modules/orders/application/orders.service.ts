import { env } from "../../../config/env";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { assertFieldsEditable, assertOwnershipForScopedEdit } from "../domain/order-edit.rules";
import { derivePaymentStatus } from "../domain/order-ledger.rules";
import {
  assertEditKeepsTotal,
  assertPricedForDelivery,
  canChangePriceAtAll,
  decidePriceChange,
} from "../domain/order-pricing.rules";
import { canViewPaymentFields } from "../domain/order-visibility.rules";
import { assertLedgerExportRange, assertLedgerExportSize, LEDGER_EXPORT_MAX_ROWS } from "../domain/ledger-export.rules";
import { assertCanChangeStage, assertCanSkipStages } from "../domain/order-status.rules";
import { checkDeliveryDayCapacity, nearCapacityThreshold } from "../domain/delivery-capacity.rules";
import { toOrderListItemDto, toOrderResponseDto } from "../api/order.presenter";
import { toOrderStatusHistoryResponseDto } from "../api/order-status-history.presenter";
import { toOrderStatsResponseDto } from "../api/order-stats.presenter";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../../../common/audit/audit-actions";
import { auditLogger as defaultAuditLogger } from "../../../common/audit/drizzle-audit-logger";
import { logger } from "../../../common/logger/logger";
import { toMoneyString, type MoneyLike } from "../../../common/money/money";
import type { AuditLogger } from "../../../common/audit/audit-logger";
import { getCapabilityScope, type GranularStatus, type Profile } from "../../../domain";
import type { StorageProvider } from "../../../common/storage/storage-provider";
import type { OrderEntity } from "../domain/order.entity";
import type {
  OrdersRepositoryPort,
  OrderListFilters,
  OrderListPage,
  NewOrderRecord,
  UpdateOrderRecord,
  DueDateCapacityGuard,
} from "./ports/orders-repository.port";
import type { DeliveryLoadQuery, DeliveryLoadResponseDto } from "../api/dto/delivery-load.dto";
import type { CreateOrderDto } from "../api/dto/create-order.dto";
import type { UpdateOrderDto } from "../api/dto/update-order.dto";
import type { ChangePriceDto } from "../api/dto/change-price.dto";
import type { OrderPriceChangeEntity } from "../domain/order-price-change.entity";
import type { OrderListItemResponseDto, OrderResponseDto } from "../api/dto/order.response.dto";
import type { OrderStatusHistoryResponseDto } from "../api/dto/order-status-history.response.dto";
import type { OrderStatsResponseDto } from "../api/dto/order-stats.response.dto";
import type { RevenueResponseDto } from "../api/dto/revenue.response.dto";
import type { StaffReportResponseDto } from "../api/dto/staff-report.response.dto";
import type {
  LedgerEventsResponseDto,
  LedgerEventDto,
  LedgerAmountSnapshot,
  LedgerExportResponseDto,
} from "../api/dto/ledger-events.response.dto";
import type { LedgerEventRaw, LeadLink } from "./ports/orders-repository.port";
import { businessToday } from "../../../common/time/business-date";

interface AuthContext {
  profile: Profile;
  authUserId: string;
}

/** Pulls a {amount, method} snapshot out of a slice of audit metadata, coercing defensively (old records may predate a field). */
function readSnapshot(source: unknown): LedgerAmountSnapshot {
  const obj = (source ?? {}) as Record<string, unknown>;
  return { amount: toMoneyString(obj.amount as MoneyLike), method: typeof obj.method === "string" ? obj.method : "" };
}

/** Decodes one raw payment-audit record into the display DTO, keying off its action verb. */
function toLedgerEventDto(raw: LedgerEventRaw): LedgerEventDto {
  const meta = raw.metadata ?? {};
  const verb: LedgerEventDto["action"] =
    raw.action === AUDIT_ACTIONS.PAYMENT_CREATED ? "created" : raw.action === AUDIT_ACTIONS.PAYMENT_DELETED ? "deleted" : "updated";

  const base: LedgerEventDto = {
    id: raw.id,
    action: verb,
    at: raw.createdAt,
    actorName: raw.actorName,
    orderId: raw.orderId,
    orderNumber: raw.orderNumber,
  };

  if (verb === "updated") {
    return { ...base, before: readSnapshot(meta.before), after: readSnapshot(meta.after) };
  }
  // created/deleted both record the payment's amount+method at top level.
  return { ...base, snapshot: readSnapshot(meta) };
}

/** A page of orders plus the total matching the filters, so the client can render a pager. */
export interface OrderListResult {
  orders: OrderListItemResponseDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Business logic for the Orders module: RBAC field-level rules, ownership
 * checks, and orchestration across the repository port and storage
 * provider. No direct database or HTTP knowledge -- those are the
 * Infrastructure adapter's and the Controller's jobs respectively.
 */
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepositoryPort,
    private readonly storageProvider: StorageProvider,
    private readonly audit: AuditLogger = defaultAuditLogger,
  ) {}

  /**
   * Resolves every image's signed URL for the given orders in ONE batched
   * storage call, returning a path->url map the presenter reads from. Pulled
   * up here (rather than each presenter signing its own images) so a list of
   * N orders costs one storage round trip, not up to 4N -- see
   * StorageProvider.getSignedUrls.
   */
  private signImageUrls(entities: OrderEntity[]): Promise<Map<string, string>> {
    const paths = entities.flatMap((e) => e.images.map((img) => img.storagePath));
    return this.storageProvider.getSignedUrls(paths);
  }

  async listOrders(ctx: AuthContext, filters: OrderListFilters, page: OrderListPage): Promise<OrderListResult> {
    const scope = { role: ctx.profile.role, userId: ctx.authUserId };
    const [entities, total] = await Promise.all([
      this.ordersRepository.findMany(scope, filters, page),
      this.ordersRepository.countMany(scope, filters),
    ]);
    // No image signing here: list rows carry no images (see toOrderListItemDto),
    // which saves a round trip to storage on every list load.
    const sums = await this.ordersRepository.sumPaymentsForOrders(entities.map((e) => e.id));
    const orders = entities.map((entity) => toOrderListItemDto(entity, sums[entity.id] ?? "0.00", ctx.profile.role));
    return { orders, total, limit: page.limit, offset: page.offset };
  }

  async getOrder(ctx: AuthContext, orderId: string): Promise<OrderResponseDto> {
    // In-scope read (owner/accountant: any order; designer/master: their own).
    const scoped = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (scoped) {
      const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
      return toOrderResponseDto(scoped, amountPaid, ctx.profile.role, await this.signImageUrls([scoped]));
    }

    // Out of scope: any authenticated user may still VIEW a single order
    // (reached via QR/link), but read-only with payment fields stripped. Truly
    // missing orders still 404.
    const any = await this.ordersRepository.findAnyById(orderId);
    if (!any) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    return toOrderResponseDto(any, "0.00", ctx.profile.role, await this.signImageUrls([any]), { viewOnly: true });
  }

  /**
   * GET /orders/delivery-load -- how many orders are due on each day in the
   * window, shop-wide (not row-scoped: capacity is shop-wide and this is bare
   * counts), plus the thresholds the calendar colours by.
   */
  async getDeliveryLoad(query: DeliveryLoadQuery): Promise<DeliveryLoadResponseDto> {
    const capacity = env.DELIVERY_DAY_CAPACITY;
    const days = await this.ordersRepository.countOrdersDueByDay({ from: query.from, to: query.to }, query.excludeOrderId);
    return { capacity, nearCapacity: nearCapacityThreshold(capacity), days };
  }

  /**
   * Builds the capacity guard handed to repository.create/update, which calls it
   * under the per-date lock. Records the day's count in `outcome` when the
   * booking is an override, so the caller can audit it AFTER the write commits
   * (an audit row for a write that then rolled back would be a lie).
   */
  private deliveryCapacityGuard(
    dueDate: string,
    confirmedWithProductionManager: boolean,
    outcome: { overriddenAt?: number },
  ): DueDateCapacityGuard {
    return ({ booked, previousDueDate }) => {
      const { overridden } = checkDeliveryDayCapacity({
        dueDate,
        previousDueDate,
        booked,
        capacity: env.DELIVERY_DAY_CAPACITY,
        confirmedWithProductionManager,
      });
      if (overridden) outcome.overriddenAt = booked;
    };
  }

  private async auditDeliveryOverride(orderId: string, dueDate: string, booked: number): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_DELIVERY_OVERRIDE,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { dueDate, bookedBefore: booked, capacity: env.DELIVERY_DAY_CAPACITY },
    });
  }

  /**
   * Converting a lead needs access to leads: the owner converts any open lead;
   * a designer only their own (the Leads module re-checks under the row lock).
   */
  private leadLinkFor(ctx: AuthContext, leadId: string): LeadLink {
    if (getCapabilityScope(ctx.profile.role, "leads:manage") === true) return { leadId, actorId: ctx.authUserId, actor: "owner" };
    if (getCapabilityScope(ctx.profile.role, "leads:read") === "assigned") return { leadId, actorId: ctx.authUserId, actor: "designer" };
    throw new ForbiddenError("Your role can't create an order from a lead", ERROR_CODES.LEAD_NOT_CONVERTIBLE);
  }

  async createOrder(ctx: AuthContext, dto: CreateOrderDto): Promise<OrderResponseDto> {
    // The PM confirmation and the lead link are request flags, not order fields -- keep them out of the record.
    const { confirmedWithProductionManager = false, leadId, ...fields } = dto;
    const leadLink = leadId ? this.leadLinkFor(ctx, leadId) : undefined;
    // A price at booking is a first "set": the same people who may set one later.
    if (fields.totalAmount !== null) this.assertCanPriceAtBooking(ctx, fields.designerId);
    assertPricedForDelivery(fields.productionStatus, fields.totalAmount);
    const record: NewOrderRecord = {
      ...fields,
      bookingDate: dto.bookingDate ?? businessToday(new Date(), env.BUSINESS_TIMEZONE),
      nextPaymentDate: dto.nextPaymentDate ?? null,
      // Payment status is derived from the ledger, never chosen at creation. A
      // new order has an empty ledger: not_priced (no total -- the usual case),
      // unpaid, or fully_paid when the total is 0 (free work).
      paymentStatus: derivePaymentStatus("0.00", fields.totalAmount),
      designerInstructions: dto.designerInstructions || null,
      specialNotes: dto.specialNotes || null,
      createdBy: ctx.authUserId,
      updatedBy: ctx.authUserId,
    };
    const capacity: { overriddenAt?: number } = {};
    const entity = await this.ordersRepository.create(
      record,
      this.deliveryCapacityGuard(record.dueDate, confirmedWithProductionManager, capacity),
      leadLink,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_CREATED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: entity.id,
      metadata: { orderNumber: entity.orderNumber, ...(leadId ? { leadId } : {}) },
    });
    if (capacity.overriddenAt !== undefined) {
      await this.auditDeliveryOverride(entity.id, record.dueDate, capacity.overriddenAt);
    }
    // A brand-new order has no ledger entries yet, but fetch for real rather
    // than assume 0 -- keeps this call site identical to every other one.
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(entity.id);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, await this.signImageUrls([entity]));
  }

  async updateOrder(ctx: AuthContext, orderId: string, dto: UpdateOrderDto): Promise<OrderResponseDto> {
    // `version` is the optimistic-lock token and `confirmedWithProductionManager`
    // a request flag -- neither is a field to write, so separate both out BEFORE
    // the editable-fields check (which would reject them as unknown fields).
    const { version: expectedVersion, confirmedWithProductionManager = false, totalAmount, ...fields } = dto;
    // The total never changes through an edit (ADR 0008). The edit form may
    // resend it unchanged -- fine, it's dropped; a different value is refused.
    if (totalAmount !== undefined) {
      const current = await this.ordersRepository.findBasicById(orderId);
      if (!current) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
      assertEditKeepsTotal(current.totalAmount, totalAmount);
    }
    const submittedKeys = Object.keys(fields);
    if (submittedKeys.length === 0) throw new BadRequestError("No editable fields to update", ERROR_CODES.VALIDATION_NO_FIELDS);

    const { needsOwnershipCheck } = assertFieldsEditable(ctx.profile.role, submittedKeys);

    if (needsOwnershipCheck) {
      const existing = await this.ordersRepository.findBasicById(orderId);
      if (!existing) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
      assertOwnershipForScopedEdit(existing.designerId, ctx.authUserId);
    }

    const record: UpdateOrderRecord = { ...fields, updatedBy: ctx.authUserId };
    // Only a submitted due date can move the order onto a full day; the guard
    // itself skips an unchanged date (the edit form resends every field).
    const capacity: { overriddenAt?: number } = {};
    const guard =
      fields.dueDate !== undefined
        ? this.deliveryCapacityGuard(fields.dueDate, confirmedWithProductionManager, capacity)
        : undefined;
    const entity = await this.ordersRepository.update(orderId, record, expectedVersion, guard);
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_UPDATED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { fields: submittedKeys },
    });
    if (capacity.overriddenAt !== undefined && fields.dueDate !== undefined) {
      await this.auditDeliveryOverride(orderId, fields.dueDate, capacity.overriddenAt);
    }
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, await this.signImageUrls([entity]));
  }

  /**
   * PATCH /orders/:id/status -- deliberately not gated by requireCapability
   * (the applicable capability depends on the *target* status, which isn't
   * known until the body is parsed), so assertCanChangeStage owns the role/tier
   * decision for the TARGET stage here, before touching the database. Forward-
   * only ordering, idempotency, concurrency, and the no-skipping rule are
   * enforced atomically inside repository.updateStatus (row-locked), which also
   * 404s a missing order -- so no separate existence read is needed here.
   */
  async updateStatus(ctx: AuthContext, orderId: string, status: GranularStatus): Promise<OrderResponseDto> {
    const role = ctx.profile.role;
    assertCanChangeStage(role, status);

    const entity = await this.ordersRepository.updateStatus(orderId, status, ctx.authUserId, (current) =>
      assertCanSkipStages(role, current, status),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { to: status },
    });
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, await this.signImageUrls([entity]));
  }

  async getStats(ctx: AuthContext): Promise<OrderStatsResponseDto> {
    const stats = await this.ordersRepository.getStats({ role: ctx.profile.role, userId: ctx.authUserId });
    return toOrderStatsResponseDto(stats, ctx.profile.role);
  }

  /** Monthly revenue report over an inclusive date range -- route-gated by reports:financial (owner_manager/accountant), whose scope is unscoped. */
  async getRevenue(ctx: AuthContext, range: { from: string; to: string }): Promise<RevenueResponseDto> {
    const periods = await this.ordersRepository.getMonthlyRevenue(
      { role: ctx.profile.role, userId: ctx.authUserId },
      env.ACCOUNTING_CYCLE_START_DAY,
      range,
    );
    return { cycleStartDay: env.ACCOUNTING_CYCLE_START_DAY, from: range.from, to: range.to, periods };
  }

  /**
   * Per-staff workload report -- route-gated by reports:staff (owner_manager
   * only). Loads ONE designer/master's report on demand (the UI drills down
   * role -> person -> here), so all-staff aggregation never happens. 404s when
   * the id isn't an active designer/master_tailor.
   */
  async getStaffReport(staffId: string, month: string): Promise<StaffReportResponseDto> {
    // month is YYYY-MM -> the report covers that calendar month. Compute the
    // last day in UTC so toISOString() can't shift it across a day boundary in
    // a non-UTC server timezone.
    const from = `${month}-01`;
    const parts = month.split("-");
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month (1-based m) = last day of this one
    const report = await this.ordersRepository.getStaffReport(staffId, { from, to });
    if (!report) throw new NotFoundError("No active designer or master tailor with that id", ERROR_CODES.USER_NOT_FOUND);
    return { ...report, month };
  }

  /**
   * Payment-ledger activity feed over an inclusive date range -- route-gated by
   * reports:financial (owner_manager/accountant). Reads the append-only audit
   * trail (payment.created/updated/deleted) and decodes each record's metadata
   * into a display shape (who, when, which order, what changed). Paginated;
   * newest first.
   */
  async getLedgerEvents(range: { from: string; to: string }, page: OrderListPage): Promise<LedgerEventsResponseDto> {
    const { events, total } = await this.ordersRepository.getLedgerEvents(range, page);
    return {
      events: events.map(toLedgerEventDto),
      total,
      limit: page.limit,
      offset: page.offset,
      from: range.from,
      to: range.to,
    };
  }

  /**
   * The Ledger Activity export (CSV / PDF): EVERY ledger event in one week or
   * one month, in one response -- same rows and shape as getLedgerEvents, just
   * not paged. Refuses a window longer than 31 days (no yearly exports) and a
   * window holding more rows than one export may carry.
   */
  async getLedgerExport(range: { from: string; to: string }): Promise<LedgerExportResponseDto> {
    assertLedgerExportRange(range.from, range.to);
    const page = { limit: LEDGER_EXPORT_MAX_ROWS, offset: 0 };
    const { events, total } = await this.ordersRepository.getLedgerEvents(range, page);
    assertLedgerExportSize(total);
    return {
      events: events.map(toLedgerEventDto),
      total,
      limit: page.limit,
      offset: 0,
      from: range.from,
      to: range.to,
      timeZone: env.BUSINESS_TIMEZONE,
    };
  }

  /**
   * PUT /orders/:id/price -- set the first price, raise it, or give a discount
   * (ADR 0008). Which one it is, and whether the caller may make it, is decided
   * against the order's LOCKED state inside the repository's transaction; the
   * price-history row is written in that same transaction.
   */
  async changePrice(
    ctx: AuthContext,
    orderId: string,
    dto: ChangePriceDto,
  ): Promise<{ order: OrderResponseDto; change: OrderPriceChangeEntity }> {
    const role = ctx.profile.role;
    if (!canChangePriceAtAll(role)) {
      throw new ForbiddenError("Your role can't set or change an order's price", ERROR_CODES.ORDER_PRICE_FORBIDDEN);
    }
    const change = await this.ordersRepository.changePrice(
      orderId,
      { newTotal: dto.totalAmount, changedBy: ctx.authUserId },
      (state) => decidePriceChange({ role, callerId: ctx.authUserId, newTotal: dto.totalAmount, reason: dto.reason }, state),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_PRICE_CHANGED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { kind: change.kind, from: change.previousTotal, to: change.newTotal, reason: change.reason },
    });
    const entity = await this.ordersRepository.findAnyById(orderId);
    if (!entity) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return { order: toOrderResponseDto(entity, amountPaid, role, await this.signImageUrls([entity])), change };
  }

  /** An order's price history -- for roles that can see its money, on orders in their scope. */
  async getPriceHistory(ctx: AuthContext, orderId: string): Promise<OrderPriceChangeEntity[]> {
    if (!canViewPaymentFields(ctx.profile.role)) {
      throw new ForbiddenError("Your role can't see order prices", ERROR_CODES.ORDER_PRICE_FORBIDDEN);
    }
    const order = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (!order) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    return this.ordersRepository.listPriceHistory(orderId);
  }

  /** A total given at booking: owner / accountant, or a designer booking their OWN order. */
  private assertCanPriceAtBooking(ctx: AuthContext, designerId: string): void {
    const scope = getCapabilityScope(ctx.profile.role, "orders:price:set");
    if (scope === true || (scope === "assigned" && designerId === ctx.authUserId)) return;
    throw new ForbiddenError(
      "Your role can't set a price -- save the order without one; its designer, the Owner or the Accountant prices it.",
      ERROR_CODES.ORDER_PRICE_FORBIDDEN,
    );
  }

  async getOrderHistory(ctx: AuthContext, orderId: string): Promise<OrderStatusHistoryResponseDto[]> {
    const order = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (!order) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);

    const history = await this.ordersRepository.listStatusHistory(orderId);
    return history.map(toOrderStatusHistoryResponseDto);
  }

  async uploadOrderImage(
    ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
    orderId: string,
    slot: number,
    file: Express.Multer.File,
  ): Promise<{ storagePath: string; url: string }> {
    await this.assertOrderEditable(ctx, orderId);

    // A slot may already hold an image. Each upload writes a new timestamped
    // storage path, so replacing a slot would otherwise orphan the previous
    // object -- capture it now so we can delete it once the DB points at the new one.
    const previous = await this.ordersRepository.findImage(orderId, slot);

    const storagePath = await this.storageProvider.upload(orderId, slot, file);

    await this.ordersRepository.upsertImage({
      orderId,
      slot,
      storagePath,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: ctx.authUserId,
    });

    // DB now references the new object; the old one is safe to remove. Best-effort
    // (a leftover object is a storage-cleanup concern, not something that should
    // fail an otherwise-successful upload).
    if (previous && previous.storagePath !== storagePath) {
      await this.deleteStorageObjectSafely(previous.storagePath);
    }

    return { storagePath, url: await this.storageProvider.getSignedUrl(storagePath) };
  }

  async deleteOrderImage(
    ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
    orderId: string,
    slot: number,
  ): Promise<void> {
    await this.assertOrderEditable(ctx, orderId);

    const image = await this.ordersRepository.findImage(orderId, slot);
    if (!image) return;

    // Remove the DB reference FIRST, then the storage object. This ordering
    // means a storage failure can only leave an orphaned (invisible) object,
    // never a dangling DB row that renders as a broken image in the UI.
    await this.ordersRepository.deleteImage(orderId, slot);
    await this.deleteStorageObjectSafely(image.storagePath);

    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_IMAGE_DELETED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { slot },
    });
  }

  /** Deletes a storage object without letting a storage failure surface -- logs and moves on. */
  private async deleteStorageObjectSafely(storagePath: string): Promise<void> {
    try {
      await this.storageProvider.delete(storagePath);
    } catch (error) {
      logger.error({ err: error, storagePath }, "Failed to delete storage object (now orphaned)");
    }
  }

  private async assertOrderEditable(ctx: AuthContext & { capabilityScope?: boolean | "assigned" }, orderId: string): Promise<void> {
    const order = await this.ordersRepository.findBasicById(orderId);
    if (!order) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    if (ctx.capabilityScope === "assigned") assertOwnershipForScopedEdit(order.designerId, ctx.authUserId);
  }
}
