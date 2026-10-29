import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageHeader, LoadingRows, errorMessage } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { toast } from "sonner";
import { ShieldCheck, Copy } from "lucide-react";

function Enroll({ onDone }: { onDone: () => void }) {
  const begin = useAction(api.security.beginEnrollment);
  const verify = useAction(api.security.verifyCode);
  const [setup, setSetup] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (codes) {
    return (
      <div className="space-y-3" role="status">
        <p className="font-medium">Multi-factor authentication is on.</p>
        <p className="text-sm text-muted-foreground">Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They will not be shown again.</p>
        <ul className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(codes.join("\n")); toast.success("Recovery codes copied"); }}><Copy className="size-4" /> Copy codes</Button>
          <Button onClick={onDone}>I've saved them</Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setSetup(await begin({}));
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Set up authenticator app
        </Button>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await verify({ code });
          setCodes(r.recoveryCodes ?? []);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Open your authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator) and add an account with this setup key:
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm tracking-wider">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code>
            <Button type="button" size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(setup.secret); toast.success("Setup key copied"); }}><Copy className="size-4" /></Button>
          </div>
          <a className="mt-1 inline-block text-primary hover:underline" href={setup.otpauthUrl}>Or open directly on this device</a>
        </li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="max-w-[12rem] space-y-1.5">
        <Label htmlFor="mfa-code">Code</Label>
        <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Turn on MFA"}</Button>
    </form>
  );
}

export default function Security() {
  const status = useQuery(api.security.status, {});
  const events = useQuery(api.security.securityEvents, {});
  const disable = useMutation(api.security.disableMfa);
  const policy = useMutation(api.security.updateOrgPolicy);
  const sensitive = useSensitive();
  const [enrolling, setEnrolling] = useState(false);

  if (status === undefined) return <LoadingRows rows={4} />;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title="Security" description="Protect your account and set your organization's security policy." />

      <section className="space-y-4 rounded-lg border bg-card p-5" aria-labelledby="mfa-h">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="mfa-h" className="text-lg font-semibold">Multi-factor authentication</h2>
            <p className="text-sm text-muted-foreground">With MFA on, sensitive changes ask for a code from your authenticator app.</p>
          </div>
          {status.mfaEnabled && <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700"><ShieldCheck className="size-4" /> On</span>}
        </div>
        {!status.encryptionConfigured ? (
          <p className="text-sm text-amber-800">MFA is unavailable until the platform encryption key is configured. Contact your administrator.</p>
        ) : status.mfaEnabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">{status.recoveryCodesRemaining} recovery codes left.</span>
            {!status.orgPolicy.requireMfaForSensitive && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await sensitive(() => disable({}));
                    toast.success("MFA turned off");
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Turn off MFA
              </Button>
            )}
          </div>
        ) : enrolling ? (
          <Enroll onDone={() => setEnrolling(false)} />
        ) : (
          <Button onClick={() => setEnrolling(true)}>Turn on MFA</Button>
        )}
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-5" aria-labelledby="pol-h">
        <h2 id="pol-h" className="text-lg font-semibold">Organization policy</h2>
        <div className="flex items-start justify-between gap-6">
          <div>
            <Label htmlFor="pol-mfa" className="text-sm font-medium">Require MFA for sensitive actions</Label>
            <p className="text-sm text-muted-foreground">Provider credentials, routing changes, API keys, refunds, role changes and going live will require every member to verify with MFA.</p>
          </div>
          <Switch
            id="pol-mfa"
            checked={status.orgPolicy.requireMfaForSensitive}
            disabled={!status.canManagePolicy}
            onCheckedChange={async (v: boolean) => {
              try {
                await sensitive(() => policy({ requireMfaForSensitive: v }));
                toast.success(v ? "MFA now required for sensitive actions" : "MFA requirement removed");
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
        </div>
        {!status.canManagePolicy && <p className="text-xs text-muted-foreground">Only organization owners can change this.</p>}
      </section>

      <section className="space-y-3" aria-labelledby="ev-h">
        <h2 id="ev-h" className="text-lg font-semibold">Recent security events</h2>
        {events === undefined ? (
          <LoadingRows rows={3} />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No security-relevant changes yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {events.map((e) => (
              <li key={`${e.at}-${e.action}-${e.resourceId}`} className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
                <span><span className="font-mono text-xs">{e.action}</span> <span className="text-muted-foreground">on {e.resource}</span></span>
                <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
