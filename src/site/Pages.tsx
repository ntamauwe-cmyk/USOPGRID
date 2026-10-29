// Public site pages other than the homepage and the developer portal.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { SiteLayout, usePageMeta } from "./SiteLayout";
import { LIVE_PROVIDERS, CATEGORY_LABELS, METHOD_LABELS, regionCoverage, servesCountry, STATS } from "./coverage";
import { COUNTRIES, getCountry } from "@/lib/geo";
import { USOPGRID_COMPANY } from "@/components/brand";

function PageHead({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (
    <section className="ug-dark ug-page-head">
      <div className="ug-wrap">
        <h1 className="ug-h1">{title}</h1>
        <p className="ug-lede">{lede}</p>
        {children && <div className="ug-actions" style={{ marginTop: 28 }}>{children}</div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
export function Platform() {
  usePageMeta("Platform", "The USOPGRID platform: provider connectivity, a payments API, orchestration, a double-entry ledger, reconciliation, analytics and operations tooling.");
  const layers = [
    ["Merchant dashboard and API", "Payments, refunds, payouts, payment links, customers, disputes, keys, webhooks and team roles, through the dashboard or the versioned REST API."],
    ["Validation, risk and compliance", "Currency-exponent checks, transparent rule-based risk scoring on USD-normalized amounts, jurisdiction policy and optional sanctions watchlist screening."],
    ["Orchestration engine", "Eligibility from each provider's declared coverage, scoring on success, cost and latency, your routing rules, circuit breakers and a safe failover chain."],
    ["Provider adapters", `${STATS.providers} adapters behind one contract: charge, status, refund, webhook verification and normalization. A new provider is one file.`],
    ["Ledger and reconciliation", "Immutable balanced postings in integer minor units, settlement batches, and line-by-line matching of provider settlement reports."],
    ["Recovery and observability", "A recovery queue for unknown outcomes, signed outbound webhooks with dead-lettering, provider health, anomaly alerts and a full audit trail."],
  ];
  return (
    <SiteLayout>
      <PageHead title="One platform from API call to reconciled ledger" lede="USOPGRID sits between your business and every payment provider you use. These are the layers each payment passes through.">
        <Link to="/developers" className="ug-btn ug-btn-signal">Read the API Documentation</Link>
        <Link to="/contact" className="ug-btn ug-btn-ghost">Contact Enterprise Sales</Link>
      </PageHead>
      <section className="ug-section">
        <div className="ug-wrap">
          <table className="ug-table">
            <thead><tr><th scope="col">Layer</th><th scope="col">Responsibility</th></tr></thead>
            <tbody>
              {layers.map(([l, d]) => (
                <tr key={l}><td><span className="cap">{l}</span></td><td>{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="ug-section ug-mist">
        <div className="ug-wrap">
          <div className="ug-sec-head"><h2 className="ug-h2">Invariants the platform will not break</h2></div>
          <div className="ug-cols">
            <div><h3 className="ug-h3">Money is integers</h3><p>Every amount is stored in the currency's ISO 4217 minor unit. FX uses exact rational arithmetic with half-even rounding at the end.</p></div>
            <div><h3 className="ug-h3">One instruction, one charge</h3><p>Provider-side idempotency keys are stable per payment and connection. An ambiguous response is resolved by lookup, never by re-sending.</p></div>
            <div><h3 className="ug-h3">State only moves forward</h3><p>An explicit transition table governs all 16 states. Contradictory provider reports become reconciliation exceptions for finance.</p></div>
            <div><h3 className="ug-h3">The ledger is the source of truth</h3><p>Entries are never edited or deleted. Corrections are new, balanced postings with an audit record.</p></div>
            <div><h3 className="ug-h3">Sandbox and live never mix</h3><p>The environment comes from the API key. Sandbox keys cannot reach live credentials; live keys cannot reach simulation rails.</p></div>
            <div><h3 className="ug-h3">Tenants are isolated server-side</h3><p>Organization context is derived from the session or key on every request, never from request parameters.</p></div>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
export function Orchestration() {
  usePageMeta("Payment orchestration", "Intelligent routing, explainable provider scoring, circuit breakers, safe failover and a recovery queue for unknown outcomes.");
  return (
    <SiteLayout>
      <PageHead title="Route every payment to the provider most likely to succeed" lede="USOPGRID scores each eligible provider per payment, follows your rules, and fails over only when the first provider provably did not process the instruction." />
      <section className="ug-section">
        <div className="ug-wrap ug-split">
          <div>
            <h2 className="ug-h2">How a provider is chosen</h2>
            <ul className="ug-facts">
              <li><strong>Eligibility.</strong> Country, currency, payment method and amount limits from the provider's declared coverage, your enabled connections, and its circuit breaker state.</li>
              <li><strong>Your rules first.</strong> Prefer, exclude or restrict providers by country, currency, method, amount band or risk score, in the order you set.</li>
              <li><strong>Scoring.</strong> Observed success rate (smoothed so new providers are not over- or under-trusted), effective fee rate and latency, with weights you control.</li>
              <li><strong>Explanation stored.</strong> Each candidate's verdict and score is saved with the payment and shown in the dashboard and API.</li>
            </ul>
          </div>
          <div className="ug-code" aria-label="Example routing explanation">
            <pre><code>
              <span className="c"># GET /api/v1/payments/txn_m2x9…  (routing excerpt)</span>{"\n"}
              {"{"} <span className="k">"explanation"</span>: <span className="s">"Selected paystack (score 0.912: success 97.4%,{"\n"}   cost 81, latency 86); failover: flutterwave → stripe.{"\n"}   Rules applied: Prefer local rails in Nigeria."</span>,{"\n"}
              {"  "}<span className="k">"chain"</span>: [<span className="s">"paystack"</span>, <span className="s">"flutterwave"</span>, <span className="s">"stripe"</span>],{"\n"}
              {"  "}<span className="k">"attempt_log"</span>: [{"\n"}
              {"    "}{"{"} <span className="k">"provider"</span>: <span className="s">"paystack"</span>, <span className="k">"status"</span>: <span className="s">"failed"</span>,{"\n"}
              {"      "}<span className="k">"failure"</span>: {"{"} <span className="k">"code"</span>: <span className="s">"circuit_open"</span> {"}"} {"}"},{"\n"}
              {"    "}{"{"} <span className="k">"provider"</span>: <span className="s">"flutterwave"</span>, <span className="k">"status"</span>: <span className="s">"successful"</span>,{"\n"}
              {"      "}<span className="k">"latency_ms"</span>: 412 {"}"} ] {"}"}
            </code></pre>
          </div>
        </div>
      </section>
      <section className="ug-section ug-dark">
        <div className="ug-wrap">
          <div className="ug-sec-head"><h2 className="ug-h2">When to fail over, and when never to</h2></div>
          <table className="ug-table" style={{ color: "#fff" }}>
            <thead><tr><th scope="col" style={{ color: "var(--on-dark-2)", borderColor: "#fff" }}>Provider answer</th><th scope="col" style={{ color: "var(--on-dark-2)", borderColor: "#fff" }}>What USOPGRID does</th></tr></thead>
            <tbody>
              {[
                ["Success, pending or customer action", "Stops. The payment is moving; pending outcomes are confirmed by webhook or status lookup."],
                ["Issuer decline", "Stops. The customer's bank said no; sending it elsewhere would only repeat the decline."],
                ["Refused before processing (auth error, validation, rate limit, open circuit)", "Moves to the next provider in the chain with a new provider-side idempotency key."],
                ["Timeout, network error or 5xx", "Never fails over. The first provider may have charged the customer. The payment stays pending and the recovery queue asks that same provider for the outcome on a backoff schedule up to 72 hours, then escalates to finance."],
              ].map(([a, b]) => (
                <tr key={a}><td style={{ color: "#fff", borderColor: "var(--line-dark)" }}><span className="cap" style={{ fontSize: "1rem" }}>{a}</span></td><td style={{ color: "var(--on-dark)", borderColor: "var(--line-dark)" }}>{b}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="ug-section">
        <div className="ug-wrap ug-cols">
          <div><h3 className="ug-h3">Circuit breakers</h3><p>After repeated provider-side failures a connection is taken out of rotation, probed by a single request after a cooldown, and restored on success. Declines never trip it.</p></div>
          <div><h3 className="ug-h3">Health from real traffic</h3><p>Success, error and latency figures come from your own attempts, per provider and environment, and feed the router within minutes.</p></div>
          <div><h3 className="ug-h3">Operator control</h3><p>Priorities, exclusions, weights and maximum providers per payment are set in the dashboard. Every change needs routing permission and is audited.</p></div>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
export function Integrations() {
  usePageMeta("Integrations", "Payment providers USOPGRID connects to, with their countries, currencies and payment methods.");
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [method, setMethod] = useState("");
  const countries = useMemo(() => Object.values(COUNTRIES).sort((a, b) => a.name.localeCompare(b.name)), []);
  const rows = LIVE_PROVIDERS.filter(
    (p) =>
      (!q || `${p.displayName} ${p.description}`.toLowerCase().includes(q.toLowerCase())) &&
      (!country || servesCountry(p, country)) &&
      (!method || (p.methods as readonly string[]).includes(method)),
  );
  const cname = country ? getCountry(country)?.name : null;
  return (
    <SiteLayout>
      <PageHead title="Integrations directory" lede={`${STATS.providers} payment providers behind one API. Filter by where your customers are and how they pay.`} />
      <section className="ug-section">
        <div className="ug-wrap">
          <div className="ug-filters" role="search">
            <label className="sr-only" htmlFor="ug-q">Search providers</label>
            <input id="ug-q" className="ug-input" placeholder="Search providers" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} />
            <label className="sr-only" htmlFor="ug-c">Customer country</label>
            <select id="ug-c" className="ug-select" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <label className="sr-only" htmlFor="ug-m">Payment method</label>
            <select id="ug-m" className="ug-select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">All methods</option>
              {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <p aria-live="polite" style={{ fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>
            {rows.length} {rows.length === 1 ? "provider" : "providers"}{cname ? ` serving customers in ${cname}` : ""}
          </p>
          {rows.length === 0 ? (
            <p style={{ padding: "32px 0", color: "var(--ink-2)" }}>
              No connected provider covers that combination yet. <Link to="/contact">Tell us the market</Link> and we will prioritize the integration.
            </p>
          ) : (
            <table className="ug-dir">
              <thead><tr><th>Provider</th><th>Type</th><th>Coverage</th><th>Methods</th><th>Operations</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td><div className="name">{p.displayName}</div><div className="desc">{p.description}</div></td>
                    <td>{CATEGORY_LABELS[p.category]}</td>
                    <td>{p.countries === "global" ? "Global card acceptance" : `${p.countries.length} countries`}<div className="desc">{p.currencies === "all" ? "135+ currencies" : p.currencies.length > 10 ? `${p.currencies.slice(0, 10).join(", ")} and ${p.currencies.length - 10} more` : p.currencies.join(", ")}</div></td>
                    <td><div className="ug-chips">{p.methods.map((m) => <span className="ug-chip" key={m}>{METHOD_LABELS[m]}</span>)}</div></td>
                    <td style={{ fontSize: 14 }}>
                      {[p.operations.refund && (p.operations.partialRefund ? "Partial refunds" : "Refunds"), p.operations.webhooks && "Signed webhooks", p.operations.status && "Status lookup", p.operations.settlementReports && "Settlement reports"].filter(Boolean).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ marginTop: 24, fontSize: 14, color: "var(--ink-3)", maxWidth: "80ch" }}>
            Coverage is what each provider's API supports. Processing live in a market requires your own merchant account with that provider (or a USOPGRID platform account where offered) and its onboarding and licensing requirements.
          </p>
        </div>
      </section>
      <section className="ug-section ug-mist">
        <div className="ug-wrap">
          <div className="ug-sec-head"><h2 className="ug-h2">Coverage by region</h2></div>
          <div className="ug-cover">
            {regionCoverage().map((r) => (
              <div className="ug-cover-row" key={r.region}>
                <div><h3 className="ug-h3">{r.name}</h3><span className="n">{r.localProviders.length} local, {r.providers.length - r.localProviders.length} global</span></div>
                <div className="ug-chips">{r.methods.map((m) => <span className="ug-chip" key={m}>{METHOD_LABELS[m]}</span>)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
export function Enterprise() {
  usePageMeta("Enterprise", "Organizations, roles, routing control, reconciliation, audit and operational tooling for enterprise payment teams.");
  return (
    <SiteLayout>
      <PageHead title="Built for the teams that run payments" lede="Engineering, finance, operations and compliance work in one system with the access each role needs and an audit trail of everything they change.">
        <Link to="/contact" className="ug-btn ug-btn-signal">Contact Enterprise Sales</Link>
      </PageHead>
      <section className="ug-section">
        <div className="ug-wrap">
          <table className="ug-table">
            <thead><tr><th scope="col">Role</th><th scope="col">What they can do</th></tr></thead>
            <tbody>
              {[
                ["Organization Owner", "Everything, including security policy and granting ownership."],
                ["Administrator", "Manage the organization, team, keys, providers, routing and webhooks."],
                ["Developer", "API keys, webhooks, provider connections, routing rules and the sandbox."],
                ["Finance & Reconciliation", "Ledger, settlements, refunds, settlement-report reconciliation and exports."],
                ["Operations", "Settlements, routing adjustments, refunds and analytics."],
                ["Risk & Compliance", "Risk configuration, audit history and analytics."],
                ["Read-only Analyst", "Dashboards and analytics, no changes."],
              ].map(([r, d]) => <tr key={r}><td><span className="cap" style={{ fontSize: "1rem" }}>{r}</span></td><td>{d}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>
      <section className="ug-section ug-mist">
        <div className="ug-wrap ug-cols">
          <div><h3 className="ug-h3">Bring your own provider contracts</h3><p>Connect your negotiated accounts and enter your agreed pricing; the router uses your real costs instead of list prices.</p></div>
          <div><h3 className="ug-h3">Reconciliation finance signs off on</h3><p>Upload provider settlement reports and get typed exceptions: missing, duplicate, amount, currency, fee and status mismatches, each resolved with a recorded note.</p></div>
          <div><h3 className="ug-h3">Limits and policy</h3><p>Per-transaction ceilings, MFA step-up for sensitive actions, key rotation with grace periods and sanctions screening on live traffic.</p></div>
          <div><h3 className="ug-h3">Multi-entity ready</h3><p>Several connections to the same provider, each with its own credentials, priority and pricing, for groups operating in many countries.</p></div>
          <div><h3 className="ug-h3">Exports and reporting</h3><p>Transaction, provider-performance and API-usage data export to CSV with formula-injection protection, ready for your BI tools.</p></div>
          <div><h3 className="ug-h3">Operational support</h3><p>A platform operations console watches provider health, recovery queues and webhook delivery around the clock.</p></div>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
export function Security() {
  usePageMeta("Security", "How USOPGRID protects credentials, payment data and access.");
  const rows = [
    ["Card data", "USOPGRID never receives raw card numbers. Cards are tokenized by the provider's hosted fields or SDK; USOPGRID handles only the token, which keeps your PCI DSS scope minimal."],
    ["Provider credentials", "Sealed with AES-256-GCM under a platform key, bound to the connection id as additional authenticated data, decrypted only inside the payment runtime and never returned."],
    ["API keys", "Shown once, stored as SHA-256 hashes, separated into sandbox and live, rate limited per key, and rotatable with a grace period."],
    ["Access", "Role-based permissions enforced on the server, TOTP multi-factor authentication with single-use codes and recovery codes, and step-up for sensitive actions."],
    ["Webhooks", "Outbound events are signed with HMAC-SHA256 and a timestamp. Inbound provider events are verified with each provider's own signature scheme before they are applied, and de-duplicated."],
    ["Integrity", "Idempotent writes, an explicit state machine, immutable double-entry postings and an append-only audit log with actor, before and after."],
    ["Compliance screening", "Jurisdiction policy blocks comprehensively sanctioned territories and holds high-risk ones for review; live payments can be screened against consolidated sanctions lists."],
    ["Privacy", "Fonts and assets are self-hosted, so browsing the site sends no data to third parties. Bank account numbers are stored only as masked values and hashes."],
  ];
  return (
    <SiteLayout>
      <PageHead title="Security at every connection" lede="Controls designed for payment data, described plainly. Report a vulnerability to security@usopgrid.com." />
      <section className="ug-section">
        <div className="ug-wrap">
          <table className="ug-table">
            <tbody>{rows.map(([a, b]) => <tr key={a}><td><span className="cap" style={{ fontSize: "1rem" }}>{a}</span></td><td>{b}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
type Submitter = (d: { name: string; email: string; company: string; country: string; volume: string; message: string; website: string }) => Promise<unknown>;

export function Contact({ submit }: { submit?: Submitter }) {
  usePageMeta("Contact", "Talk to USOPGRID enterprise sales.");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const countries = useMemo(() => Object.values(COUNTRIES).sort((a, b) => a.name.localeCompare(b.name)), []);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const d = Object.fromEntries(["name", "email", "company", "country", "volume", "message", "website"].map((k) => [k, String(f.get(k) ?? "")])) as Parameters<Submitter>[0];
    if (!d.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) || !d.company.trim()) {
      setError("Enter your name, a valid work email and your company.");
      setState("error");
      return;
    }
    setState("sending");
    try {
      if (submit) await submit(d);
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*?Error:\s*/, "") : "Your message could not be sent. Email sales@usopgrid.com instead.");
      setState("error");
    }
  }
  return (
    <SiteLayout>
      <PageHead title="Contact enterprise sales" lede="Tell us where your customers are and which providers you use today. A payments engineer replies within one business day." />
      <section className="ug-section">
        <div className="ug-wrap ug-split">
          {state === "sent" ? (
            <div role="status">
              <h2 className="ug-h2">Message sent</h2>
              <p className="ug-lede" style={{ marginTop: 12 }}>Thanks. We will reply to the email you gave us. Meanwhile, you can <Link to="/auth">open a sandbox account</Link>.</p>
            </div>
          ) : (
            <form className="ug-form" onSubmit={onSubmit} noValidate>
              <div className="row">
                <label>Full name<input className="ug-input" name="name" autoComplete="name" required /></label>
                <label>Work email<input className="ug-input" name="email" type="email" autoComplete="email" required /></label>
              </div>
              <div className="row">
                <label>Company<input className="ug-input" name="company" autoComplete="organization" required /></label>
                <label>Country
                  <select className="ug-select" name="country" defaultValue="">
                    <option value="">Select</option>
                    {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </label>
              </div>
              <label>Monthly payment volume (USD)
                <select className="ug-select" name="volume" defaultValue="">
                  <option value="">Select</option>
                  <option>Under 100k</option><option>100k to 1M</option><option>1M to 10M</option><option>10M to 100M</option><option>Over 100M</option>
                </select>
              </label>
              <label>What do you need?<span className="hint">Markets, payment methods, current providers, timelines</span>
                <textarea className="ug-textarea" name="message" rows={5} maxLength={4000} />
              </label>
              <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px" }} />
              {state === "error" && <p className="err" role="alert">{error}</p>}
              <div><button className="ug-btn ug-btn-primary" type="submit" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send message"}</button></div>
            </form>
          )}
          <div className="ug-prose">
            <h2 className="ug-h3" style={{ marginBottom: 10 }}>Other ways to reach us</h2>
            <p>Sales: sales@usopgrid.com</p>
            <p>Developer support: developers@usopgrid.com</p>
            <p>Security reports: security@usopgrid.com</p>
            <p style={{ marginTop: 18 }}>USOPGRID is built and operated by {USOPGRID_COMPANY}.</p>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
export function Status({ apiBase }: { apiBase?: string }) {
  usePageMeta("System status", "Live status of the USOPGRID API.");
  const [api, setApi] = useState<{ state: "checking" | "ok" | "down" | "unconfigured"; ms?: number; at?: number; version?: string }>({ state: apiBase ? "checking" : "unconfigured" });
  useEffect(() => {
    if (!apiBase) return;
    let alive = true;
    const check = async () => {
      const t = performance.now();
      try {
        const r = await fetch(`${apiBase}/api/v1/health`, { cache: "no-store" });
        const j = await r.json();
        if (alive) setApi({ state: r.ok ? "ok" : "down", ms: Math.round(performance.now() - t), at: Date.now(), version: j?.data?.api_version });
      } catch {
        if (alive) setApi({ state: "down", at: Date.now() });
      }
    };
    void check();
    const id = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiBase]);
  const label = { checking: "Checking", ok: "Operational", down: "Unreachable", unconfigured: "Not configured in this build" }[api.state];
  const dot = { checking: "idle", ok: "ok", down: "down", unconfigured: "idle" }[api.state];
  return (
    <SiteLayout>
      <PageHead title="System status" lede="Checked live from your browser every 30 seconds." />
      <section className="ug-section">
        <div className="ug-wrap" style={{ maxWidth: 820 }}>
          <div className="ug-status-row" aria-live="polite">
            <div><span className={`ug-dot ${dot}`} />Payments API <span style={{ color: "var(--ink-3)", fontSize: 14 }}>/api/v1</span></div>
            <strong>{label}{api.ms !== undefined ? `, ${api.ms} ms` : ""}</strong>
          </div>
          <div className="ug-status-row"><div><span className={`ug-dot ${dot}`} />Dashboard</div><strong>{api.state === "ok" ? "Operational" : label}</strong></div>
          <div className="ug-status-row"><div><span className={`ug-dot ${dot}`} />Webhook delivery</div><strong>{api.state === "ok" ? "Operational" : label}</strong></div>
          <p style={{ marginTop: 20, fontSize: 14, color: "var(--ink-3)" }}>
            {api.at ? `Last checked ${new Date(api.at).toLocaleTimeString()}. ` : ""}
            {api.version ? `API version ${api.version}. ` : ""}Provider-level incidents appear in your dashboard notifications.
          </p>
        </div>
      </section>
    </SiteLayout>
  );
}

// ---------------------------------------------------------------------------
const LEGAL: Record<string, { title: string; lede: string; body: [string, string][] }> = {
  privacy: {
    title: "Privacy notice",
    lede: `How ${USOPGRID_COMPANY} handles personal data in USOPGRID.`,
    body: [
      ["Who we are", `${USOPGRID_COMPANY} operates USOPGRID. For payments processed through USOPGRID, the merchant is the controller of its customers' data and we act as its processor; for account holders and website visitors we are the controller.`],
      ["What we process", "Account data (name, email, role), payment records (amounts, currencies, references, payer email, name and country when supplied, provider references), technical logs, and audit records. We do not receive or store raw card numbers. Bank account numbers are stored masked and hashed."],
      ["Why", "To provide and secure the service, prevent fraud, meet legal obligations including sanctions and anti-money-laundering requirements, and support customers. We do not sell personal data or use it for advertising."],
      ["Sharing", "With the payment providers and financial institutions a merchant connects, to process its payments; with infrastructure sub-processors under contract; and with authorities where the law requires."],
      ["International transfers", "Data may be processed outside your country. Where required, transfers rely on adequacy decisions, standard contractual clauses or equivalent safeguards."],
      ["Retention", "Payment and ledger records are kept for the period financial regulation requires (typically 5 to 10 years depending on jurisdiction); other data only as long as needed."],
      ["Your rights", "Depending on where you live (for example under the GDPR, UK GDPR, NDPA, POPIA, LGPD, CCPA or PDPA) you may access, correct, delete, restrict or port your data and object to processing. Contact privacy@usopgrid.com; we may ask the merchant you paid to act on payment-related requests."],
    ],
  },
  terms: {
    title: "Terms of service",
    lede: "The summary terms that govern use of USOPGRID. Enterprise agreements take precedence where signed.",
    body: [
      ["The service", "USOPGRID provides software for connecting to payment providers, orchestrating, recording and reconciling payments. It is not a bank, does not hold customer funds and is not a party to the payments it routes."],
      ["Your provider accounts", "Live processing requires accounts with the payment providers you connect, and you remain bound by their terms, pricing and acceptable-use rules."],
      ["Acceptable use", "You may not use USOPGRID for unlawful activity, for transactions involving comprehensively sanctioned persons or territories, or for products a connected provider prohibits. We may suspend accounts to prevent harm or comply with law."],
      ["Your responsibilities", "Keep keys and credentials secret, verify webhook signatures, honour idempotency semantics and comply with the laws that apply to your business in each market you sell to."],
      ["Availability and changes", "We aim for high availability and announce material API changes in advance. API versions are dated; breaking changes ship under a new version."],
      ["Liability", "To the extent the law allows, liability is limited as set out in your agreement. Nothing limits liability that cannot be limited by law."],
    ],
  },
  disclosures: {
    title: "Disclosures",
    lede: "Important information about what USOPGRID is and is not.",
    body: [
      ["Technology provider", `USOPGRID is a payment technology platform of ${USOPGRID_COMPANY}. It is not a bank, money transmitter, e-money institution or payment institution, and it does not take custody of funds unless and until a licensed arrangement for a specific market is announced.`],
      ["Licensed partners", "Funds are processed, settled and held by the licensed payment service providers, acquirers and financial institutions you connect. Their licences and protections apply to your funds."],
      ["Market availability", "Being able to route a payment in a market depends on provider coverage, your onboarding with those providers and local law. Some jurisdictions are blocked or held for review under sanctions policy."],
      ["Exchange rates", "Rates shown are reference or quoted rates from the sources displayed with each quote, including any disclosed spread. Quotes expire at the time shown."],
      ["Sandbox", "Sandbox simulations never move money. Simulated outcomes are for integration testing only."],
    ],
  },
};

export function Legal({ page }: { page: "privacy" | "terms" | "disclosures" }) {
  const d = LEGAL[page];
  usePageMeta(d.title, d.lede);
  return (
    <SiteLayout>
      <PageHead title={d.title} lede={d.lede} />
      <section className="ug-section">
        <div className="ug-wrap ug-doc" style={{ maxWidth: 860 }}>
          {d.body.map(([h, p]) => (
            <section key={h}>
              <h2>{h}</h2>
              <p>{p}</p>
            </section>
          ))}
          <p style={{ fontSize: 14, color: "var(--ink-3)" }}>Last updated October 2026. Questions: legal@usopgrid.com.</p>
        </div>
      </section>
    </SiteLayout>
  );
}
