// Dynamic imports (§14): a literal-specifier form the resolver can follow, and a
// non-literal form that must produce no import entry at all rather than a fabricated one.
export async function loadWidget() {
  const widget = await import("./widget");
  return widget.default;
}

export async function loadDynamic(path: string) {
  // A non-literal specifier — this must never appear in ParsedFile.imports.
  const mod = await import(path);
  return mod;
}
