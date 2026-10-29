// MFA step-up for sensitive actions. Wrap a call with `sensitive(() => mutate(...))`:
// if the server answers MFA_STEP_UP, the user is asked for an authenticator
// code, the step-up window is opened, and the original call is retried once.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, isStepUpError } from "@/components/kit";

type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Runner>((fn) => fn());

export function useSensitive(): Runner {
  return useContext(Ctx);
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const verify = useAction(api.security.verifyCode);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const askForCode = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setCode("");
      setError(null);
      setOpen(true);
    });

  const run: Runner = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (!isStepUpError(err)) throw err;
      await askForCode();
      return await fn();
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verify({ code });
      setOpen(false);
      pending.current?.resolve();
      pending.current = null;
    } catch (err) {
      setError(errorMessage(err, "That code didn't work. Check your authenticator and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && pending.current) {
            pending.current.reject(new Error("Verification cancelled"));
            pending.current = null;
          }
          setOpen(o);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm it's you</DialogTitle>
            <DialogDescription>This change needs a code from your authenticator app. You won't be asked again for 15 minutes.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="stepup-code">Authenticator code</Label>
              <Input id="stepup-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Verify and continue"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
