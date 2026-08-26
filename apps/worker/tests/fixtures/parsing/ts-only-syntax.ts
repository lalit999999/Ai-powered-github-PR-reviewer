// A file that is valid TypeScript but not valid plain JavaScript (§2.6): type
// annotations, an interface, and a type alias are not part of the JavaScript grammar's
// vocabulary at all. Confirmed empirically (docs/decisions/phase-04-log.md, Prompt 2
// section) that feeding this same text to the *plain javascript* grammar produces real
// ERROR nodes — the reverse direction ("valid JS, not valid TS") has no equally clean
// grammar-level example: TypeScript's grammar is, for every construct this phase cares
// about, a strict syntactic superset of JavaScript's, so no ordinary JS snippet fails to
// parse under the TypeScript grammar — see the report-back for this finding stated in
// full.
export interface Config {
  timeout: number;
}

export type Handler = (config: Config) => void;

export function run(config: Config, handler: Handler): void {
  handler(config);
}
