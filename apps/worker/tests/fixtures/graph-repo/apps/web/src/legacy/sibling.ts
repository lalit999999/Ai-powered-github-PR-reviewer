export function siblingValue(): number {
  return 42;
}

/** Same-file call (rule 1) to `siblingValue` above. */
export function doubledSiblingValue(): number {
  return siblingValue() * 2;
}
