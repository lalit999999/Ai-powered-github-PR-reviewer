// Decorators (§14) — a class decorator (a field on class_declaration itself in this
// grammar) and a method decorator (a sibling of method_definition inside class_body).
// Both must extend the owning symbol's startLine to cover the decorator.
function Injectable() {
  return function (target: unknown) {
    return target;
  };
}

function Input() {
  return function (target: unknown, propertyKey: string) {
    // no-op
  };
}

@Injectable()
export class WidgetService {
  @Input()
  label = "widget";

  @Input()
  render(): string {
    return this.label;
  }
}
