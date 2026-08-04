import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { assertDoesNotExceedTotal, derivePaymentStatus } from "../domain/payment-ledger.rules";
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
 * Application/use-case layer for Payments: orchestrates the repository
 * port and the domain rule, translates domain entities into response
 * DTOs. Depends only on the PaymentsRepositoryPort interface and the pure
 * domain rule function -- never on Drizzle or any concrete adapter.
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
    const order = await this.loadOrderForAccess(ctx, orderId);

    const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
    const newSum = currentSum + dto.amount;
    // Never let the ledger exceed the order total (overpayment) -- always.
    assertDoesNotExceedTotal(newSum, order.totalAmount);

    const entity = await this.paymentsRepository.create({
      orderId,
      amount: dto.amount,
      method: dto.method,
      paidAt: dto.paidAt ?? new Date().toISOString().slice(0, 10),
      recordedBy: ctx.authUserId,
      notes: dto.notes || null,
    });
    // Recompute the order's derived payment state from the new ledger total,
    // and reschedule the next-payment date (cleared once fully paid; set to
    // the supplied date while a balance remains; left as-is if none supplied).
    await this.syncOrderLedgerState(orderId, newSum, order.totalAmount, dto.nextPaymentDate);
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

    const order = await this.loadOrderForAccess(ctx, orderId);
    const existing = await this.paymentsRepository.findById(orderId, paymentId);
    if (!existing) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);

    let newSum: number | null = null;
    if (dto.amount !== undefined) {
      const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
      newSum = currentSum - existing.amount + dto.amount;
      assertDoesNotExceedTotal(newSum, order.totalAmount, "update");
    }

    const updates: UpdatePaymentRecord = {};
    if (dto.amount !== undefined) updates.amount = dto.amount;
    if (dto.method !== undefined) updates.method = dto.method;
    if (dto.paidAt !== undefined) updates.paidAt = dto.paidAt;
    if (dto.notes !== undefined) updates.notes = dto.notes || null;

    const entity = await this.paymentsRepository.update(paymentId, updates);
    // Editing an amount changes the derived status -- resync it (the next
    // date isn't touched here; that's rescheduled when recording a payment).
    if (newSum !== null) await this.syncOrderLedgerState(orderId, newSum, order.totalAmount);
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
    const order = await this.loadOrderForAccess(ctx, orderId);
    const existing = await this.paymentsRepository.findById(orderId, paymentId);
    if (!existing) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);

    const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
    await this.paymentsRepository.delete(paymentId);
    // Removing a payment lowers the ledger total -- resync the derived status.
    await this.syncOrderLedgerState(orderId, currentSum - existing.amount, order.totalAmount);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_DELETED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: paymentId,
      // The removed values, so the ledger-event history can show what was deleted.
      metadata: { orderId, amount: existing.amount, method: existing.method, paidAt: existing.paidAt },
    });
  }

  /**
   * Recomputes the order's derived payment status from its new ledger total and
   * writes it back, along with the rescheduled next-payment date: cleared once
   * fully paid, set to `nextPaymentDate` when a balance remains and a date was
   * supplied, otherwise left unchanged (undefined). The single place a ledger
   * change touches order-level state.
   */
  private async syncOrderLedgerState(
    orderId: string,
    newSum: number,
    totalAmount: number,
    nextPaymentDate?: string | null,
  ): Promise<void> {
    const paymentStatus = derivePaymentStatus(newSum, totalAmount);
    const nextDate = paymentStatus === "fully_paid" ? null : nextPaymentDate;
    await this.paymentsRepository.updateOrderLedgerState(orderId, { paymentStatus, nextPaymentDate: nextDate });
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
