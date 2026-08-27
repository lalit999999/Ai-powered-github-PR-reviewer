// Barrel — re-exports three modules. A file importing `login` from the bare
// "@fixture/core" specifier resolves here (package.json#main), not to
// auth/login.ts directly — the graph-repo-labels.json fixture uses this to
// exercise the single-hop re-export limitation documented in docs/parsing.md.
export * from "./auth/login";
export * from "./auth/session";
export * from "./http/handler";
export * from "./models/serializable";
