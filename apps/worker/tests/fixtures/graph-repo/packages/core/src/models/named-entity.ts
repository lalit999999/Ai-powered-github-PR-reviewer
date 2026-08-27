import { Entity } from "./entity";
import { Serializable } from "./serializable";

/** Depth 3 of the three-deep class hierarchy — extends Entity (which extends
 * BaseEntity) and implements Serializable, both via same-package named
 * imports (rule 2, EXTENDS and IMPLEMENTS respectively). Neither import is
 * type-only, so both heritage edges are expected to resolve cleanly — unlike
 * `http/middleware.ts`'s deliberate type-only-import counter-example. */
export class NamedEntity extends Entity implements Serializable {
  name: string;

  constructor(id: string, name: string) {
    super(id);
    this.name = name;
  }

  serialize(): string {
    this.touch();
    return `${this.id}:${this.name}`;
  }

  rename(next: string): void {
    this.name = next.trim();
    this.bump();
  }
}
