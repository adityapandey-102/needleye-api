import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { toPaymentResponseDto } from "../api/payment.presenter";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../../../common/audit/audit-actions";
import { auditLogger as defaultAuditLogger } from "../../../common/audit/drizzle-audit-logger";
import type { AuditLogger } from "../../../common/audit/audit-logger";
import type { Profile } from "../../../domain";
import type { OrderLedgerContext } from "../domain/payment.entity";
import type { PaymentsRepositoryPort, UpdatePaymentRecord } from "./ports/payments-repository.port";
import type { CreatePaymentDto } from "../api/dto/create-payment.dto";
import type { UpdatePaymentDto } from "../api/dto/update-payment.dto";
import type { PaymentResponseDto } from "../api/dto/payment.response.dto";

interface AuthContext {
  profile: Profile;
  authUserId: string;
  /** Set by requireCapability for whichever of payments:read/payments:manage gated this request. */
  capabilityScope?: boolean | "assigned";
}

/**
 * Application/use-case layer for Payments: enforces access, translates domain
 * entities into response DTOs, and writes the audit trail. The money invariant
 * (no overpayment) and the derived-status recompute live in the repository's
 * atomic, order-locked mutations (recordPayment/editPayment/removePayment) so
 * concurrent writes to the same order can't race -- see ADR 0005. Depends only
 * on the PaymentsRepositoryPort interface, never on Drizzle or any concrete
 * adapter.
 */
export class PaymentsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepositoryPort,
    private readonly audit: AuditLogger = defaultAuditLogger,
  ) {}

  async listPayments(ctx: AuthContext, orderId: string): Promise<PaymentResponseDto[]> {
    await this.loadOrderForAccess(ctx, orderId);
    const entities = await this.paymentsRepository.findByOrderId(orderId);
    return entities.map(toPaymentResponseDto);
  }

  async addPayment(ctx: AuthContext, orderId: string, dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    await this.loadOrderForAccess(ctx, orderId);

    // The overpayment check, the insert, and the order-status recompute all
    // happen atomically under an order row lock inside the repository, so two
    // concurrent payments on the same order can't both slip past the check.
    const entity = await this.paymentsRepository.recordPayment(
      {
        orderId,
        amount: dto.amount,
        method: dto.method,
        paidAt: dto.paidAt ?? new Date().toISOString().slice(0, 10),
        recordedBy: ctx.authUserId,
        notes: dto.notes || null,
      },
      dto.nextPaymentDate,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_CREATED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: entity.id,
      metadata: { orderId, amount: dto.amount, method: dto.method },
    });
    return toPaymentResponseDto(entity);
  }

  async updatePayment(ctx: AuthContext, orderId: string, paymentId: string, dto: UpdatePaymentDto): Promise<PaymentResponseDto> {
    if (Object.keys(dto).length === 0) throw new BadRequestError("No fields to update", ERROR_CODES.VALIDATION_NO_FIELDS);

    await this.loadOrderForAccess(ctx, orderId);
    // Read the "before" snapshot for the audit trail (outside the lock is fine --
    // the atomic edit re-reads and re-checks under the lock).
    const existing = await this.paymentsRepository.findById(orderId, paymentId);
    if (!existing) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);

    const updates: UpdatePaymentRecord = {};
    if (dto.amount !== undefined) updates.amount = dto.amount;
    if (dto.method !== undefined) updates.method = dto.method;
    if (dto.paidAt !== undefined) updates.paidAt = dto.paidAt;
    if (dto.notes !== undefined) updates.notes = dto.notes || null;

    const entity = await this.paymentsRepository.editPayment(orderId, paymentId, updates);
    if (!entity) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);
    // Record the full before/after so the ledger-event history can show what
    // changed (e.g. amount ₹800 -> ₹1000).
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_UPDATED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: paymentId,
      metadata: {
        orderId,
        before: { amount: existing.amount, method: existing.method, paidAt: existing.paidAt, notes: existing.notes },
        after: { amount: entity.amount, method: entity.method, paidAt: entity.paidAt, notes: entity.notes },
      },
    });
    return toPaymentResponseDto(entity);
  }

  async deletePayment(ctx: AuthContext, orderId: string, paymentId: string): Promise<void> {
    await this.loadOrderForAccess(ctx, orderId);
    const existing = await this.paymentsRepository.findById(orderId, paymentId);
    if (!existing) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);

    const removed = await this.paymentsRepository.removePayment(orderId, paymentId);
    if (!removed) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_DELETED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: paymentId,
      // The removed values, so the ledger-event history can show what was deleted.
      metadata: { orderId, amount: existing.amount, method: existing.method, paidAt: existing.paidAt },
    });
  }

  /**
   * Loads the order's payment-relevant context and enforces the ownership
   * check for "assigned" scope (a Designer only ever sees/manages payments
   * on their own orders). 404s (not 403) if the order doesn't exist.
   */
  private async loadOrderForAccess(ctx: AuthContext, orderId: string): Promise<OrderLedgerContext> {
    const order = await this.paymentsRepository.findOrderContext(orderId);
    if (!order) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);

    if (ctx.capabilityScope === "assigned" && order.designerId !== ctx.authUserId) {
      throw new ForbiddenError("You can only access payments for orders assigned to you", ERROR_CODES.PAYMENT_NOT_ASSIGNED);
    }

    return order;
  }
}
