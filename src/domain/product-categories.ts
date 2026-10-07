/**
 * The product catalogue: 47 categories in 6 collections. Mirror of
 * needleye-web's lib/domain/constants/productCategories.ts -- kept identical.
 *
 * This list is the ONLY validation of `orders.product_category` (the create/
 * update DTOs build their zod enum from PRODUCT_CATEGORY_VALUES). The database
 * CHECK was dropped on purpose (migration 20260924000002) so adding a category
 * is a code change here, never a migration.
 *
 * Two rules for anyone editing this:
 *   - NEVER change or remove an existing `value`. It's what every order row
 *     stores; renaming one orphans those orders. Change the `label` freely --
 *     labels are display-only.
 *   - `value`s are internal and correctly spelled even where the `label` keeps
 *     the business's own spelling ("Plazo" -> `palazzo`), so a
 *     label can be corrected later without touching stored data.
 *
 * Womenswear (the core trade) uses plain values; Mens Wear and Kids Wear values
 * carry a `mens_` / `kids_` prefix. That keeps the three labels that appear
 * twice -- "Shirt" (Upper Body, Mens Wear), "Pant" and "Skirt" (Lower Body,
 * Mens Wear) -- distinct, and stops any future womenswear addition colliding with a men's one.
 * The first five entries' values predate the catalogue and are unchanged.
 */
export const PRODUCT_CATEGORY_GROUPS = [
  { value: "upper_body", label: "Upper Body" },
  { value: "full_body", label: "Full Body" },
  { value: "lower_body", label: "Lower Body" },
  { value: "mens_wear", label: "Mens Wear" },
  { value: "kids_girls", label: "Kids Wear - Girls" },
  { value: "kids_boys", label: "Kids Wear - Boys" },
] as const;

export type ProductCategoryGroup = (typeof PRODUCT_CATEGORY_GROUPS)[number]["value"];

export const PRODUCT_CATEGORIES = [
  // Upper Body
  { value: "saree_blouse", label: "Saree Blouse", group: "upper_body" },
  { value: "work_blouse", label: "Work Blouse", group: "upper_body" },
  { value: "crop_top_blouse", label: "Crop Top Blouse", group: "upper_body" },
  { value: "corset", label: "Corset", group: "upper_body" },
  { value: "shirt", label: "Shirt", group: "upper_body" },
  { value: "designer_blouse", label: "Designer Blouse", group: "upper_body" },
  { value: "hw_blouse_skirt", label: "HW Blouse Skirt", group: "upper_body" },
  { value: "short_kurta", label: "Short Kurta", group: "upper_body" },
  { value: "pakistani_kurta", label: "Pakistani Kurta", group: "upper_body" },
  { value: "custom_upper_body", label: "Custom Upper Body", group: "upper_body" },
  // Full Body
  { value: "anarkali", label: "Anarkali", group: "full_body" },
  { value: "gown", label: "Gown", group: "full_body" },
  { value: "jumpsuit", label: "Jump Suit", group: "full_body" },
  { value: "bodycon", label: "Bodycon", group: "full_body" },
  { value: "drape_gown", label: "Drape Gown", group: "full_body" },
  { value: "bridal_lehenga", label: "Bridal Lehenga", group: "full_body" },
  { value: "saree", label: "Saree", group: "full_body" },
  { value: "custom_ethnic_wear", label: "Custom Ethnic Wear", group: "full_body" },
  { value: "boutique_fashion", label: "Boutique Fashion", group: "full_body" },
  // Lower Body
  { value: "skirt", label: "Skirt", group: "lower_body" },
  { value: "half_saree", label: "Half Saree", group: "lower_body" },
  { value: "divided_skirt", label: "Divided Skirt", group: "lower_body" },
  { value: "palazzo", label: "Plazo", group: "lower_body" },
  { value: "pant", label: "Pant", group: "lower_body" },
  { value: "sharara", label: "Sharara", group: "lower_body" },
  { value: "pakistani_pant", label: "Pakistani Pant", group: "lower_body" },
  { value: "drape_skirt", label: "Drape Skirt", group: "lower_body" },
  { value: "mermaid_skirt", label: "Mermaid Skirt", group: "lower_body" },
  { value: "petticoat", label: "Peticoat", group: "lower_body" },
  { value: "custom_lower_body", label: "Custom Lower Body", group: "lower_body" },
  // Mens Wear
  { value: "mens_shirt", label: "Shirt", group: "mens_wear" },
  { value: "mens_pant", label: "Pant", group: "mens_wear" },
  { value: "mens_skirt", label: "Skirt", group: "mens_wear" },
  { value: "mens_shalwar", label: "Shalwar", group: "mens_wear" },
  { value: "mens_blazer", label: "Blazer", group: "mens_wear" },
  { value: "mens_waist_coat", label: "Waist Coat", group: "mens_wear" },
  { value: "mens_bandi", label: "Bandi", group: "mens_wear" },
  { value: "mens_three_piece_set", label: "3 Piece Set", group: "mens_wear" },
  { value: "mens_dhoti", label: "Dhoti", group: "mens_wear" },
  { value: "mens_kurta", label: "Kurta", group: "mens_wear" },
  { value: "mens_prince_coat", label: "Prince Coat", group: "mens_wear" },
  { value: "mens_panchay", label: "Panchay", group: "mens_wear" },
  { value: "mens_shalya", label: "Shalya", group: "mens_wear" },
  { value: "mens_indo_western", label: "Indo Western", group: "mens_wear" },
  { value: "mens_custom", label: "Custom Mens Wear", group: "mens_wear" },
  // Kids Wear
  { value: "kids_girls_custom", label: "Custom Kid Wear-Girls", group: "kids_girls" },
  { value: "kids_boys_custom", label: "Custom Kid Wear-Boys", group: "kids_boys" },
] as const satisfies readonly { value: string; label: string; group: ProductCategoryGroup }[];

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]["value"];

export const PRODUCT_CATEGORY_VALUES = PRODUCT_CATEGORIES.map((c) => c.value) as [
  ProductCategory,
  ...ProductCategory[],
];

/** Display label for a stored category value; falls back to the raw value for anything unknown. */
export function productCategoryLabel(value: string): string {
  return PRODUCT_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

/** The collection a category belongs to, or undefined for an unknown value. */
export function productCategoryGroup(value: string): ProductCategoryGroup | undefined {
  return PRODUCT_CATEGORIES.find((c) => c.value === value)?.group;
}

/**
 * Payment status is DERIVED from the ledger (sum of payments vs order total),
 * never chosen by hand -- see derivePaymentStatus in the Orders domain. These
 * four values are the possible derived outcomes, kept as a labelled list only
 * for display/formatting. `not_priced` = the order has no total yet (ADR 0008).
 */
export const PAYMENT_STATUSES = [
  { value: "not_priced", label: "Price not set" },
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
