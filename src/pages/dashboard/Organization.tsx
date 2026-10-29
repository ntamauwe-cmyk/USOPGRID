import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, LoadingRows, errorMessage } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { COUNTRIES } from "@/lib/geo";
import { toast } from "sonner";

export default function Organization() {
  const profile = useQuery(api.orgs.orgProfile, {});
  const merchants = useQuery(api.orgs.listMerchants, {});
  const save = useMutation(api.orgs.updateOrgProfile);
  const setEnv = useMutation(api.orgs.updateOrgEnvironment);
  const setFees = useMutation(api.orgs.updateMerchantFees);
  const sensitive = useSensitive();
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const countries = useMemo(() => Object.values(COUNTRIES).sort((a, b) => a.name.localeCompare(b.name)), []);

  if (profile === undefined) return <LoadingRows rows={5} />;
  const canEdit = profile.canEdit;

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const limit = String(fd.get("limit") ?? "").trim();
    setBusy(true);
    try {
      await save({
        name: String(fd.get("name") ?? ""),
        country: String(fd.get("country") ?? "") || undefined,
        maxTransactionUsd: limit === "" ? null : Number(limit),
      });
      toast.success("Organization saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchEnv(environment: "sandbox" | "production") {
    try {
      await sensitive(() => setEnv({ environment }));
      toast.success(environment === "production" ? "Live environment enabled" : "Switched to sandbox");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const merchant = merchants?.[0];

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title="Organization" description="Profile, environment and limits for your organization." />

      <form onSubmit={onSave} className="space-y-4 rounded-lg border bg-card p-5">
        <h2 className="text-lg font-semibold">Profile</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="o-name">Legal or trading name</Label>
            <Input id="o-name" name="name" defaultValue={profile.name} disabled={!canEdit} required minLength={2} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-country">Country of incorporation</Label>
            <select id="o-country" name="country" defaultValue={profile.country ?? ""} disabled={!canEdit} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">Not set</option>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Used for compliance screening.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-limit">Per-payment limit (USD equivalent)</Label>
            <Input id="o-limit" name="limit" type="number" min={1} step="0.01" defaultValue={profile.maxTransactionUsd ?? ""} placeholder="No limit" disabled={!canEdit} />
            <p className="text-xs text-muted-foreground">Payments above this are rejected before reaching a provider.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <p className="pt-2 text-sm capitalize">{profile.status}</p>
          </div>
        </div>
        {canEdit && <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>}
      </form>

      <section className="space-y-3 rounded-lg border bg-card p-5" aria-labelledby="env-h">
        <h2 id="env-h" className="text-lg font-semibold">Environment</h2>
        <p className="text-sm text-muted-foreground">
          The dashboard shows one environment at a time. API keys are fixed to their own environment regardless of this setting.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Currently: <strong>{profile.environment === "production" ? "Live" : "Sandbox"}</strong></span>
          {canEdit &&
            (profile.environment === "production" ? (
              <Button variant="outline" onClick={() => void switchEnv("sandbox")}>Switch to sandbox</Button>
            ) : (
              <Button onClick={() => setConfirmLive(true)} disabled={profile.status !== "active"}>Go live</Button>
            ))}
        </div>
      </section>

      {merchant && (
        <section className="space-y-3 rounded-lg border bg-card p-5" aria-labelledby="fee-h">
          <h2 id="fee-h" className="text-lg font-semibold">Merchant pricing</h2>
          <p className="text-sm text-muted-foreground">The fee USOPGRID deducts from each successful payment before crediting {merchant.name}. Settlement currency: {merchant.defaultCurrency}.</p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              try {
                await setFees({ merchantId: merchant._id, feeBps: Math.round(Number(fd.get("pct")) * 100), feeFixedMinor: Math.round(Number(fd.get("fixed") || 0)) });
                toast.success("Pricing saved");
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <div className="space-y-1.5"><Label htmlFor="f-pct">Percentage</Label><Input id="f-pct" name="pct" type="number" step="0.01" min={0} max={100} defaultValue={(merchant.feeBps / 100).toFixed(2)} disabled={!canEdit} className="w-28" /></div>
            <div className="space-y-1.5"><Label htmlFor="f-fixed">Fixed ({merchant.feeCurrency ?? merchant.defaultCurrency} minor units)</Label><Input id="f-fixed" name="fixed" type="number" min={0} defaultValue={merchant.feeFixedMinor} disabled={!canEdit} className="w-40" /></div>
            {canEdit && <Button type="submit" variant="outline">Save pricing</Button>}
          </form>
        </section>
      )}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch the dashboard to live?</AlertDialogTitle>
            <AlertDialogDescription>
              Dashboard payments, refunds and payouts will use your live provider connections and move real money. Make sure you have connected at least one live provider and tested your webhooks.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in sandbox</AlertDialogCancel>
            <AlertDialogAction onClick={() => void switchEnv("production")}>Go live</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
