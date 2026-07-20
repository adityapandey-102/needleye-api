/**
 * Shared kernel: core domain concepts (roles, capability matrix,
 * order-status vocabulary, product/payment constants, the Profile type)
 * used across multiple modules within THIS repo. This is not shared code
 * between repositories -- needleye-web maintains its own independent copy
 * of the same rules; see that repo's README for why.
 */
export * from "./roles";
export * from "./capabilities";
export * from "./order-status";
export * from "./product-categories";
export * from "./profile";
