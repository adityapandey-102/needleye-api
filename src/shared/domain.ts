/**
 * RBAC roles/capabilities, order-status vocabulary, product/payment
 * constants, and zod validation schemas -- the business rules this API
 * enforces. Deliberately NOT a shared package: needleye-web keeps its own
 * copy of the same rules. The two apps are fully independent repos that
 * only talk over HTTP; if that duplication ever becomes painful, that's a
 * signal to introduce a documented API contract, not to re-couple the repos
 * with shared code.
 */
export * from "./constants/roles";
export * from "./constants/capabilities";
export * from "./constants/orderStatus";
export * from "./constants/productCategories";
export * from "./types";
export * from "./validation/order";
export * from "./validation/payment";
export * from "./validation/user";
