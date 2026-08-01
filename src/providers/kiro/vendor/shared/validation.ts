/**
 * Shared type-guard and record utilities.
 *
 * Consolidates the `isRecord` guard and `JsonRecord` type that were
 * previously redefined across config.ts, eventstream.ts, kiro.ts, and
 * oauth.ts. Also centralizes the `nonEmptyString`/`optionalString`
 * string-coercion helper that was duplicated under two names.
 */

/** Record of string keys to unknown values. */
export type JsonRecord = Record<string, unknown>;

/**
 * Type guard: true when `value` is a non-array, non-null object.
 */
export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Coerce an unknown value to a trimmed non-empty string, or `undefined`.
 *
 * Both `nonEmptyString` and `optionalString` had identical bodies across
 * the extension; they are the same helper. `optionalString` is re-exported
 * as an alias so existing call sites keep their readable local names.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export { nonEmptyString as optionalString };

/**
 * Coerce an unknown value to a positive finite number, or `fallback`.
 *
 * Consolidates the identical `numberOr` (config.ts) and `numericSeconds`
 * (oauth.ts) coercions that previously carried the same body.
 */
export function positiveFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
