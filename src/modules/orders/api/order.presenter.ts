import { canViewPaymentFields } from "../domain/order-visibility.rules";
import type { StorageProvider } from "../../../common/storage/storage-provider";
import type { Role } from "../../../domain";
import type { OrderEntity } from "../domain/order.entity";
import type { OrderResponseDto } from "./dto/order.response.dto";

/**
 * Domain entity -> API response DTO: resolves each image's signed URL (I/O,
 * hence async -- this is why it's a separate step from the repository's
 * row->entity mapping rather than folded into it) and strips payment
 * fields the caller's role can't see. Takes `storageProvider` as a plain
 * argument (rather than a constructor dependency, unlike OrdersService)
 * so this stays a plain function, consistent with every other converted
 * module's presenter.
 */
export async function toOrderResponseDto(
  entity: OrderEntity,
  amountPaid: number,
  role: Role,
  storageProvider: StorageProvider,
): Promise<OrderResponseDto> {
  const images = await Promise.all(
    entity.images.map(async (img) => ({
      ...img,
      url: await storageProvider.getSignedUrl(img.storagePath),
    })),
  );

  const dto: OrderResponseDto = {
    ...entity,
    images,
    amountPaid,
    outstanding: Math.max(entity.totalAmount - amountPaid, 0),
  };

  if (canViewPaymentFields(role)) return dto;

  const { paymentStatus: _paymentStatus, totalAmount: _totalAmount, amountPaid: _amountPaid, outstanding: _outstanding, ...rest } = dto;
  return rest;
}
