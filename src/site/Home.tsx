import { Link } from "react-router";
import { SiteLayout, usePageMeta } from "./SiteLayout";
import { RouteMap } from "./RouteMap";
import { CodeSample } from "./CodeSample";
import { regionCoverage, STATS } from "./coverage";

const CAPABILITIES = [
  {
    cap: "Connectivity",
    sub: "Connect",
    what: "One integration reaches global acquirers, regional processors, mobile-money networks and local methods. Add a provider by pasting its credentials; your code does not change.",
    proof: `${STATS.providers} provider adapters`,
  },
  {
    cap: "Processing",
    sub: "Process",
    what: "A versioned REST API with idempotency keys, correlation ids, signed webhooks and a strict transaction state machine. A late or duplicate provider event can never move a payment backwards.",
    proof: "16 lifecycle states",
  },
  {
    cap: "Orchestration",
    sub: "Route",
    what: "Every payment is scored against each eligible provider on observed success rate, cost and latency, then your own rules. If a provider refuses before processing, the payment moves to the next one. If the answer is ambiguous, it never does.",
    proof: "Explainable per payment",
  },
  {
    cap: "Precision",
    sub: "Reconcile",
    what: "Integer minor units, exact FX arithmetic, balanced double-entry postings and line-by-line matching of provider settlement reports. Every exception is typed and resolved through an audited workflow.",
    proof: "No floats, no silent fixes",
  },
  {
    cap: "Intelligence",
    sub: "Observe",
    what: "Success, approval and failover rates by provider, country, method and currency; cost per successful payment; anomaly alerts when a provider degrades; forecasts from your own history.",
    proof: "Computed from real records",
  },
];

const LIFECYCLE = [
  { t: "Validated", p: "Amount, currency exponent, method and country are checked before anything is stored." },
  { t: "Screened", p: "Risk rules and jurisdiction policy run, with optional sanctions watchlist screening." },
  { t: "Routed", p: "Eligible providers are ranked and the decision, with every reason, is saved." },
  { t: "Processed", p: "The charge runs with a provider-side idempotency key and bounded timeouts." },
  { t: "Confirmed", p: "Unknown outcomes are resolved by status lookups and signed webhooks, not retries." },
  { t: "Reconciled", p: "The ledger posts, then the provider's settlement report is matched line by line." },
];

export default function Home() {
  usePageMeta("USOPGRID", "Enterprise payment infrastructure for connecting providers, orchestrating transactions, and delivering operational visibility through a unified platform.");
  const regions = regionCoverage();
  return (
    <SiteLayout>
      <section className="ug-dark ug-hero">
        <div className="ug-wrap ug-hero-grid">
          <div>
            <h1 className="ug-h1">USOPGRID</h1>
            <p className="ug-tag">Powering Every Payment Connection.</p>
            <p className="ug-lede">
              Enterprise payment infrastructure for connecting providers, orchestrating transactions, and delivering operational visibility through a
              unified platform.
            </p>
            <div className="ug-actions">
              <Link to="/platform" className="ug-btn ug-btn-signal">
                Explore the Platform
              </Link>
              <Link to="/developers" className="ug-btn ug-btn-ghost">
                Read the API Documentation
              </Link>
              <Link to="/contact" className="ug-btn ug-btn-quiet">
                Contact Enterprise Sales
              </Link>
            </div>
          </div>
          <RouteMap />
        </div>
      </section>

      <section className="ug-section">
        <div className="ug-wrap">
          <div className="ug-sec-head">
            <h2 className="ug-h2">Five jobs, one platform between your business and the payment networks</h2>
          </div>
          <table className="ug-table">
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">What USOPGRID does</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((c) => (
                <tr key={c.cap}>
                  <td>
                    <span className="cap">{c.cap}</span>
                    <span className="cap-sub">{c.sub}</span>
                  </td>
                  <td>{c.what}</td>
                  <td>
                    <span className="proof">{c.proof}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ug-section ug-dark">
        <div className="ug-wrap">
          <div className="ug-sec-head">
            <h2 className="ug-h2">The life of a payment</h2>
            <p className="ug-lede">Each step is recorded as an immutable event, so support, finance and engineering read the same timeline.</p>
          </div>
          <ol className="ug-steps">
            {LIFECYCLE.map((s, i) => (
              <li key={s.t}>
                <span className="n">{String(i + 1).padStart(2, "0")}</span>
                <span className="t">{s.t}</span>
                <p>{s.p}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ug-section">
        <div className="ug-wrap">
          <div className="ug-sec-head">
            <h2 className="ug-h2">Built to reach every market your customers pay from</h2>
            <p className="ug-lede">
              {STATS.currencies} active ISO 4217 currencies with their correct minor units, {STATS.countries} ISO 3166 territories, and{" "}
              {STATS.methods} payment-method families. Regional specialists sit alongside global acquirers, and the router picks per payment.
            </p>
          </div>
          <div className="ug-cover">
            {regions.map((r) => (
              <div className="ug-cover-row" key={r.region}>
                <div>
                  <h3 className="ug-h3">{r.name}</h3>
                  <span className="n">{r.countries} territories</span>
                </div>
                <div className="ug-chips">
                  {r.providers.map((p) => (
                    <span key={p.id} className={`ug-chip ${p.countries !== "global" ? "on" : ""}`}>
                      {p.displayName}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 20, fontSize: 14, color: "var(--ink-3)", maxWidth: "80ch" }}>
            Highlighted providers are local specialists for that region. Live availability in a country depends on the provider accounts you hold and
            their licensing; payments to comprehensively sanctioned jurisdictions are blocked by policy.{" "}
            <Link to="/integrations">Browse the integrations directory</Link>.
          </p>
        </div>
      </section>

      <section className="ug-section ug-mist">
        <div className="ug-wrap ug-split">
          <div>
            <h2 className="ug-h2">One request. The routing, retries and recovery are ours.</h2>
            <ul className="ug-facts">
              <li>
                <strong>Idempotent by design.</strong> Send an Idempotency-Key and a retried request returns the original result instead of charging twice.
              </li>
              <li>
                <strong>Honest outcomes.</strong> When a provider times out, the payment stays pending with <code>outcome_unknown: true</code> until its
                status is confirmed.
              </li>
              <li>
                <strong>A sandbox that misbehaves on request.</strong> Simulate declines, timeouts, outages and failover with a single metadata field.
              </li>
              <li>
                <strong>OpenAPI 3.1.</strong> The spec is generated from the same registries the API runs on, so it cannot drift.
              </li>
            </ul>
            <div className="ug-actions" style={{ marginTop: 28 }}>
              <Link to="/developers" className="ug-btn ug-btn-primary">
                Read the API Documentation
              </Link>
              <Link to="/auth" className="ug-btn ug-btn-quiet">
                Get sandbox keys
              </Link>
            </div>
          </div>
          <CodeSample />
        </div>
      </section>

      <section className="ug-section">
        <div className="ug-wrap">
          <div className="ug-sec-head">
            <h2 className="ug-h2">Controls a finance team and an auditor will both accept</h2>
          </div>
          <div className="ug-cols">
            <div>
              <h3 className="ug-h3">Tenant isolation</h3>
              <p>Every query resolves your organization from your session or API key on the server. Nothing in a request can reach another tenant.</p>
            </div>
            <div>
              <h3 className="ug-h3">Sealed credentials</h3>
              <p>Provider secrets are encrypted with AES-256-GCM, bound to their connection, and never returned to a browser or an API response.</p>
            </div>
            <div>
              <h3 className="ug-h3">Step-up for sensitive changes</h3>
              <p>Routing changes, new credentials, key rotation and refunds can require a fresh authenticator code, with every change in the audit log.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="ug-section ug-dark">
        <div className="ug-wrap ug-cta">
          <h2 className="ug-h2">Bring your providers. Keep every payment moving.</h2>
          <div className="ug-actions">
            <Link to="/contact" className="ug-btn ug-btn-signal">
              Contact Enterprise Sales
            </Link>
            <Link to="/auth" className="ug-btn ug-btn-ghost">
              Start in the sandbox
            </Link>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
