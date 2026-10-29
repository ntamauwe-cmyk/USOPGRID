// Preview-only stand-in for "convex/react": serves fixtures, no network.
import type { ReactNode } from "react";
import { getFunctionName } from "convex/server";
import { FIXTURES } from "./fixtures";
const name = (ref: unknown) => { try { return getFunctionName(ref as never); } catch { return String(ref); } };
// The sign-in page previews as signed out; every other page as signed in.
const signedOut = () => typeof location !== "undefined" && location.pathname.startsWith("/auth");
export function useQuery(ref: unknown, args?: unknown) {
  if (args === "skip") return undefined;
  const n = name(ref);
  if (signedOut() && n === "users:currentUser") return null;
  if (!(n in FIXTURES)) console.warn("[preview] no fixture for", n);
  return FIXTURES[n];
}
export const useMutation = () => async () => null;
export const useAction = () => async () => null;
export const useConvex = () => ({ query: async (ref: unknown) => FIXTURES[name(ref)] });
export const useConvexAuth = () => ({ isLoading: false, isAuthenticated: !signedOut() });
export class ConvexReactClient {}
export const ConvexProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Authenticated = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Unauthenticated = () => null;
export const AuthLoading = () => null;
