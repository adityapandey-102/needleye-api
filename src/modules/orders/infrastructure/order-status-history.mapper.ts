import type { GranularStatus } from "../../../domain";
import type { OrderStatusHistoryEntity } from "../domain/order-status-history.entity";

/** Raw Drizzle query result shape (leftJoin with profiles for the changer's name) -- infrastructure-only, never leaves this layer. */
export type OrderStatusHistoryRow = {
  id: string;
  orderId: string;
  status: GranularStatus;
  label: string;
  changedBy: string | null;
  createdAt: Date;
  changerFullName: string | null;
};

export const OrderStatusHistoryMapper = {
  toEntity(row: OrderStatusHistoryRow): OrderStatusHistoryEntity {
    return {
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      label: row.label,
      changedBy: row.changedBy,
      changedByName: row.changerFullName ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  },
};
