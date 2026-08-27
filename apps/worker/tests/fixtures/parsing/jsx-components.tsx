// JSX components (§14) and the hook heuristic, side by side so the "PascalCase + JSX"
// vs "^use[A-Z]" distinction is visible in one realistic file.
import { useState } from "react";

export function useCounter(initial: number) {
  const [count, setCount] = useState(initial);
  return { count, increment: () => setCount(count + 1) };
}

export function Counter({ initial }: { initial: number }) {
  const { count, increment } = useCounter(initial);
  return (
    <button onClick={increment}>
      Count: {count}
    </button>
  );
}

// PascalCase but returns no JSX — must stay a plain FUNCTION, not a REACT_COMPONENT.
export function Registry() {
  return { get: () => 1 };
}
