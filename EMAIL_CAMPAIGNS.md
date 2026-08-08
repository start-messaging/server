# Email campaigns — setup

Outbound outreach from the admin panel: compose, send to a segment or a pasted
list, and see who opened and clicked.

Open, click and unsubscribe tracking are served by **this** application, not by
the mail provider. That is deliberate — it means the transport can be a free
SMTP relay that reports nothing back, and the engagement history stays in this
database rather than in a vendor's.

---

## 1. Pick a transport

`CAMPAIGN_TRANSPORT` selects it. The default is `console`, which logs messages
instead of sending them — a developer running this against a copy of production
data should not be one click away from cold-emailing every real customer.

| Value | Use it when |
|---|---|
| `console` | Local development. Logs the rendered email; sends nothing. |
| `brevo` | **Recommended.** 300 emails/day on a permanently free plan, no card. |
| `smtp` | Any relay: Brevo, Zoho, Mailjet, SES, or a Google Workspace mailbox. |
| `mailgun` | Reuses the existing transactional credentials. **See the warning below.** |

### Why Brevo

It is the highest permanent free volume of any provider with a real sending
API — Mailjet gives 200/day, Resend 100/day, and SendGrid no longer has a free
tier at all. It is also corporately unrelated to Mailgun, which matters more
than the volume; see below.

Two things to expect: free-plan mail carries a "Sent with Brevo" footer, and
SMTP access is not self-serve — you verify your domain and then ask their
support to switch it on. The `brevo` transport uses their HTTP API instead and
avoids that wait.

### ⚠️ Do not point this at Mailgun

Mailgun's acceptable use policy — which also covers Mailjet, the same company —
allows suspension "even if a breach is committed unintentionally", and the
suspension is account-level. That is the same account delivering your OTP and
KYC mail, and there is no service credit for the resulting outage.

Cold outreach draws complaints. Keep it on a different provider, a different
account, and a different domain. Mailgun should keep doing exactly one job.

---

## 2. Register a separate domain

Not a subdomain. A subdomain shares the DMARC organizational domain and rolls
up into Gmail's bulk-sender count for your primary domain; a separate
registrable domain shares neither.

Then **let it age about 30 days before the first send** — most spam filters
flag newly-registered domains regardless of what they send. Put a real site
with contact details on it in the meantime.

On that domain, publish:

- **SPF** and **DKIM** (2048-bit key)
- **DMARC** at `p=none` — sufficient for Gmail and Yahoo
- A `From:` header aligned with the SPF or DKIM domain

---

## 3. Environment

```bash
# Transport
CAMPAIGN_TRANSPORT=brevo            # console | smtp | brevo | mailgun
CAMPAIGN_FROM_EMAIL=hello@your-outreach-domain.com
CAMPAIGN_FROM_NAME=StartMessaging
CAMPAIGN_REPLY_TO=you@your-company.com   # outreach gets answered

# Tracking — pixel, click redirect and unsubscribe links point here, so it
# must be publicly reachable by a recipient's mail client.
CAMPAIGN_TRACKING_BASE_URL=https://api.startmessaging.com
CAMPAIGN_TRACKING_SECRET=<64 random hex chars>

# Required in the footer of commercial email, and a trust signal for filters.
CAMPAIGN_COMPANY_ADDRESS="Your registered office, City 560001"

# Volume. Defaults are warmup-shaped on purpose — see below.
CAMPAIGN_DAILY_SEND_CAP=50
CAMPAIGN_SEND_RATE_PER_MINUTE=12

# Transport-specific
CAMPAIGN_BREVO_API_KEY=xkeysib-...

# …or, for CAMPAIGN_TRANSPORT=smtp
CAMPAIGN_SMTP_HOST=smtp-relay.brevo.com
CAMPAIGN_SMTP_PORT=587
CAMPAIGN_SMTP_USER=...
CAMPAIGN_SMTP_PASS=...
CAMPAIGN_SMTP_SECURE=false          # true only for port 465
```

Generate the tracking secret with `openssl rand -hex 32`. It signs unsubscribe
links, so it is kept separate from `JWT_SECRET`: a leaked tracking URL must
never be escalatable into a session, and rotating this must not log anyone out.

Boot refuses if a real transport is selected without the credentials it needs.
An environment that never runs a campaign needs none of these set.

---

## 4. Migrate

```bash
npm run migration:run
```

Creates `email_campaigns`, `email_campaign_recipients`, `email_events` and
`email_suppressions`.

---

## 5. Warm the domain up

`CAMPAIGN_DAILY_SEND_CAP` defaults to **50**, well below Brevo's 300. That is
the intended order — the cap that binds first should be yours, not the
provider's. A new domain that opens at a few hundred a day gets filtered, and
that reputation damage is not something a later apology fixes.

Roughly:

| Week | Per day | Send to |
|---|---|---|
| 1 | 10–20 | Your warmest existing customers only |
| 2 | 30–50 | |
| 3–4 | 75–150 | |
| Then | Ramp ~50%/week to target | |

Raise the cap deliberately as you go. Once warm, do not go 30+ days without
sending — most reputation systems keep only 30 days of history.

**Your complaint budget is effectively zero.** Gmail's ceiling is 0.1%,
measured against *inbox placements* rather than sends. On a 1,000-address
campaign with maybe 300 Gmail inboxes, one complaint is already 0.33%.

---

## 6. What the numbers mean

**Trust clicks. Do not trust opens.**

Apple Mail Privacy Protection pre-loads the tracking pixel whether or not a
human ever opens the message, and it touches 55–60% of all opens; the one
credible measurement puts the inflation at +14–18 percentage points. Clients
that block images undercount in the other direction. The analytics screen
therefore leads with clicks and shows the open rate in a muted tile with a
footnote — that ordering is load-bearing, not decoration.

Ranked by how much they can be relied on: unsubscribes (never auto-triggered —
the RFC forbids a POST without user action), then bounces and complaints, then
clicks, then opens.

---

## Known limitations

- **Bounces are not ingested on the `smtp` transport.** A relay accepts the
  message and reports failures later as an asynchronous delivery-status
  notification to the return-path mailbox. Capturing those needs a VERP
  return-path and an inbox to read them from, which is not built. The `brevo`
  and `mailgun` transports surface hard rejections synchronously, so those are
  recorded. Recipients who unsubscribe are always captured, on every transport.
- **Replies are not tracked.** Set `CAMPAIGN_REPLY_TO` to a mailbox a human
  reads.
- **Images are inserted by URL**, not uploaded. They must be publicly reachable.
- **Scheduling** is stored and honoured by the queue, but there is no UI for
  picking a time yet — `scheduledAt` has to be set through the API.
