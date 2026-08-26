// Default exports (§14): named declaration, anonymous declaration, and a bare-expression
// re-export of an existing local binding — three different shapes for isDefault/name.
export default function formatDate(value: Date): string {
  return value.toISOString();
}
