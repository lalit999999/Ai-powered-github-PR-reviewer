// Overloaded function signatures — a construct that "actually breaks" adapters (§2.6).
// The two bodyless overload signatures are a different grammar node (`function_signature`)
// from the implementation (`function_declaration`, which requires a body), so only the
// implementation should ever become a symbol — never three, never a duplicate range.
export function parseValue(value: string): string;
export function parseValue(value: number): number;
export function parseValue(value: string | number): string | number {
  return value;
}
