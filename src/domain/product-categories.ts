export const PRODUCT_CATEGORIES = [
  { value: "designer_blouse", label: "Designer Blouse", emoji: "👚" },
  { value: "saree", label: "Saree", emoji: "🥻" },
  { value: "bridal_lehenga", label: "Bridal Lehenga", emoji: "💍" },
  { value: "custom_ethnic_wear", label: "Custom Ethnic Wear", emoji: "✨" },
  { value: "boutique_fashion", label: "Boutique Fashion", emoji: "🛍️" },
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]["value"];

export const PRODUCT_CATEGORY_VALUES = PRODUCT_CATEGORIES.map((c) => c.value) as [
  ProductCategory,
  ...ProductCategory[],
];

/**
 * Payment status is DERIVED from the ledger (sum of payments vs order total),
 * never chosen by hand -- see derivePaymentStatus in the Orders domain. These
 * three values are the possible derived outcomes, kept as a labelled list only
 * for display/formatting.
 */
export const PAYMENT_STATUSES = [
  { value: "unpaid", label: "Unpaid" },
  { value: "advance_paid", label: "Advance Paid" },
  { value: "fully_paid", label: "Fully Paid" },
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]["value"];

export const PAYMENT_STATUS_VALUES = PAYMENT_STATUSES.map((p) => p.value) as [
  PaymentStatus,
  ...PaymentStatus[],
];

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];

export const PAYMENT_METHOD_VALUES = PAYMENT_METHODS.map((p) => p.value) as [
  PaymentMethod,
  ...PaymentMethod[],
];
