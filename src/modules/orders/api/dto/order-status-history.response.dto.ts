import type { GranularStatus } from "../../../../domain";

/** Response shape for one entry in GET /orders/:id/history. */
export interface OrderStatusHistoryResponseDto {
  id: string;
  orderId: string;
  status: GranularStatus;
  label: string;
  changedBy: string | null;
  changedByName?: string;
  createdAt: string;
}
