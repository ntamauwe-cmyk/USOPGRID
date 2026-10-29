// Team: members, roles, invitations and the permission matrix.
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, LoadingRows, errorMessage } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { toast } from "sonner";
import { Check, UserPlus } from "lucide-react";

const PERMISSION_LABELS: Record<string, string> = {
  "org:manage": "Manage organization",
  "team:invite": "Invite members",
  "keys:manage": "API keys",
  "payments:create": "Create payments",
  "refunds:create": "Refunds",
  "settlement:view": "Settlements",
  "ledger:view": "Ledger",
  "reconciliation:manage": "Reconciliation",
  "audit:view": "Audit log",
  "webhooks:manage": "Webhooks",
  "providers:manage": "Providers",
  "routing:manage": "Routing",
  "analytics:view": "Analytics",
  "risk:manage": "Risk",
  "security:manage": "Security policy",
};

export default function Team() {
  const ctx = useQuery(api.orgs.getOrgContext, {});
  const members = useQuery(api.orgs.listMembers, {});
  const roles = useQuery(api.orgs.roles, {});
  const canInvite = ctx?.permissions.includes("team:invite") ?? false;
  const canManage = ctx?.permissions.includes("org:manage") ?? false;
  const invites = useQuery(api.orgs.listInvitations, canInvite ? {} : "skip");
  const updateRole = useMutation(api.orgs.updateMemberRole);
  const invite = useMutation(api.orgs.inviteMember);
  const revoke = useMutation(api.orgs.revokeInvitation);
  const remove = useMutation(api.orgs.removeMember);
  const sensitive = useSensitive();
  const [removing, setRemoving] = useState<{ id: Id<"orgMembers">; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = ctx?.role === "owner";
  const roleOptions = (roles ?? []).filter((r) => isOwner || r.id !== "owner");
  const labelFor = (id: string) => roles?.find((r) => r.id === id)?.label ?? id;

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await sensitive(fn);
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Team" description="Who can access this organization and what each role can do. Permissions are enforced on the server." />

      {canInvite && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fd = new FormData(form);
            setBusy(true);
            try {
              await sensitive(() => invite({ email: String(fd.get("email")), role: String(fd.get("role")) as "viewer" }));
              toast.success("Invitation created. Ask them to sign in with that email address.");
              form.reset();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="inv-email">Invite by email</Label>
            <Input id="inv-email" name="email" type="email" required placeholder="colleague@company.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inv-role">Role</Label>
            <select id="inv-role" name="role" defaultValue="developer" className="h-9 rounded-md border bg-background px-2 text-sm">
              {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={busy}><UserPlus className="size-4" /> {busy ? "Inviting…" : "Send invitation"}</Button>
        </form>
      )}

      <section className="space-y-3" aria-labelledby="mem-h">
        <h2 id="mem-h" className="text-lg font-semibold">Members</h2>
        {members === undefined ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">Member</th><th className="px-4 py-2.5 font-medium">Role</th><th className="px-4 py-2.5 font-medium">Joined</th><th /></tr></thead>
              <tbody className="divide-y">
                {members.map((m) => {
                  const self = ctx?.member._id === m._id;
                  const editable = canManage && !self && (m.role !== "owner" || isOwner);
                  return (
                    <tr key={m._id}>
                      <td className="px-4 py-2.5"><div className="font-medium">{m.name}{self && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</div><div className="text-xs text-muted-foreground">{m.email ?? "—"}</div></td>
                      <td className="px-4 py-2.5">
                        {editable ? (
                          <select aria-label={`Role for ${m.name}`} className="h-8 rounded-md border bg-background px-2 text-sm" value={m.role} onChange={(e) => void act(() => updateRole({ memberId: m._id, role: e.target.value }), "Role updated")}>
                            {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                          </select>
                        ) : (
                          labelFor(m.role)
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{new Date(m.joinedAt).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-right">{editable && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving({ id: m._id, name: m.name })}>Remove</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canInvite && invites && invites.length > 0 && (
        <section className="space-y-3" aria-labelledby="inv-h">
          <h2 id="inv-h" className="text-lg font-semibold">Pending invitations</h2>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {invites.map((i) => (
              <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span>{i.email} <span className="text-muted-foreground">as {labelFor(i.role)}, expires {new Date(i.expiresAt).toLocaleDateString()}</span></span>
                <Button size="sm" variant="ghost" onClick={() => void act(() => revoke({ invitationId: i._id }), "Invitation revoked")}>Revoke</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="perm-h">
        <h2 id="perm-h" className="text-lg font-semibold">What each role can do</h2>
        {roles === undefined ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">Permission</th>
                  {roles.map((r) => <th key={r.id} className="px-3 py-2.5 text-center font-medium">{r.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(PERMISSION_LABELS).map(([p, label]) => (
                  <tr key={p}>
                    <td className="px-3 py-2">{label}</td>
                    {roles.map((r) => (
                      <td key={r.id} className="px-3 py-2 text-center">
                        {r.permissions.includes(p) ? <Check className="mx-auto size-4 text-status-success" aria-label="Allowed" /> : <span className="sr-only">Not allowed</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>They lose access to this organization immediately. Their past actions stay in the audit log.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const r = removing!; setRemoving(null); void act(() => remove({ memberId: r.id }), "Member removed"); }}>Remove member</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
