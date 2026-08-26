// Getters, setters, static members, and private #fields (§2.6) — all `method_definition`
// nodes in this grammar regardless of modifier, except the private field itself, which is
// a `public_field_definition` (not extracted as a symbol at all — no "field" SymbolKind).
export class Temperature {
  #celsius = 0;
  static defaultUnit = "celsius";

  get fahrenheit(): number {
    return this.#celsius * (9 / 5) + 32;
  }

  set fahrenheit(value: number) {
    this.#celsius = (value - 32) * (5 / 9);
  }

  static create(celsius: number): Temperature {
    const t = new Temperature();
    t.#celsius = celsius;
    return t;
  }
}
