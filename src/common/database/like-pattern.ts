/**
 * `%term%` for ILIKE with the term's own `%`, `_` and `\` escaped, so a
 * search for "50%" matches the text "50%" rather than acting as a wildcard.
 * (Postgres' default LIKE escape character is the backslash.)
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
