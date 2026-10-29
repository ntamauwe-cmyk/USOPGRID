# USOPGRID Operations Runbook

Operations console: Dashboard → Operations console (platform admins only).

## Health signals

| Signal | Healthy | Where |
|---|---|---|
| Encryption key | loaded | System health |
| FX rates | < 36 h old | System health |
| Recovery queue | 0 overdue | System health / Recovery queue |
| Webhook dispatcher | nothing pending > 5 min | System health |
| Circuits | all closed | System health / Providers |
| Rejected provider events | ~0 | Provider events (filter: rejected) |
| Provider anomaly alerts | none | Alerts & audit |

## Playbooks

**Provider outage (circuit opened alert).** Traffic already fails over
automatically. Confirm on the provider's status page. Do not reset the circuit
manually unless the provider confirms recovery; the breaker probes on its own
(30 s cooldown, doubling to 5 min). Watch success rate recover in Health.

**Payments stuck in PENDING with `outcome_unknown`.** Normal after provider
timeouts. Recovery polls the same provider on schedule (15 s → 12 h). Use
**Check now** to expedite. At 72 h the job escalates to a reconciliation
exception; finance verifies at the provider and resolves.

**Late success on a failed/expired payment** (`late_provider_success`
exception). Money may have moved. Finance checks the provider: either refund
the customer through the provider dashboard or reinstate, and record the
resolution note.

**Payout stuck in PROCESSING.** The provider has not confirmed yet. The
recovery job asks the same provider every few minutes with growing gaps (never
re-sends money). Provider webhooks are re-confirmed by lookup before anything is
booked. After 72 h it raises a high-severity reconciliation exception and a
critical notification: check the transfer in the provider dashboard before
releasing funds or paying again.

**Key rotation / suspected key exposure.** Operations → Encryption keys. Add a
new key, switch the active id, re-encrypt, remove the old key (Security doc).
If a key may be exposed, also rotate every provider credential at the provider.

**Webhook endpoint failing.** Deliveries retry six times over ~9 h then
dead-letter. After the merchant fixes the endpoint, replay from Dead letters.

**Rejected inbound provider events.** Usually a wrong webhook secret on the
connection or a misconfigured URL. Re-enter credentials for that connection.
Repeated rejections from unknown sources: block at the WAF.

**Suspected compromised API key.** Merchant revokes it (Developers). For
urgent cases, operators can suspend the organization (Organizations tab; reason
required, audited); suspension blocks new payments immediately.

**FX stale.** Check source errors in Convex logs (`[fx]`), configure a premium
source (`FX_RATE_PROVIDER_URL/KEY`). Quotes are refused while rates are stale
(fail closed), payments in the same currency are unaffected.

## Reconciliation routine (finance)

Daily: export each provider's settlement report → Reconciliation → Upload.
Resolve every exception with a note; acknowledged exceptions remain visible.
Monthly: confirm ledger balances (Settlements) against bank statements.

## Alerting

Critical events create notifications (platform-level and per org): circuit
opened, anomaly detected, reconciliation exception, compliance stop, enterprise
lead. Forward them to paging (PagerDuty/Opsgenie/Slack) by adding a sink in
`connections.notify` — the single choke point for all notifications.

## Backups and recovery

Enable Convex daily backups; keep 30 days. Quarterly restore test into a
staging deployment. The encryption key must be backed up separately; without it
sealed credentials and MFA secrets cannot be recovered.
