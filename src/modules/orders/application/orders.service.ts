import { env } from "../../../config/env";
import { BadRequestError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { assertFieldsEditable, assertOwnershipForScopedEdit } from "../domain/order-edit.rules";
import { assertTotalCoversLedger, derivePaymentStatus } from "../domain/order-ledger.rules";
import { assertCanChangeStage } from "../domain/order-status.rules";
import { toOrderResponseDto } from "../api/order.presenter";
import { toOrderStatusHistoryResponseDto } from "../api/order-status-history.presenter";
import { toOrderStatsResponseDto } from "../api/order-stats.presenter";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../../../common/audit/audit-actions";
import { auditLogger as defaultAuditLogger } from "../../../common/audit/drizzle-audit-logger";
import { logger } from "../../../common/logger/logger";
import { toMoneyString, type MoneyLike } from "../../../common/money/money";
import type { AuditLogger } from "../../../common/audit/audit-logger";
import type { GranularStatus, Profile } from "../../../domain";
import type { StorageProvider } from "../../../common/storage/storage-provider";
import type { OrderEntity } from "../domain/order.entity";
import type {
  OrdersRepositoryPort,
  OrderListFilters,
  OrderListPage,
  NewOrderRecord,
  UpdateOrderRecord,
} from "./ports/orders-repository.port";
import type { CreateOrderDto } from "../api/dto/create-order.dto";
import type { UpdateOrderDto } from "../api/dto/update-order.dto";
import type { OrderResponseDto } from "../api/dto/order.response.dto";
import type { OrderStatusHistoryResponseDto } from "../api/dto/order-status-history.response.dto";
import type { OrderStatsResponseDto } from "../api/dto/order-stats.response.dto";
import type { RevenueResponseDto } from "../api/dto/revenue.response.dto";
import type { StaffReportResponseDto } from "../api/dto/staff-report.response.dto";
import type { LedgerEventsResponseDto, LedgerEventDto, LedgerAmountSnapshot } from "../api/dto/ledger-events.response.dto";
import type { LedgerEventRaw } from "./ports/orders-repository.port";

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
  orders: OrderResponseDto[];
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
    const [sums, signedUrls] = await Promise.all([
      this.ordersRepository.sumPaymentsForOrders(entities.map((e) => e.id)),
      this.signImageUrls(entities),
    ]);
    const orders = entities.map((entity) => toOrderResponseDto(entity, sums[entity.id] ?? "0.00", ctx.profile.role, signedUrls));
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

  async createOrder(ctx: AuthContext, dto: CreateOrderDto): Promise<OrderResponseDto> {
    const record: NewOrderRecord = {
      ...dto,
      bookingDate: dto.bookingDate ?? new Date().toISOString().slice(0, 10),
      nextPaymentDate: dto.nextPaymentDate ?? null,
      // Payment status is derived from the ledger, never chosen at creation. A
      // new order starts unpaid; if the creator records an advance (a separate
      // ledger call right after), that write recomputes and syncs the status.
      paymentStatus: "unpaid",
      designerInstructions: dto.designerInstructions || null,
      specialNotes: dto.specialNotes || null,
      createdBy: ctx.authUserId,
      updatedBy: ctx.authUserId,
    };
    const entity = await this.ordersRepository.create(record);
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_CREATED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: entity.id,
      metadata: { orderNumber: entity.orderNumber },
    });
    // A brand-new order has no ledger entries yet, but fetch for real rather
    // than assume 0 -- keeps this call site identical to every other one.
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(entity.id);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, await this.signImageUrls([entity]));
  }

  async updateOrder(ctx: AuthContext, orderId: string, dto: UpdateOrderDto): Promise<OrderResponseDto> {
    // `version` is the optimistic-lock token, not a field to write -- separate it out.
    const { version: expectedVersion, ...fields } = dto;
    const submittedKeys = Object.keys(fields);
    if (submittedKeys.length === 0) throw new BadRequestError("No editable fields to update", ERROR_CODES.VALIDATION_NO_FIELDS);

    const { needsOwnershipCheck } = assertFieldsEditable(ctx.profile.role, submittedKeys);

    if (needsOwnershipCheck) {
      const existing = await this.ordersRepository.findBasicById(orderId);
      if (!existing) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
      assertOwnershipForScopedEdit(existing.designerId, ctx.authUserId);
    }

    const record: UpdateOrderRecord = { ...fields, updatedBy: ctx.authUserId };
    // If the total changed, keep the ledger invariant intact: the new total can
    // never sit below what's already been collected (that would be an "overpaid"
    // order). Then re-derive the payment status from the (unchanged) ledger sum.
    if (fields.totalAmount !== undefined) {
      const sum = await this.ordersRepository.sumPaymentsForOrder(orderId);
      assertTotalCoversLedger(fields.totalAmount, sum);
      record.paymentStatus = derivePaymentStatus(sum, fields.totalAmount);
    }
    const entity = await this.ordersRepository.update(orderId, record, expectedVersion);
    await this.audit.record({
      action: AUDIT_ACTIONS.ORDER_UPDATED,
      entityType: AUDIT_ENTITIES.ORDER,
      entityId: orderId,
      metadata: { fields: submittedKeys },
    });
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, await this.signImageUrls([entity]));
  }

  /**
   * PATCH /orders/:id/status -- deliberately not gated by requireCapability
   * (the applicable capability depends on the *target* status, which isn't
   * known until the body is parsed), so assertCanChangeStage owns the role/tier
   * decision here. Forward-only ordering, idempotency, and concurrency are
   * enforced atomically inside repository.updateStatus (row-locked), which also
   * 404s a missing order -- so no separate existence read is needed here.
   */
  async updateStatus(ctx: AuthContext, orderId: string, status: GranularStatus): Promise<OrderResponseDto> {
    assertCanChangeStage(ctx.profile.role, status);

    const entity = await this.ordersRepository.updateStatus(orderId, status, ctx.authUserId);
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
