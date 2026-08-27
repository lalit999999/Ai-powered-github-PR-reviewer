// Plain constant exports — not functions, so the parser adapter extracts no
// CodeSymbol for either (SymbolKind.VARIABLE is declared but never produced —
// see docs/decisions/phase-04-log.md, Prompt 2 §8). Present so an import of a
// non-callable export is exercised somewhere in the fixture.
export const LOG_PREFIX = "[core]";
export const SESSION_TTL_MS = 1000 * 60 * 30;
