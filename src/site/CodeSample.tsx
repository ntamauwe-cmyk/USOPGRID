import { useState, type ReactNode } from "react";

const c = (t: string) => <span className="c">{t}</span>;
const k = (t: string) => <span className="k">{t}</span>;
const s = (t: string) => <span className="s">{t}</span>;

const SAMPLES: Record<string, ReactNode> = {
  curl: (
    <>
      {c("# Create a payment — routed to the best provider for NG / NGN / card")}
      {"\n"}curl https://api.usopgrid.com/api/v1/payments \{"\n"}  -H {s('"Authorization: Bearer sk_sandbox_…"')} \{"\n"}  -H {s('"Idempotency-Key: order-7781-attempt-1"')} \{"\n"}  -d {s("'")}
      {s('{"amount": 2500000, "currency": "NGN", "payment_method": "card",')}
      {"\n"}
      {s('       "country": "NG", "reference": "order-7781",')}
      {"\n"}
      {s('       "customer": {"email": "ada@example.com"}}')}
      {s("'")}
      {"\n\n"}
      {c("# 201 Created")}
      {"\n"}
      {"{"} {k('"id"')}: {s('"txn_m2x9…"')}, {k('"status"')}: {s('"SUCCESSFUL"')},{"\n"}  {k('"provider"')}: {s('"flutterwave"')}, {k('"attempts"')}: 2, {k('"failovers"')}: 1,{"\n"}  {k('"fee"')}: 37500, {k('"net"')}: 2462500, {k('"outcome_unknown"')}: false {"}"}
    </>
  ),
  node: (
    <>
      {c("// Node 18+ — no SDK required")}
      {"\n"}
      {k("const")} res = {k("await")} fetch({s('"https://api.usopgrid.com/api/v1/payments"')}, {"{"}
      {"\n"}  method: {s('"POST"')},{"\n"}  headers: {"{"}{"\n"}    Authorization: {s("`Bearer ${process.env.USOPGRID_SECRET_KEY}`")},{"\n"}    {s('"Idempotency-Key"')}: order.id,{"\n"}    {s('"Content-Type"')}: {s('"application/json"')},{"\n"}  {"}"},{"\n"}  body: JSON.stringify({"{"} amount: 2500000, currency: {s('"NGN"')},{"\n"}    payment_method: {s('"card"')}, country: {s('"NG"')}, reference: order.id {"}"}),{"\n"}
      {"});"}
      {"\n"}
      {k("const")} {"{"} data {"}"} = {k("await")} res.json();{"\n"}
      {k("if")} (data.payment.outcome_unknown) {c("// wait for the payment.successful / payment.failed webhook")}
    </>
  ),
  python: (
    <>
      {c("# Python 3 — requests")}
      {"\n"}
      {k("import")} os, requests{"\n\n"}r = requests.post({"\n"}    {s('"https://api.usopgrid.com/api/v1/payments"')},{"\n"}    headers={"{"}{s('"Authorization"')}: {s('f"Bearer {os.environ[\'USOPGRID_SECRET_KEY\']}"')},{"\n"}             {s('"Idempotency-Key"')}: order_id{"}"},{"\n"}    json={"{"}{s('"amount"')}: 2500000, {s('"currency"')}: {s('"NGN"')}, {s('"payment_method"')}: {s('"card"')},{"\n"}          {s('"country"')}: {s('"NG"')}, {s('"reference"')}: order_id{"}"},{"\n"}    timeout=30,{"\n"}){"\n"}payment = r.json()[{s('"data"')}][{s('"payment"')}]
    </>
  ),
};

export function CodeSample() {
  const [tab, setTab] = useState<keyof typeof SAMPLES>("curl");
  return (
    <div className="ug-code">
      <div className="ug-code-bar" role="tablist" aria-label="Code language">
        {(Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "curl" ? "cURL" : t === "node" ? "Node.js" : "Python"}
          </button>
        ))}
      </div>
      <pre role="tabpanel">
        <code>{SAMPLES[tab]}</code>
      </pre>
    </div>
  );
}
