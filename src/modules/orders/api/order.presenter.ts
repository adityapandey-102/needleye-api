import { canViewPaymentFields } from "../domain/order-visibility.rules";
import type { Role } from "../../../domain";
import type { OrderEntity } from "../domain/order.entity";
import type { OrderResponseDto } from "./dto/order.response.dto";

/**
 * Domain entity -> API response DTO: attaches each image's signed URL and
 * strips payment fields the caller's role can't see. Signed URLs are
 * resolved by the caller (OrdersService) in a single batched storage call
 * and passed in as a path->url map, so this stays a pure, synchronous
 * function -- the URL I/O was pulled up to the service specifically to
 * avoid an N+1 across a list of orders (see OrdersService.signImageUrls).
 * A path missing from the map degrades to an empty URL rather than failing.
 */
export function toOrderResponseDto(
  entity: OrderEntity,
  amountPaid: number,
  role: Role,
  signedUrls: Map<string, string>,
  opts?: { viewOnly?: boolean },
): OrderResponseDto {
  const images = entity.images.map((img) => ({
    ...img,
    url: signedUrls.get(img.storagePath) ?? "",
  }));

  const dto: OrderResponseDto = {
    ...entity,
    images,
    amountPaid,
    outstanding: Math.max(entity.totalAmount - amountPaid, 0),
  };

  // Payment fields are stripped when the role can't see them at all, OR when
  // this is a view-only read of an order outside the caller's scope (an
  // authenticated "outsider" reaching it via QR/link -- payments stay hidden
  // even though their role could see payments on their OWN orders).
  if (!opts?.viewOnly && canViewPaymentFields(role)) return dto;

  const { paymentStatus: _paymentStatus, totalAmount: _totalAmount, amountPaid: _amountPaid, outstanding: _outstanding, ...rest } = dto;
  return rest;
}
