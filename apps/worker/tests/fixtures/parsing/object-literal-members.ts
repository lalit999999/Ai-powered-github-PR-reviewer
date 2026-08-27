// Object-literal methods and arrow functions assigned to object properties (§2.6) — a
// deliberate exclusion (see typescript.adapter.ts's NESTING_BOUNDARY_TYPES comment): none
// of these produce a symbol. `api` itself also produces none — its value is an object
// literal, not a function/arrow-function, and this adapter only extracts SymbolKind
// VARIABLE-worthy bindings when they are function-shaped (SYMBOL_KINDS.VARIABLE is not
// wired up by this prompt at all; see the report-back's "known extraction gaps").
export const api = {
  list() {
    return [] as string[];
  },
  create: (name: string) => ({ name }),
  remove: function (id: string) {
    return id;
  },
};
