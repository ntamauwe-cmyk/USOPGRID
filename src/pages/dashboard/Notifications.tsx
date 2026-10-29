import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState, LoadingRows } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Bell } from "lucide-react";

const DOT: Record<string, string> = { critical: "bg-red-600", warning: "bg-amber-500", info: "bg-blue-500" };

export default function Notifications() {
  const items = useQuery(api.notifications.list, { limit: 100 });
  const markRead = useMutation(api.notifications.markRead);
  const unread = items?.filter((n) => !n.read).length ?? 0;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Notifications"
        description="Provider incidents, reconciliation exceptions, compliance stops and security events for your organization."
        actions={unread > 0 ? <Button variant="outline" onClick={() => void markRead({})}>Mark all as read</Button> : undefined}
      />
      {items === undefined ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        <EmptyState icon={<Bell className="size-5" />} title="You're all caught up" description="Alerts about your payments and providers will appear here." />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {items.map((n) => (
            <li key={n._id} className={cn("flex gap-3 p-4", !n.read && "bg-accent/40")}>
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[n.severity])} aria-label={n.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className={cn("text-sm", !n.read && "font-semibold")}>{n.title}</span>
                  <span className="text-xs text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
                <div className="mt-1 flex gap-3 text-sm">
                  {n.link && <Link to={n.link} className="text-primary hover:underline" onClick={() => void markRead({ ids: [n._id] })}>Open</Link>}
                  {!n.read && <button className="text-muted-foreground hover:text-foreground" onClick={() => void markRead({ ids: [n._id] })}>Mark as read</button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
