import type { PaymentEntity } from "../domain/payment.entity";
import type { PaymentResponseDto } from "./dto/payment.response.dto";

/**
 * Domain entity -> API response DTO. Identical field-for-field today, but
 * kept as an explicit function rather than returning the entity directly:
 * the API contract and the domain model are allowed to diverge later
 * (e.g. a domain-only field that shouldn't be serialized) without either
 * side silently leaking into the other.
 */
export function toPaymentResponseDto(entity: PaymentEntity): PaymentResponseDto {
  return { ...entity };
}
