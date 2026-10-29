import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./fonts.css";
import "./index.css";

// Lazy load route components for better code splitting
const Home = lazy(() => import("./site/Home.tsx"));
const SiteDevelopers = lazy(() => import("./site/Developers.tsx"));
const SitePages = import("./site/Pages.tsx");
const Platform = lazy(() => SitePages.then((m) => ({ default: m.Platform })));
const Orchestration = lazy(() => SitePages.then((m) => ({ default: m.Orchestration })));
const Integrations = lazy(() => SitePages.then((m) => ({ default: m.Integrations })));
const Enterprise = lazy(() => SitePages.then((m) => ({ default: m.Enterprise })));
const SecurityPage = lazy(() => SitePages.then((m) => ({ default: m.Security })));
const Privacy = lazy(() => SitePages.then((m) => ({ default: () => m.Legal({ page: "privacy" }) })));
const Terms = lazy(() => SitePages.then((m) => ({ default: () => m.Legal({ page: "terms" }) })));
const Disclosures = lazy(() => SitePages.then((m) => ({ default: () => m.Legal({ page: "disclosures" }) })));
const ContactRoute = lazy(() => import("./site/routes.tsx").then((m) => ({ default: m.ContactRoute })));
const StatusRoute = lazy(() => import("./site/routes.tsx").then((m) => ({ default: m.StatusRoute })));
const Providers = lazy(() => import("./pages/dashboard/Providers.tsx"));
const Routing = lazy(() => import("./pages/dashboard/Routing.tsx"));
const Reconciliation = lazy(() => import("./pages/dashboard/Reconciliation.tsx"));
const Analytics = lazy(() => import("./pages/dashboard/Analytics.tsx"));
const Reports = lazy(() => import("./pages/dashboard/Reports.tsx"));
const Organization = lazy(() => import("./pages/dashboard/Organization.tsx"));
const SecuritySettings = lazy(() => import("./pages/dashboard/Security.tsx"));
const Notifications = lazy(() => import("./pages/dashboard/Notifications.tsx"));
const Operations = lazy(() => import("./pages/dashboard/Operations.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Overview = lazy(() => import("./pages/dashboard/Overview.tsx"));
const Transactions = lazy(() => import("./pages/dashboard/Transactions.tsx"));
const TransactionDetail = lazy(() => import("./pages/dashboard/TransactionDetail.tsx"));
const Settlements = lazy(() => import("./pages/dashboard/Settlements.tsx"));
const Developers = lazy(() => import("./pages/dashboard/Developers.tsx"));
const Webhooks = lazy(() => import("./pages/dashboard/Webhooks.tsx"));
const Repositories = lazy(() => import("./pages/dashboard/Repositories.tsx"));
const Team = lazy(() => import("./pages/dashboard/Team.tsx"));
const Audit = lazy(() => import("./pages/dashboard/Audit.tsx"));
const Customers = lazy(() => import("./pages/dashboard/Customers.tsx"));
const PaymentLinks = lazy(() => import("./pages/dashboard/PaymentLinks.tsx"));
const Payouts = lazy(() => import("./pages/dashboard/Payouts.tsx"));
const Disputes = lazy(() => import("./pages/dashboard/Disputes.tsx"));
const Checkout = lazy(() => import("./pages/Checkout.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center" aria-busy="true">
      <div className="animate-pulse text-muted-foreground">Loading…</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {import.meta.env.DEV && this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

/**
 * Editor-preview helpers (element picker, route sync with a parent frame) only
 * run in development or when explicitly enabled. In production builds they are
 * off: they talk to any parent window ("*"), which a hostile site framing the
 * dashboard could abuse. Production also sends frame-ancestors 'none'.
 */
const EDITOR_PREVIEW = import.meta.env.DEV || import.meta.env.VITE_EDITOR_PREVIEW === "true";
// The editor platform's runtime (screenshots for project thumbnails) loads a
// script from a public CDN, so it is only pulled in for editor previews.
if (EDITOR_PREVIEW) void import("@vly-ai/integrations");



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {EDITOR_PREVIEW && (
        <ToolbarErrorBoundary>
          <VlyToolbar />
        </ToolbarErrorBoundary>
      )}
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          {EDITOR_PREVIEW && <RouteSyncer />}
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/platform" element={<Platform />} />
              <Route path="/orchestration" element={<Orchestration />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/developers" element={<SiteDevelopers />} />
              <Route path="/docs" element={<SiteDevelopers />} />
              <Route path="/enterprise" element={<Enterprise />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/contact" element={<ContactRoute />} />
              <Route path="/status" element={<StatusRoute />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/disclosures" element={<Disclosures />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/dashboard" />}
              />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <Dashboard />
                  </RequireAuth>
                }
              >
                <Route index element={<Overview />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="transactions/:transactionId" element={<TransactionDetail />} />
                <Route path="settlements" element={<Settlements />} />
                <Route path="customers" element={<Customers />} />
                <Route path="links" element={<PaymentLinks />} />
                <Route path="payouts" element={<Payouts />} />
                <Route path="disputes" element={<Disputes />} />
                <Route path="developers" element={<Developers />} />
                <Route path="webhooks" element={<Webhooks />} />
                <Route path="repositories" element={<Repositories />} />
                <Route path="team" element={<Team />} />
                <Route path="audit" element={<Audit />} />
                <Route path="providers" element={<Providers />} />
                <Route path="routing" element={<Routing />} />
                <Route path="reconciliation" element={<Reconciliation />} />
                <Route path="analytics" element={<Analytics />} />
                <Route path="reports" element={<Reports />} />
                <Route path="organization" element={<Organization />} />
                <Route path="security" element={<SecuritySettings />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="operations" element={<Operations />} />
              </Route>
              <Route path="/pay/:linkId" element={<Checkout />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
