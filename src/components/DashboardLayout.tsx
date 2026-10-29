import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ArrowLeftRight, Landmark, KeyRound, Webhook, Github, Users, ScrollText, LogOut, Loader2, Link2, Send, ShieldAlert,
  Contact, Network, Route, Scale, BarChart3, FileText, Building2, Lock, Bell, Activity, Menu, ShieldCheck, Repeat, Store,
} from "lucide-react";
import { UsopgridLogo } from "@/components/brand";
import { StepUpProvider } from "@/components/StepUp";

type Item = { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean };
const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Payments",
    items: [
      { to: "/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/dashboard/transactions", label: "Transactions", icon: ArrowLeftRight },
      { to: "/dashboard/customers", label: "Customers", icon: Contact },
      { to: "/dashboard/links", label: "Payment links", icon: Link2 },
      { to: "/dashboard/billing", label: "Billing", icon: Repeat },
      { to: "/dashboard/marketplace", label: "Marketplace", icon: Store },
      { to: "/dashboard/payouts", label: "Payouts", icon: Send },
      { to: "/dashboard/approvals", label: "Approvals", icon: ShieldCheck },
      { to: "/dashboard/disputes", label: "Disputes", icon: ShieldAlert },
    ],
  },
  {
    label: "Orchestration",
    items: [
      { to: "/dashboard/providers", label: "Providers", icon: Network },
      { to: "/dashboard/routing", label: "Routing", icon: Route },
    ],
  },
  {
    label: "Finance",
    items: [
      { to: "/dashboard/settlements", label: "Settlements", icon: Landmark },
      { to: "/dashboard/reconciliation", label: "Reconciliation", icon: Scale },
      { to: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
      { to: "/dashboard/reports", label: "Reports", icon: FileText },
    ],
  },
  {
    label: "Developers",
    items: [
      { to: "/dashboard/developers", label: "API keys", icon: KeyRound },
      { to: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
      { to: "/dashboard/repositories", label: "Repositories", icon: Github },
    ],
  },
  {
    label: "Organization",
    items: [
      { to: "/dashboard/organization", label: "Organization", icon: Building2 },
      { to: "/dashboard/team", label: "Team", icon: Users },
      { to: "/dashboard/security", label: "Security", icon: Lock },
      { to: "/dashboard/audit", label: "Audit log", icon: ScrollText },
    ],
  },
];

function Nav({ isPlatformAdmin, onNavigate }: { isPlatformAdmin: boolean; onNavigate?: () => void }) {
  const groups = isPlatformAdmin
    ? [...GROUPS, { label: "USOPGRID staff", items: [{ to: "/dashboard/operations", label: "Operations console", icon: Activity }] }]
    : GROUPS;
  const pendingApprovals = useQuery(api.approvals.pendingCount, {});
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Dashboard">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-3 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/60">{g.label}</div>
          <div className="space-y-0.5">
            {g.items.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onNavigate}
                className={({ isActive }: { isActive: boolean }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--sidebar-primary)]"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                  )
                }
              >
                <Icon className="size-4 opacity-80" strokeWidth={1.75} />
                {label}
                {to === "/dashboard/approvals" && !!pendingApprovals && (
                  <span className="ml-auto rounded-full bg-gold px-1.5 text-[10px] font-semibold leading-4 text-sidebar-primary-foreground" aria-label={`${pendingApprovals} waiting`}>
                    {pendingApprovals}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function EnvironmentCard({ environment }: { environment: string }) {
  const live = environment === "production";
  return (
    <div className="border-t border-sidebar-border p-3">
      <div className="rounded-md bg-sidebar-accent p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-sidebar-accent-foreground">
          <span className={cn("size-2 rounded-full", live ? "bg-status-success" : "bg-status-pending")} />
          {live ? "Live environment" : "Sandbox environment"}
        </div>
        <p className="mt-1 text-[11px] leading-4 text-sidebar-foreground/75">
          {live ? "Payments use your live provider connections and move real money." : "Simulated rails and test credentials only. No money moves."}
        </p>
      </div>
    </div>
  );
}

export default function DashboardLayout() {
  const { user, signOut, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const orgContext = useQuery(api.orgs.getOrgContext, {});
  const unread = useQuery(api.notifications.unreadCount, orgContext ? {} : "skip");
  const bootstrap = useMutation(api.orgs.bootstrapOrg);
  // The mobile menu is open only on the page it was opened from, so navigating closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const mobileOpen = openedOn === location.pathname;
  const setMobileOpen = (open: boolean) => setOpenedOn(open ? location.pathname : null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && user && orgContext === null) {
      bootstrap({}).catch((err: unknown) => setBootError(err instanceof Error ? err.message : "Could not set up your organization."));
    }
  }, [isLoading, user, orgContext, bootstrap]);


  if (bootError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
        <div>
          <p className="font-semibold">We couldn't open your workspace</p>
          <p className="mt-1 text-sm text-muted-foreground">{bootError}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </main>
    );
  }

  if (isLoading || orgContext === undefined || orgContext === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background" aria-busy="true">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading your workspace</span>
      </main>
    );
  }

  const environment = orgContext.org.environment;
  const suspended = orgContext.org.status !== "active";

  return (
    <StepUpProvider>
      <div className="flex min-h-screen bg-background">
        <a href="#dash-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2">Skip to content</a>
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
          <div className="flex h-16 items-center border-b border-sidebar-border px-5">
            <Link to="/" aria-label="USOPGRID home">
              <UsopgridLogo tone="onDark" />
            </Link>
          </div>
          <Nav isPlatformAdmin={orgContext.isPlatformAdmin} />
          <EnvironmentCard environment={environment} />
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="flex w-72 flex-col bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="flex h-16 items-center border-b border-sidebar-border px-5">
              <UsopgridLogo tone="onDark" />
            </SheetTitle>
            <Nav isPlatformAdmin={orgContext.isPlatformAdmin} onNavigate={() => setMobileOpen(false)} />
            <EnvironmentCard environment={environment} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b bg-card px-4 md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
                <Menu className="size-5" />
              </Button>
              <span
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]",
                  environment === "production" ? "border-primary bg-primary text-primary-foreground" : "border-status-pending text-status-pending",
                )}
              >
                {environment === "production" ? "Live" : "Sandbox"}
              </span>
              <span className="truncate text-sm font-semibold text-heading">{orgContext.org.name}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" asChild aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
                <Link to="/dashboard/notifications" className="relative">
                  <Bell className="size-5" />
                  {!!unread && <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-gold text-[10px] font-semibold text-sidebar-primary-foreground">{unread > 9 ? "9+" : unread}</span>}
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="gap-2">
                    <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {(user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="hidden max-w-[16ch] truncate text-sm sm:inline">{user?.name ?? user?.email}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel>
                    <div className="truncate text-sm font-medium">{user?.email ?? user?.name}</div>
                    <div className="text-xs font-normal text-muted-foreground">{orgContext.roleLabel}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/dashboard/security")}>
                    <Lock className="mr-2 size-4" /> Security settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/developers")}>
                    <FileText className="mr-2 size-4" /> Documentation
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async () => {
                      await signOut();
                      navigate("/");
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 size-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          {suspended && (
            <div role="alert" className="border-b border-status-attention bg-status-attention-bg px-4 py-2 text-sm text-status-attention md:px-8">
              This organization is {orgContext.org.status}. New payments are blocked. Contact support@usopgrid.com.
            </div>
          )}
          <main id="dash-main" className="flex-1 p-4 md:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </StepUpProvider>
  );
}
