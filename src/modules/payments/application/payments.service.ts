import { BadRequestError, ForbiddenError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { assertLedgerReconciles } from "../domain/payment-ledger.rules";
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

    if (order.paymentStatus === "fully_paid") {
      const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
      assertLedgerReconciles(currentSum + dto.amount, order.totalAmount, "save this payment");
    }

    const entity = await this.paymentsRepository.create({
      orderId,
      amount: dto.amount,
      method: dto.method,
      paidAt: dto.paidAt ?? new Date().toISOString().slice(0, 10),
      recordedBy: ctx.authUserId,
      notes: dto.notes || null,
    });
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

    if (order.paymentStatus === "fully_paid" && dto.amount !== undefined) {
      const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
      assertLedgerReconciles(currentSum - existing.amount + dto.amount, order.totalAmount, "save this payment");
    }

    const updates: UpdatePaymentRecord = {};
    if (dto.amount !== undefined) updates.amount = dto.amount;
    if (dto.method !== undefined) updates.method = dto.method;
    if (dto.paidAt !== undefined) updates.paidAt = dto.paidAt;
    if (dto.notes !== undefined) updates.notes = dto.notes || null;

    const entity = await this.paymentsRepository.update(paymentId, updates);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_UPDATED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: paymentId,
      metadata: { orderId, fields: Object.keys(updates) },
    });
    return toPaymentResponseDto(entity);
  }

  async deletePayment(ctx: AuthContext, orderId: string, paymentId: string): Promise<void> {
    const order = await this.loadOrderForAccess(ctx, orderId);
    const existing = await this.paymentsRepository.findById(orderId, paymentId);
    if (!existing) throw new NotFoundError("Payment not found", ERROR_CODES.PAYMENT_NOT_FOUND);

    if (order.paymentStatus === "fully_paid") {
      const currentSum = await this.paymentsRepository.sumByOrderId(orderId);
      assertLedgerReconciles(currentSum - existing.amount, order.totalAmount, "remove this payment");
    }

    await this.paymentsRepository.delete(paymentId);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_DELETED,
      entityType: AUDIT_ENTITIES.PAYMENT,
      entityId: paymentId,
      metadata: { orderId },
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
