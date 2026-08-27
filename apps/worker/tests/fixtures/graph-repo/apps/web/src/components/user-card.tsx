import { useUser } from "../hooks/use-user";

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
