// Hero visual: one payment's route through USOPGRID, played once.
// Customer → USOPGRID hub → primary provider (refuses: circuit open) →
// safe reroute to the next-best provider → success → ledger + reconciliation.
// With prefers-reduced-motion the final state is shown immediately.

import { EMBLEM_G_PATH, EMBLEM_STROKE, EMBLEM_U_PATH } from "@/components/brand-geometry";

const DOTS = [70, 150, 230, 310, 390, 470].flatMap((x) => [60, 140, 220, 300, 380].map((y) => [x, y] as const));

export function RouteMap() {
  return (
    <svg className="ug-map" viewBox="0 0 640 440" role="img" aria-labelledby="ug-map-title ug-map-desc">
      <title id="ug-map-title">How USOPGRID routes a payment</title>
      <desc id="ug-map-desc">
        A card payment from a customer in Lagos enters USOPGRID, is routed to Paystack, which is unavailable, so USOPGRID safely reroutes it to Flutterwave, where it succeeds and is posted to the ledger.
      </desc>
      <g fill="#F7F5EF" opacity="0.06">
        {DOTS.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2" />
        ))}
      </g>

      {/* rails */}
      <path className="rail" d="M78 220 H196" />
      <path className="rail" d="M292 220 H360 V90 H436" />
      <path className="rail" d="M292 220 H436" />
      <path className="rail" d="M292 220 H360 V350 H436" />

      {/* lit route */}
      <path className="lit s1" d="M78 220 H196" />
      <path className="lit s2" d="M292 220 H360 V90 H436" />
      <path className="lit s3" d="M292 220 H436" />

      {/* origin */}
      <circle cx="64" cy="220" r="13" fill="#F7F5EF" />
      <text className="lbl-strong" x="24" y="262">Customer, Lagos</text>
      <text className="lbl-mono" x="24" y="280">NGN 25,000.00 card</text>

      {/* hub */}
      <rect x="196" y="190" width="96" height="60" rx="4" fill="#0B1930" stroke="#C5A15D" strokeWidth="1.5" />
      <g transform="translate(244 220) scale(0.62) translate(-32 -32)" fill="none" stroke="#C5A15D" strokeWidth={EMBLEM_STROKE} strokeLinejoin="miter">
        <path d={EMBLEM_G_PATH} />
        <path d={EMBLEM_U_PATH} />
      </g>
      <text className="lbl" x="244" y="174" textAnchor="middle">USOPGRID router</text>

      {/* stations */}
      <circle className="st-down" cx="450" cy="90" r="13" fill="#0B1930" stroke="#3A4C6E" strokeWidth="3" />
      <text className="lbl-strong" x="474" y="88">Paystack</text>
      <text className="lbl" x="474" y="106">primary, score 0.91</text>

      <circle className="st-ok" cx="450" cy="220" r="13" fill="#0B1930" stroke="#3A4C6E" strokeWidth="3" />
      <text className="lbl-strong" x="474" y="218">Flutterwave</text>
      <text className="lbl" x="474" y="236">failover, score 0.88</text>

      <circle cx="450" cy="350" r="13" fill="#0B1930" stroke="#3A4C6E" strokeWidth="3" />
      <text className="lbl-strong" x="474" y="348">Stripe</text>
      <text className="lbl" x="474" y="366">eligible, score 0.74</text>

      {/* annotations */}
      <g className="fade f-down">
        <rect x="372" y="118" width="196" height="26" rx="3" fill="#42171a" />
        <text x="384" y="136" fill="#F2867C" fontSize="12.5" fontFamily="IBM Plex Mono, monospace">503 refused, circuit open</text>
      </g>
      <g className="fade f-reroute">
        <text className="lbl" x="244" y="282" textAnchor="middle">Refused before processing,</text>
        <text className="lbl" x="244" y="300" textAnchor="middle">so rerouting is safe</text>
      </g>
      <g className="fade f-ok">
        <rect x="372" y="248" width="170" height="26" rx="3" fill="#0f3324" />
        <text x="384" y="266" fill="#6FD3A0" fontSize="12.5" fontFamily="IBM Plex Mono, monospace">SUCCESSFUL in 412 ms</text>
      </g>
      <g className="fade f-recon">
        <text className="lbl-strong" x="24" y="388">Ledger posted</text>
        <text className="lbl" x="24" y="408">Balanced entries, queued for settlement reconciliation</text>
      </g>
    </svg>
  );
}
