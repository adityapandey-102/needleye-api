import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { toPaymentResponseDto } from "../api/payment.presenter";
import type { Profile } from "../../../domain";
import type { OrderLedgerContext } from "../domain/payment.entity";
import { assertPaidAtNotFuture } from "../domain/payment-ledger.rules";
import type { PaymentsRepositoryPort, UpdatePaymentRecord } from "./ports/payments-repository.port";
import type { CreatePaymentDto } from "../api/dto/create-payment.dto";
import type { UpdatePaymentDto } from "../api/dto/update-payment.dto";
import type { PaymentResponseDto } from "../api/dto/payment.response.dto";
import { businessToday } from "../../../common/time/business-date";
import { env } from "../../../config/env";

interface AuthContext {
  profile: Profile;
  authUserId: string;
  /** Set by requireCapability for whichever of payments:read/payments:manage gated this request. */
  capabilityScope?: boolean | "assigned";
}

/**
 * Application/use-case layer for Payments: enforces access and translates
 * domain entities into response DTOs. The money invariant (no overpayment),
 * the derived-status recompute and the payment_audit_log row all live in the
 * repository's atomic, order-locked mutations (recordPayment/editPayment/
 * removePayment), so concurrent writes to the same order can't race and a
 * money change can't happen without its log row -- see ADR 0005 and 0008.
 * Depends only on the PaymentsRepositoryPort interface, never on Drizzle or
 * any concrete adapter.
 */
export class PaymentsService {
  constructor(private readonly paymentsRepository: PaymentsRepositoryPort) {}

  async listPayments(ctx: AuthContext, orderId: string): Promise<PaymentResponseDto[]> {
    await this.loadOrderForAccess(ctx, orderId);
    const entities = await this.paymentsRepository.findByOrderId(orderId);
    return entities.map(toPaymentResponseDto);
  }

  async addPayment(ctx: AuthContext, orderId: string, dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    await this.loadOrderForAccess(ctx, orderId);
    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);
    if (dto.paidAt !== undefined) assertPaidAtNotFuture(dto.paidAt, today);

    // The overpayment check, the insert, and the order-status recompute all
    // happen atomically under an order row lock inside the repository, so two
    // concurrent payments on the same order can't both slip past the check.
    const entity = await this.paymentsRepository.recordPayment(
      {
        orderId,
        amount: dto.amount,
        method: dto.method,
        // The shop's today, not UTC's: a payment at 00:30 IST on the 1st belongs to the new month.
        paidAt: dto.paidAt ?? today,
        recordedBy: ctx.authUserId,
        notes: dto.notes || null,
      },
      dto.nextPaymentDate,
    );
    return toPaymentResponseDto(entity);
  }

  async updatePayment(ctx: AuthContext, orderId: string, paymentId: string, dto: UpdatePaymentDto): Promise<PaymentResponseDto> {
    if (Object.keys(dto).length === 0) throw new BadRequestError("No fields to update", ERROR_CODES.VALIDATION_NO_FIELDS);

    await this.loadOrderForAccess(ctx, orderId);
    if (dto.paidAt !== undefined) assertPaidAtNotFuture(dto.paidAt, businessToday(new Date(), env.BUSINESS_TIMEZONE));

    const updates: UpdatePaymentRecord = {};
    if (dto.amount !== undefined) updates.amount = dto.amount;
    if (dto.method !== undefined) updates.method = dto.method;
    if (dto.paidAt !== undefined) updates.paidAt = dto.paidAt;
    if (dto.notes !== undefined) updates.notes = dto.notes || null;

    // The before/after record is written by the repository, in the edit's own transaction.
    const entity = await this.paymentsRepository.editPayment(orderId, paymentId, updates, ctx.authUserId);
    if (!entity) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);
    return toPaymentResponseDto(entity);
  }

  async deletePayment(ctx: AuthContext, orderId: string, paymentId: string): Promise<void> {
    await this.loadOrderForAccess(ctx, orderId);
    // The removed values are logged by the repository, in the removal's own transaction.
    const removed = await this.paymentsRepository.removePayment(orderId, paymentId, ctx.authUserId);
    if (!removed) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);
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
