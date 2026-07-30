import { canViewPaymentFields } from "../domain/order-visibility.rules";
import type { Role } from "../../../domain";
import type { OrderStatsRaw } from "../application/ports/orders-repository.port";
import type { OrderStatsResponseDto } from "./dto/order-stats.response.dto";

/** Raw aggregates -> API response DTO: strips payment-related fields the caller's role can't see (same rule as toOrderResponseDto). */
export function toOrderStatsResponseDto(stats: OrderStatsRaw, role: Role): OrderStatsResponseDto {
  const { total, active, completed, thisMonth, inProduction, overdue, urgent, pendingPayments, collectedRevenue, outstandingRevenue } = stats;

  if (!canViewPaymentFields(role)) return { total, active, completed, thisMonth, inProduction, overdue, urgent };

  return { total, active, completed, thisMonth, inProduction, overdue, urgent, pendingPayments, collectedRevenue, outstandingRevenue };
}
