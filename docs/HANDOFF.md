# Shopify OMS — Agent Handoff

Last verified: 2026-09-24. Read this before changing anything.

## What this project is

Automated Order Management System for the Shopify store **youthnic2024.myshopify.com** (brand: Youthnic).

- **Backend**: Node.js + Express + TypeScript + Prisma + PostgreSQL, in `src/`
- **Admin panel**: React + Vite + TypeScript + Tailwind v4, in `frontend/` (separate app, port 5173, proxies `/api` to the backend)
- **Integrations**: Shopify (orders, refunds, webhooks), Delhivery (dispatch, tracking, labels, NDR, returns), KwiKenage (WhatsApp notifications), GoKwik/PhonePe (payment gateway *detection* via Shopify transactions — no direct keys needed)

## Running locally

```bash
# Backend (port 3000) — from project root
run.bat                  # or: npm run dev

# Admin panel (port 5173) — from project root
run-frontend.bat         # or: cd frontend && npm run dev
```

Both were running and healthy on 2026-09-24. Panel at http://localhost:5173 (no login — internal tool, never expose publicly).

## Infrastructure

- **Database**: Hostinger VPS `1845788`, IP `200.141.1.119`, Postgres 17 in Docker project `postgresql-6k6a`, host port `5433`, database `shopify`, user `pawanshukla`. All tables exist (ran `npx prisma db push`). Another unrelated `app` deployment uses `packing_database` on the same VPS — do not touch it.
- **Delhivery warehouse**: `Surat Warehouse` (facility `INGJBABS`), 7004 Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat, Gujarat 395002, phone +917984984563. Working 10:00–18:00, preferred pickup 14:00–18:00, auto_pickup OFF. Second location `Vb Export` (10:00–14:00 slot).
- **Shopify app**: Dev Dashboard app, client credentials grant (legacy custom apps were retired 2026-01-01). Client ID `104ac4bacb84134fec137548b8fd6e1c`. Tokens are acquired/cached/refreshed automatically by `src/modules/shopify/token.provider.ts`. Webhook HMAC is verified with the client secret (Dev Dashboard apps have no separate webhook secret).

## .env status

Set and working: `PORT`, `NODE_ENV`, `APP_BASE_URL`, `DATABASE_URL`, all four `SHOPIFY_*`, all `DELHIVERY_SELLER_*`, `DELHIVERY_PICKUP_LOCATION`, `DELHIVERY_SHIPPING_MODE`, `DELHIVERY_LABEL_SIZE`, `DELHIVERY_AUTO_PICKUP=false`, `DELHIVERY_PICKUP_TIME=14:00:00`.

**Still empty (blockers)**: `DELHIVERY_API_TOKEN`, `KWIKENAGE_API_KEY`, `KWIKENAGE_SENDER_PHONE`.

`ORDER_SYNC_START_DATE=2026-09-24` is pinned — orders created before this date are never imported (user requirement: today onward only). Moving it forward later would block updates for orders not yet in the DB; leave it alone.

## Data state

- 7 orders in DB, all created 2026-09-24: 5 morning orders (#26YOU5747–5751) + 2 draft orders (#26YOU5752, #26YOU5753).
- Every order carries `salesChannel`: `Youthnic <> Gokwik` (app id 249596116993), `Online Store` (source `web`), or `Draft Order` (source `shopify_draft_order`).
- 489 historical orders were intentionally deleted (`scripts/purge-historical-orders.ts`). They remain in Shopify and can be re-imported by moving `ORDER_SYNC_START_DATE` back.
- No shipments exist yet (Delhivery token not set). COD ledger therefore shows zeros — expected.

## Critical behaviors (recently fixed — do not regress)

1. **Dispatch gate** (`src/modules/payments/payment.service.ts`): orders with Shopify financial status `voided` or `refunded`, or internal status `CANCELLED`, can never dispatch — checked before trusting the stored `paymentVerified` flag. `partially_refunded` still ships (deliberate). `blockedDispatchReason()` is the exported pure function; `scripts/verify-dispatch-gate.ts` proves it against live data (36 orders blocked, all of which the old gate would have shipped).
2. **Fulfilled guard** (`src/modules/orders/order.service.ts`): orders already `fulfilled` on Shopify are skipped by auto-dispatch and rejected by manual dispatch (prevents re-shipping after historical imports).
3. **Gateway detection** prefers a *successful* sale/capture transaction over the first one — customers who fail a UPI attempt then retry or fall back to COD must verify correctly (4 PhonePe orders were stuck unverified before this fix).
4. **Sync floor**: `syncOrdersFromShopify` and `syncOrderFromWebhook` both enforce `ORDER_SYNC_START_DATE`; `shopifyService.syncOrderToDb` deliberately does NOT enforce it (callers own the policy — the backfill script guards itself).
5. **`src/index.ts` uses side-effect imports only** (`import './app'`). TypeScript elides unused imports — a normal `import app from './app'` compiles the server away and the process exits silently with code 0. Never "clean this up".
6. **Delhivery/KwiKenage tokens are optional at boot**; axios interceptors throw clear errors at point of use. `CRON_ENABLED=false` disables the scheduler for local testing.

## API surface highlights

- `POST /api/orders/sync` — sync Shopify orders, then auto-dispatch NEW ones
- `POST /api/orders/:id/dispatch`, `GET /api/orders/:id/payment`, `POST /api/orders/:id/payment/verify`
- `GET /api/payments/summary`
- `GET /api/cod/summary` + `POST /api/cod/remittance` — COD reconciliation ledger (see below)
- `POST /api/returns/scan` — warehouse QC scan → auto-refund on approval
- `GET /api/delhivery/serviceability/:pincode`, `/tat`, `/label/:waybill`, `/shipping-cost`, shipment edit/cancel, NDR actions
- `POST /api/setup/webhooks` — register Shopify webhooks (needs public `APP_BASE_URL`)
- Webhooks: `POST /webhooks/shopify` (orders/create, orders/paid, orders/updated, orders/cancelled, refunds/create), `POST /webhooks/delhivery`

## COD remittances — important finding

**Delhivery has no API for COD remittances.** Verified against the full Express/B2C API index and help docs: remittances exist only in the panel (Main Menu > Finances > Remittance). The OMS therefore keeps its own ledger: delivery auto-marks COD as collected (`tracking.service.ts`), and remittances are recorded from the panel report via `POST /api/cod/remittance` or the Tools > COD reconciliation panel. Delhivery processes remittances within ~48h of delivery and only while the wallet balance is positive (current balance: ₹12.93 via the MCP wallet tool).

## Scripts (all run with npx tsx, no server needed)

| Command | Purpose |
|---|---|
| `npm run auth:check` | Verify Shopify client credentials, scopes, one order read |
| `npm run order:fetch -- 26YOU5750` | Fetch one order by name/id with dispatch verdict |
| `npx tsx scripts/verify-dispatch-gate.ts` | Prove the dispatch gate on live voided/refunded orders |
| `npx tsx scripts/gateway-survey.ts` | Tally gateway strings across recent orders |
| `npx tsx scripts/purge-historical-orders.ts` | Delete orders created before go-live (done 2026-09-24) |
| `npx tsx scripts/backfill-order-channel.ts` | Re-sync existing DB orders to fill newly added fields |

## Outstanding tasks (in priority order)

1. **Set `DELHIVERY_API_TOKEN`** in `.env` (Delhivery ONE panel). Until then nothing dispatches — by design.
2. **Set KwiKenage keys** (`KWIKENAGE_API_KEY`, `KWIKENAGE_SENDER_PHONE`) for WhatsApp notifications.
3. **Rotate exposed secrets** — during earlier sessions these were pasted into chat and must be considered compromised: Shopify client secret, DB password, Hostinger API token, Delhivery MCP secret.
4. **Deploy** (Railway config + Dockerfile exist): set env vars, set `APP_BASE_URL` to the public HTTPS URL, run `POST /api/setup/webhooks`, then live-test order sync → dispatch → tracking → a safe test refund.
5. **Trim Shopify scopes** from 22 down to `read_orders` + `write_orders` (add `read_all_orders` only if orders older than 60 days are ever needed — currently not, per the today-onward policy).
6. Optional: email `lastmile-integration@delhivery.com` to enable Delhivery scan-push webhooks (removes the 30-min polling delay).

## Quick verification

```bash
npm run auth:check                                   # Shopify credentials OK
curl http://localhost:3000/api/health                # backend up
curl http://localhost:3000/api/orders                # 7 orders with salesChannel
curl http://localhost:3000/api/cod/summary           # COD ledger
curl -X POST http://localhost:3000/api/orders/sync   # incremental, ~3s, 0 new
npx tsc --noEmit                                     # backend types
cd frontend && npx tsc --noEmit && npm run build     # frontend types + build
```

## Notes for the next agent

- Windows 10, PowerShell 5.1: no `&&`/`||` (use `;` and `$LASTEXITCODE`), here-strings need real newlines, and `agent-browser` refs like `@e8` must be quoted.
- The project is NOT a git repository yet — there is no version control safety net. Consider `git init` before risky changes.
- Vite dev server occasionally serves stale module transforms; if UI changes don't appear, restart it (`run-frontend.bat`).
- `prisma db push` regenerates the client and fails with EPERM while the backend dev server is running (DLL locked) — stop the server first, push, restart.
- Prisma logs every query to stdout in dev (`prisma:query ...`) — noisy but harmless.
