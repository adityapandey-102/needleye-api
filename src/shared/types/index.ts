import type { Role } from "../constants/roles";
import type { GranularStatus } from "../constants/orderStatus";
import type { ProductCategory, PaymentStatus, PaymentMethod } from "../constants/productCategories";

export interface Profile {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface OrderImage {
  id: string;
  orderId: string;
  slot: 1 | 2 | 3 | 4;
  storagePath: string;
  url: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface OrderStatusHistoryEntry {
  id: string;
  orderId: string;
  status: GranularStatus;
  label: string | null;
  changedBy: string | null;
  changedByName?: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  method: PaymentMethod;
  paidAt: string;
  recordedBy: string;
  recordedByName?: string | null;
  notes: string | null;
  createdAt: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  billNumber: string;
  bookingDate: string;
  dueDate: string;
  designerId: string;
  designerName?: string;
  masterTailorId: string;
  masterTailorName?: string;
  productCategory: ProductCategory;
  orderDetails: string;
  handWork: boolean;
  machineWork: boolean;
  purchaseRequired: boolean;
  paymentStatus: PaymentStatus;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
  productionStatus: GranularStatus;
  designerInstructions: string | null;
  specialNotes: string | null;
  images: OrderImage[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderStats {
  total: number;
  active: number;
  completed: number;
  pendingPayments: number;
  collectedRevenue: number;
  outstandingRevenue: number;
}

export interface TimelineSummary {
  statusLabel: "ON TRACK" | "DUE SOON" | "URGENT" | "OVERDUE" | "N/A";
  tone: "green" | "amber" | "red" | "dark-red" | "gray";
  daysRemainingLabel: string;
  orderAgeLabel: string;
  remainingDays: number | null;
}
