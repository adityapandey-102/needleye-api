import type { GranularStatus } from "../../../domain";

/**
 * One row in an order's audit trail -- replaces the prototype's in-object
 * timeline: [] array. `label` is a frozen snapshot of the status's label at
 * the time of the change, not recomputed from the current vocabulary.
 */
export interface OrderStatusHistoryEntity {
  id: string;
  orderId: string;
  status: GranularStatus;
  label: string;
  changedBy: string | null;
  changedByName?: string;
  createdAt: string;
}
