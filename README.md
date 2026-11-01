# Dunedin Euchre

Dunedin Euchre sends all application email through SMTP2GO. The application has no provider selector and does not use Resend to send or check current delivery status. Existing email templates, sender addresses, invitation and reminder selection, and the SQLite scheduling workers remain in place.

Historical Resend delivery records for completed tournaments are intentionally not imported; they are not needed to operate the application. The migration preserves participant, RSVP, event, and scheduling data in SQLite. Keep the Dunedin Euchre domain available in Resend during this deployment for rollback. Removing it is a separate change.

## Email configuration

Set these values in the protected application environment:

| Variable | Purpose |
| --- | --- |
| `SMTP2GO_API_KEY` | Dedicated Dunedin Euchre SMTP2GO key, stored at `op://Infrastructure/dunedin-euchre-smtp2go/credential`. |
| `SMTP2GO_API_BASE_URL` | Optional API base; defaults to `https://api.smtp2go.com/v3`. |
| `SMTP2GO_MAX_RETRIES` | Retry count for explicit `429` rate-limit responses; defaults to `3`. |
| `SMTP2GO_RETRY_DELAY_MS` | Base rate-limit delay; defaults to `1000` ms. |
| `SMTP2GO_REQUEST_TIMEOUT_MS` | API request deadline; defaults to `15000` ms. |
| `SMTP2GO_INVITE_SENDS_PER_SECOND` | Invitation pacing; defaults to `4`. |
| `FROM_EMAIL` | Existing administrator and summary sender. |
| `ROSTER_FROM_EMAIL` | Existing invitation and reminder sender. |

Retrieve the dedicated SMTP2GO key through the authenticated 1Password CLI. Keep shell tracing disabled and do not put the key in source control, logs, or documentation:

```sh
SMTP2GO_API_KEY="$(op read 'op://Infrastructure/dunedin-euchre-smtp2go/credential')" node server.js
```

The production API key must allow only `/email/send` and `/activity/search`. Set `open_tracking_enabled` and `click_tracking_enabled` to `false`. The send request also omits per-message open and click tracking fields. Key-level tracking must stay disabled because administrator sign-in emails contain magic links, and SMTP2GO's send API has no per-message tracking override.

## Delivery records and tracking

Every tracked application send is first recorded in SQLite `email_delivery_history`. SMTP2GO message IDs and the latest activity event are stored with purpose, recipient, and invitation event/participant identity. Invitation requests also include a unique `X-Dunedin-Delivery-ID` header so activity can be reconciled after an ambiguous response. Activity lookup uses SMTP2GO `POST /activity/search`; the existing invitation page reads its durable SQLite records and refreshes SMTP2GO statuses when available.

SMTP2GO does not accept an idempotency key. The adapter retries only an explicit `429` rate-limit response, which confirms the request was rejected. Timeouts, transport failures, server errors, and incomplete successful responses are marked ambiguous and are not automatically retried. Check SMTP2GO activity and the matching SQLite delivery key before manually repeating an ambiguous send.

The new delivery-history table records SMTP2GO sends made after the cutover. Completed-tournament Resend records are intentionally excluded, and the application has no historical Resend importer. No Resend history credential is needed for this deployment.

## Scheduled email

Invitation delivery tracking and reminder recipient selection use the per-participant SQLite history. The existing reminder and RSVP-summary workers continue to calculate their scheduled times with the configured IANA time zones (`EVENT_REMINDER_TIMEZONE` and `EVENT_RSVP_SUMMARY_TIMEZONE`) and send when due. SMTP2GO's provider-side schedule is limited to three days and is intentionally not used.

The legacy `schedule:reminder` command now prints a dry run by default and queues approved reminders in SQLite with `--confirm`. Its recipient rule remains: include participants with a recorded invitation message ID and exclude delivery issues unless `--include-issue` is supplied. Use `--scheduled-at` for the requested UTC/offset-aware time; application workers handle long scheduling horizons.

## Local verification

Run the application test suite with `npm test`. Tests stub provider calls and do not send real email.
