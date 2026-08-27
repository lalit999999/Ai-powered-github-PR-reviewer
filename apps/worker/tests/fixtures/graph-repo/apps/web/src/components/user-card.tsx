import { useUser, useUserGreeting } from "../hooks/use-user";

export interface UserCardProps {
  userId: string;
}

/** `UserCard` — PascalCase, returns JSX, matches the adapter's
 * react-component detection; calls `useUser`, a cross-file named import
 * (rule 2) resolving to a HOOK-kind symbol. */
export function UserCard({ userId }: UserCardProps) {
  const user = useUser(userId);
  return <div className="user-card">{user.name}</div>;
}

/** A second component, calling a second hook (rule 2). Its JSX usage of
 * `UserCard` below is **not** a call site — tree-sitter's `call_expression`
 * pattern does not match a JSX element, so `<UserCard .../>` contributes no
 * `ParsedCall` at all, unlike a plain function call would. */
export function UserCardGreeting({ userId }: UserCardProps) {
  const greeting = useUserGreeting(userId);
  return (
    <div>
      <p>{greeting}</p>
      <UserCard userId={userId} />
    </div>
  );
}
