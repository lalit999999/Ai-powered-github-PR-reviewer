// Abstract classes and abstract methods — a distinct grammar node from a normal class/
// method (§2.6), confirmed empirically rather than assumed (docs/decisions/phase-04-log.md).
export abstract class Shape {
  abstract area(): number;

  describe(): string {
    return `area = ${this.area().toString()}`;
  }
}

export class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}
