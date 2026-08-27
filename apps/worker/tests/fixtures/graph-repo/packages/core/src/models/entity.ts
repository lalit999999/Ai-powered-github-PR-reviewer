import { BaseEntity } from "./base-entity";

/** Depth 2 of the three-deep class hierarchy — extends BaseEntity via a
 * same-package named import (rule 2, EXTENDS). */
export class Entity extends BaseEntity {
  version: number;

  constructor(id: string) {
    super(id);
    this.version = 1;
  }

  bump(): void {
    this.version += 1;
    this.touch();
  }

  bumpTwice(): void {
    this.bump();
    this.bump();
  }
}
