import Decimal from "decimal.js";

/**
 * Money — the ONE way to handle currency in this codebase.
 *
 * Rules for the whole team (keep it boring and consistent):
 *   1. Money is stored in Postgres as `numeric(12,2)` and CROSSES EVERY
 *      BOUNDARY (DB row, entity, DTO, JSON wire, frontend) as a STRING like
 *      "1500.00" -- never a JS `number`. JSON numbers are IEEE-754 floats, so
 *      sending money as a number risks precision drift; a string is exact.
 *   2. NEVER do arithmetic or comparisons on money with `+`, `-`, `>`,
 *      `Number(...)`, `parseFloat`, or hand-rolled cents. Always go through the
 *      helpers here, which use decimal.js (arbitrary-precision decimal, the JS
 *      equivalent of Java's BigDecimal).
 *   3. Produce the canonical string with `toMoneyString(...)` (always 2 dp).
 *
 * That's the single, error-proof path -- add a helper here if you need one,
 * rather than reaching for floats anywhere else.
 */

// Configure once for the process: half-up rounding (standard for currency).
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

/** Anything that can represent an amount. `null`/`undefined`/"" are treated as 0. */
export type MoneyLike = string | number | Decimal | null | undefined;

/** The one way to turn any money value into a Decimal for math/comparison. */
export function money(value: MoneyLike): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  try {
    return new Decimal(value);
  } catch {
    return new Decimal(0);
  }
}

/** Canonical string form for storage + transport: always exactly 2 decimals. */
export function toMoneyString(value: MoneyLike): string {
  return money(value).toFixed(2);
}

/** Sum any number of money values. */
export function addMoney(...values: MoneyLike[]): Decimal {
  return values.reduce<Decimal>((sum, v) => sum.plus(money(v)), new Decimal(0));
}

/** a - b. */
export function subtractMoney(a: MoneyLike, b: MoneyLike): Decimal {
  return money(a).minus(money(b));
}

/** max(a - b, 0) -- e.g. an outstanding balance can't go negative. */
export function outstanding(total: MoneyLike, paid: MoneyLike): Decimal {
  const diff = subtractMoney(total, paid);
  return diff.isNegative() ? new Decimal(0) : diff;
}

export function moneyGreaterThan(a: MoneyLike, b: MoneyLike): boolean {
  return money(a).greaterThan(money(b));
}

export function moneyGte(a: MoneyLike, b: MoneyLike): boolean {
  return money(a).greaterThanOrEqualTo(money(b));
}

export function isPositiveMoney(value: MoneyLike): boolean {
  return money(value).greaterThan(0);
}
