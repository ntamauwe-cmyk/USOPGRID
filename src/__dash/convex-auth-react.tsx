import type { ReactNode } from "react";
export const ConvexAuthProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
export const useAuthActions = () => ({ signIn: async () => ({ signingIn: false }), signOut: async () => {} });
