import type { OrderStatusHistoryEntity } from "../domain/order-status-history.entity";
import type { OrderStatusHistoryResponseDto } from "./dto/order-status-history.response.dto";

/** Domain entity -> API response DTO. Identical today; kept explicit so the two can diverge later without either leaking into the other. */
export function toOrderStatusHistoryResponseDto(entity: OrderStatusHistoryEntity): OrderStatusHistoryResponseDto {
  return { ...entity };
}
