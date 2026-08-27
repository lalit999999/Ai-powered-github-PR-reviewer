/** Depth 1 of the three-deep class hierarchy: BaseEntity <- Entity <- NamedEntity. */
export class BaseEntity {
  id: string;
  createdAt: number;

  constructor(id: string) {
    this.id = id;
    this.createdAt = Date.now();
  }

  touch(): void {
    this.createdAt = Date.now();
  }

  ageMs(): number {
    this.touch();
    return Date.now() - this.createdAt;
  }
}
