// Preview-only stand-in for "convex/react": serves fixtures, no network.
import type { ReactNode } from "react";
import { getFunctionName } from "convex/server";
import { FIXTURES } from "./fixtures";
const name = (ref: unknown) => { try { return getFunctionName(ref as never); } catch { return String(ref); } };
export function useQuery(ref: unknown, args?: unknown) {
  if (args === "skip") return undefined;
  const n = name(ref);
  if (!(n in FIXTURES)) console.warn("[preview] no fixture for", n);
  return FIXTURES[n];
}
export const useMutation = () => async () => null;
export const useAction = () => async () => null;
export const useConvex = () => ({ query: async (ref: unknown) => FIXTURES[name(ref)] });
export const useConvexAuth = () => ({ isLoading: false, isAuthenticated: true });
export class ConvexReactClient {}
export const ConvexProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Authenticated = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Unauthenticated = () => null;
export const AuthLoading = () => null;
