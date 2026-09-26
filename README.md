# Shopify OMS — Automated Order Management System

Automated order dispatch, tracking, returns, refunds, and WhatsApp customer notifications for Shopify stores.

## Architecture

```
Shopify Store
     │
     ├── Webhooks (orders/create, orders/updated, orders/cancelled)
     │         │
     ▼         ▼
  ┌──────────────────────────────────────────────┐
  │            Shopify OMS (Node.js)              │
  │                                                │
  │  ┌──────────┐  ┌───────────┐  ┌────────────┐ │
  │  │ Shopify  │  │ Delhivery │  │ KwiKenage  │ │
  │  │ Service  │  │  Service  │  │  WhatsApp  │ │
  │  │          │  │           │  │  Service   │ │
  │  │ - Fetch  │  │ - Create  │  │ - Send     │ │
  │  │   Orders │  │   Shipment│  │   Template │ │
  │  │ - Refund │  │ - Track   │  │   Messages │ │
  │  │          │  │ - Return  │  │ - Send     │ │
  │  │          │  │ - Cancel  │  │   Text     │ │
  │  └──────────┘  └───────────┘  └────────────┘ │
  │        │              │              │        │
  │        ▼              ▼              ▼        │
  │  ┌─────────────────────────────────────────┐ │
  │  │         PostgreSQL (Prisma ORM)         │ │
  │  │  Orders | Shipments | Returns | Notifs  │ │
  │  └─────────────────────────────────────────┘ │
  │                                                │
  │  ┌─────────────────────────────────────────┐ │
  │  │           Cron Scheduler                 │ │
  │  │  - Order sync (every 15 min)             │ │
  │  │  - Tracking sync (every 30 min)          │ │
  │  │  - Retry failed operations (hourly)      │ │
  │  └─────────────────────────────────────────┘ │
  └──────────────────────────────────────────────┘
```

## Automated Flow

### Order → Dispatch → Delivery
1. New order arrives on Shopify → webhook triggers (or cron polls every 15 min)
2. Order is stored in database with all customer details and line items
3. WhatsApp "Order Confirmed" message sent to customer
4. **Payment verification** — system reads Shopify transactions to detect gateway (GoKwik/PhonePe), verifies payment is captured for prepaid orders (COD auto-passes)
5. System auto-creates shipment on Delhivery → AWB generated (only if payment verified)
6. WhatsApp "Order Shipped" message sent with tracking number
6. Cron job polls Delhivery tracking every 30 min
7. Status transitions: Picked Up → In Transit → Out for Delivery → Delivered
8. WhatsApp notification at each stage
9. If delivery fails → NDR alert sent to customer

### Return → Scan → Refund
1. Return request created (via API or manual)
2. Reverse pickup scheduled with Delhivery
3. WhatsApp "Return Initiated" message sent to customer
4. Returned package arrives at warehouse → **scanned** (via `/api/returns/scan`)
5. QC check (APPROVED / REJECTED / PARTIAL)
6. If QC approved → **refund automatically processed on Shopify**
7. WhatsApp "Refund Processed" message sent to customer
8. Money returned to customer via original payment method

## Setup

### Prerequisites
- Node.js 20+
- PostgreSQL database
- Shopify store with Admin API access
- Delhivery account with API token
- KwiKenage WhatsApp API account

### Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Create database tables
npx prisma db push

# (or use migrations)
npx prisma migrate dev --name init

# Copy environment file and fill in credentials
cp .env.example .env

# Run in development
npm run dev

# Verify Shopify credentials on their own (no database needed)
npm run auth:check
```

On Windows you can double-click **`run.bat`** instead. It checks for Node.js and `.env`, installs dependencies and generates the Prisma client if they're missing, warns if port 3000 is already in use, then starts the dev server and keeps the window open so you can read any error.

### Admin Panel (React frontend)

A separate React admin interface lives in [`frontend/`](frontend/). It talks to this API through a Vite dev-server proxy, so the browser only ever needs `http://localhost:5173`.

```bash
# Terminal 1 - backend API (port 3000)
npm run dev
# or double-click run.bat

# Terminal 2 - admin panel (port 5173)
cd frontend
npm install   # first time only
npm run dev
# or, from the project root, double-click run-frontend.bat
```

Open <http://localhost:5173>. The panel has no login (internal tool, do not expose it publicly). Pages:

- **Dashboard** — order counts, payment summary, recent orders, sync actions
- **Orders** — searchable/filterable order table and order detail pages
- **Returns** — warehouse scan/QC flow and refund processing
- **Tracking** — waybill lookup with status timeline
- **Tools** — Delhivery serviceability, TAT, and shipping-cost utilities

The API must be running on port 3000 for any page to load data; the panel shows a banner when it cannot reach the API.

### Environment Variables

See `.env.example` for all required variables. Shopify needs exactly four: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and `SHOPIFY_API_VERSION`. There is no separate access-token or webhook-secret variable to set. Key variables overall:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SHOPIFY_SHOP_DOMAIN` | Your store's `myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app Client ID (client credentials grant) |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app Client secret (keep private) |
| `SHOPIFY_API_VERSION` | Admin API version, currently `2026-07` |
| `ORDER_SYNC_START_DATE` | Earliest order creation date to import (`YYYY-MM-DD`). Orders older than this are never imported; a fresh database syncs today onward instead of pulling Shopify history. Defaults to start of today. Set once before the first sync. |
| `DELHIVERY_API_TOKEN` | Delhivery API token |
| `DELHIVERY_PICKUP_LOCATION` | Your warehouse/pickup location code in Delhivery |
| `DELHIVERY_AUTO_PICKUP` | Enable only if Delhivery auto-pickup is not already configured; default `false` |
| `DELHIVERY_PICKUP_TIME` | Pickup request time in `HH:mm:ss` format |
| `KWIKENAGE_API_KEY` | KwiKenage WhatsApp API key |
| `KWIKENAGE_SENDER_PHONE` | Your WhatsApp business number |
| `APP_BASE_URL` | Public URL of this service (for webhook registration) |
| `GOKWIK_MERCHANT_ID` | GoKwik merchant ID (reference/configuration value) |
| `GOKWIK_APP_ID` | GoKwik App ID from the Merchant Dashboard (optional, for direct verification) |
| `GOKWIK_APP_SECRET` | GoKwik App Secret from the Merchant Dashboard (optional, keep private) |
| `GOKWIK_API_URL` | GoKwik API base URL |
| `GOKWIK_STATUS_PATH` | GoKwik payment-status path confirmed by your account team |
| `GOKWIK_VERIFY_ENABLED` | Set to `true` only after the status path is confirmed and tested |
| `PHONEPE_MERCHANT_ID` | PhonePe merchant ID (optional, for direct verification) |
| `PHONEPE_SALT_KEY` | PhonePe salt key (optional) |
| `PHONEPE_VERIFY_ENABLED` | Set to `true` to enable direct PhonePe payment verification |

### Payment Gateway Setup

The system reads the payment gateway automatically from Shopify's transaction data. You do **not** need to configure GoKwik or PhonePe APIs for basic functionality — Shopify's `financial_status` and transaction status are sufficient.

For **extra verification** (double-checking that payment was actually captured at the gateway level):

1. **GoKwik**: Set `GOKWIK_APP_ID`, `GOKWIK_APP_SECRET`, `GOKWIK_API_URL`, and the status path supplied by GoKwik. Then set `GOKWIK_VERIFY_ENABLED=true`.
2. **PhonePe**: Set `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, `PHONEPE_SALT_INDEX`, and `PHONEPE_VERIFY_ENABLED=true` in your `.env`

When enabled, the system calls the gateway API directly after checking Shopify's transaction status. If either source says the payment is not captured, the order will not be auto-dispatched. If the GoKwik status path is missing or the API is temporarily unavailable, the system safely falls back to Shopify's transaction status.

### GoKwik integration details

You do **not** need a separate GoKwik connection for the Shopify checkout itself. GoKwik already processes the checkout and Shopify stores the transaction gateway and payment status. This OMS uses that Shopify data for normal payment verification and dispatch gating.

The optional direct GoKwik check requires:

1. Copy the App ID and App Secret from the GoKwik Merchant Dashboard directly into Railway variables or `.env`. Never commit them or paste the secret into chat.
2. Use the App ID/App Secret headers supported by GoKwik: `gk-app-id` and `gk-app-secret`.
3. Ask your GoKwik account manager/POC for the exact payment-status endpoint, request parameter name, response status field, and test order ID. Configure that path as `GOKWIK_STATUS_PATH`, using `{orderId}` as the placeholder, for example `/confirmed/path/{orderId}`.
4. Test one known paid order with `GOKWIK_VERIFY_ENABLED=false` first, then enable it after the endpoint returns a confirmed paid/captured status.

The public GoKwik WooCommerce integration confirms the App ID/App Secret headers and uses `POST /v3/orders/update` for order updates/refunds. It does not establish one universal payment-status endpoint for every GoKwik product, so this project does not hard-code a guessed status URL. Refunds in this OMS continue to use Shopify's refund API, which routes the refund to the original payment method.

### Shopify Setup (Dev Dashboard app — required as of Jan 2026)

Shopify retired creating legacy admin custom apps (the old "Develop apps → create custom app → copy `shpat_` token" flow) on **January 1, 2026**. New integrations use a **Dev Dashboard app** with the client credentials grant: the app exchanges its `Client ID` + `Client secret` for a 24-hour `access_token`, and the OMS refreshes it automatically. Tokens never appear in the Shopify admin.

1. Open the **Dev Dashboard** at `https://dev.shopify.com/dashboard/` and create an app (or open an existing one) for the same organization that owns your store. The client credentials grant only works when the app and the store are under the **same organization**; verify under **Dev stores** in the Dev Dashboard that `youthnic2024.myshopify.com` is listed. If the store was created from the admin rather than the Dev Dashboard, create a dev store from the **Dev stores** page instead.
2. Create/select an app **version** and set these Admin API scopes:
   - `read_orders` — fetch orders, addresses, line items, payment status, and transactions.
   - `write_orders` — create Shopify refunds after return QC passes.
   - `read_all_orders` — only if the first sync must import orders older than 60 days.
3. **Release** the version, then **install** the app on your store and approve the scopes.
4. In the app's **Settings**, copy the **Client ID** and **Client secret**, then set:
   - `SHOPIFY_CLIENT_ID=your-client-id`
   - `SHOPIFY_CLIENT_SECRET=your-client-secret`
   Store them directly in your deployment secret store or `.env`; never paste them into chat.
5. Leave `SHOPIFY_WEBHOOK_SECRET` empty. Shopify generates the webhook `X-Shopify-Hmac-SHA256` signature from your app's **client secret**, and Dev Dashboard apps have no separate webhook secret, so the OMS reuses `SHOPIFY_CLIENT_SECRET` for HMAC verification. Note that rotating the client secret can take up to an hour to apply to webhook signatures.
6. Set `SHOPIFY_SHOP_DOMAIN=youthnic2024.myshopify.com` and `SHOPIFY_API_VERSION=2026-07`. If that value already includes `.myshopify.com`, keep the full domain — the OMS builds the token and API URLs from it.
7. Deploy the OMS to a public HTTPS URL and set that URL as `APP_BASE_URL`.
8. Run `POST /api/setup/webhooks` once. The OMS registers:
   - `orders/create`
   - `orders/paid`
   - `orders/updated`
   - `orders/cancelled`
   - `refunds/create`
9. Run `POST /api/orders/sync` for the first import, then confirm records with `GET /api/orders`.

Verify the credentials before deploying with `npm run auth:check`. It reads `.env`, requests a token, prints the granted scopes, warns about any missing required scope, and reads one order to confirm Admin API access. It needs no database or other OMS variables.

**Legacy static token (optional fallback):** if you still hold an admin-created custom app token (`shpat_`), setting `SHOPIFY_ACCESS_TOKEN` keeps working and takes priority over client credentials. It is no longer possible to create such an app.

The OMS acquires and caches the access token in memory and refreshes it before the 24-hour expiry, so background jobs and webhooks never hit a 401. If you see `Oauth error shop_not_permitted`, the app and store are not in the same Shopify organization — move the store into the org, or create a Dev Dashboard dev store and install the app there.

### Shopify payment and refund flow

- **Orders:** The sync and webhooks store the order, customer address, line items, financial status, and fulfillment status. Each order also records its sales channel (`salesChannel`), resolved from Shopify's `source_name`/app id — e.g. `Online Store` for the website or `Youthnic <> Gokwik` for the GoKwik checkout — so Gokwik-sourced orders can be told apart from storefront ones.
- **History cut-off:** `ORDER_SYNC_START_DATE` is a hard floor. Orders created before it are never imported by the sync or accepted from webhooks; orders already in the database keep receiving updates regardless of age.
- **Payments:** Before Delhivery dispatch, the OMS calls Shopify's order transaction API. A prepaid order dispatches only when its sale/capture transaction has a successful status. COD does not require prepayment verification.
- **Gateway detection:** Shopify's transaction gateway identifies GoKwik, PhonePe, and other payment providers. Direct GoKwik/PhonePe verification remains optional; Shopify is the default source of truth.
- **Refunds:** A warehouse QC approval starts the refund flow. The OMS asks Shopify to calculate the refund first, then creates it against the original successful payment transaction. Shopify routes funds through the original gateway. The `refunds/create` webhook records the external confirmation.

### Delhivery Setup

1. Get your API token from the Delhivery ONE Panel (or from your account POC)
2. Set `DELHIVERY_API_TOKEN` in your `.env`
3. Set `DELHIVERY_PICKUP_LOCATION` to the exact registered warehouse/pickup-location name (case-sensitive, including spaces). Do not use the client profile names shown in the dashboard such as `Domestic`, `B2B Surface`, or `Local`.
4. Fill in seller/warehouse address fields (`DELHIVERY_SELLER_*`)
5. Set `DELHIVERY_SHIPPING_MODE` to `Surface` or `Express` as needed
6. Set `DELHIVERY_LABEL_SIZE` to `4R` (4x6 inch) or `A4` as needed
7. Keep `DELHIVERY_AUTO_PICKUP=false` unless your warehouse needs API-created pickup requests. Pickup requests are warehouse-level and Delhivery may reject a second request for the same warehouse/day until the first is closed.
8. **For staging/testing**: Set `DELHIVERY_BASE_URL=https://staging-express.delhivery.com`
8. **Optional — Webhooks for real-time tracking**: Instead of polling the tracking API every 30 min, you can set up Delhivery webhooks for instant status updates. Email `lastmile-integration@delhivery.com` with your endpoint URL (`https://your-app-url/webhooks/delhivery`) and your account name. They will configure the scan push webhook for you.

### KwiKenage Templates

Create these WhatsApp template messages in your KwiKenage dashboard (must be Meta-approved):
- `order_confirmed` — params: [customer_name, order_number]
- `order_shipped` — params: [customer_name, order_number, tracking_number]
- `out_for_delivery` — params: [customer_name, order_number]
- `order_delivered` — params: [customer_name, order_number]
- `return_initiated` — params: [customer_name, order_number, return_reason]
- `refund_processed` — params: [customer_name, order_number, refund_amount]
- `ndr_attempt` — params: [customer_name, order_number, message]

## API Endpoints

### Health
- `GET /api/health` — Service health check

### Orders
- `GET /api/orders` — List all orders (optional: `?status=NEW`)
- `GET /api/orders/:id` — Get single order with full details
- `POST /api/orders/:id/dispatch` — Manually dispatch an order to Delhivery (verifies payment first)
- `POST /api/orders/sync` — Manually trigger Shopify order sync

### Payments
- `GET /api/orders/:id/payment` — Get payment details for an order (gateway, status, verified)
- `POST /api/orders/:id/payment/verify` — Manually verify payment for an order
- `GET /api/payments/summary` — Dashboard summary of orders by payment gateway + unverified count

### COD reconciliation
Delhivery does not expose remittances through its API (they live in the panel under **Finances > Remittance**), so the OMS keeps its own ledger: a delivered COD shipment is automatically marked "collected", and you record remittances from the panel report.
- `GET /api/cod/summary` — Collected vs remitted totals plus the outstanding list (waybill, order, customer, amount, collection date)
- `POST /api/cod/remittance` — Record a remittance from the panel report
  ```json
  { "remittanceRef": "RMT12345", "remittedAt": "2026-09-24", "waybills": ["1234567890", "1234567891"] }
  ```

### Returns
- `GET /api/returns` — List all returns (optional: `?status=INITIATED`)
- `POST /api/orders/:id/returns` — Create a return request
  ```json
  {
    "returnReason": "Size too small",
    "items": [
      { "orderItemId": 1, "quantity": 1 }
    ]
  }
  ```
- `POST /api/returns/scan` — **Scan returned package at warehouse** (triggers QC + auto-refund)
  ```json
  {
    "waybillNumber": "DEL1234567890",
    "qcStatus": "APPROVED",
    "qcRemark": "Item in good condition"
  }
  ```
- `POST /api/returns/:id/refund` — Manually process refund for a return

### Tracking
- `GET /api/tracking/:waybill` — Track a shipment by waybill number
- `POST /api/tracking/sync` — Manually trigger tracking sync for all shipments

### Setup
- `POST /api/setup/webhooks` — Register Shopify webhooks

### Tracking
- `GET /api/tracking/:waybill` — Track a shipment by waybill number
- `POST /api/tracking/sync` — Manually trigger tracking sync for all shipments

### Delhivery
- `GET /api/delhivery/serviceability/:pincode` — Check if a pincode is serviceable
- `GET /api/delhivery/tat?origin=400001&destination=110001&mot=S` — Get expected delivery TAT (days)
- `GET /api/delhivery/label/:waybill` — Generate/download shipping label PDF
- `PATCH /api/delhivery/shipment/:waybill` — Update supported shipment fields (`name`, `phone`, `paymentMode`, `codAmount`, `address`, dimensions)
- `PUT /api/delhivery/shipment/:waybill/ewaybill` — Attach an e-way bill using `invoiceNumber` and `ewaybillNumber`
- `GET /api/delhivery/shipping-cost` — Calculate approximate shipping cost
- `POST /api/delhivery/shipment/:waybill/cancel` — Cancel a shipment when its status allows cancellation
- `GET /api/delhivery/document/:waybill?type=EPOD` — Download documents (EPOD, SIGNATURE_URL, RVP_QC_IMAGE, SELLER_RETURN_IMAGE)
- `POST /api/delhivery/ndr` — Take NDR action (RE-ATTEMPT or PICKUP_RESCHEDULE)
  ```json
  { "waybill": "1234567890", "action": "RE-ATTEMPT" }
  ```
- `POST /api/delhivery/waybills/fetch` — Pre-fetch waybills in bulk
  ```json
  { "count": 100 }
  ```

### Webhooks
- `POST /webhooks/shopify` — Shopify webhook receiver (orders/create, orders/updated, orders/cancelled, refunds/create)
- `POST /webhooks/delhivery` — Delhivery scan push webhook (real-time shipment status updates)

## Deployment on Railway

1. Push this code to a Git repository
2. Connect the repo to Railway
3. Add a PostgreSQL database service in Railway
4. Set all environment variables from `.env.example` in Railway's variables tab
5. Railway will build using the Dockerfile and deploy automatically
6. Once deployed, set `APP_BASE_URL` to your Railway public URL
7. Call `POST /api/setup/webhooks` to register Shopify webhooks

```bash
# Deploy from CLI (optional)
railway up
```

## Project Structure

```
src/
├── index.ts                    # Entry point
├── app.ts                      # Express app setup
├── config/
│   └── index.ts                # Environment config
├── database/
│   └── prisma.ts               # Prisma client
├── modules/
│   ├── shopify/
│   │   └── shopify.service.ts  # Shopify API (orders, refunds, webhooks)
│   ├── delhivery/
│   │   └── delhivery.service.ts # Delhivery B2C API (serviceability, TAT, waybill, shipments, tracking, label, pickup, cancel, NDR, documents, RVP QC)
│   ├── whatsapp/
│   │   └── whatsapp.service.ts  # KwiKenage WhatsApp API
│   ├── payments/
│   │   ├── payment.service.ts   # Gateway detection + verification orchestration
│   │   ├── gokwik.service.ts    # GoKwik API (payment verify, refund)
│   │   └── phonepe.service.ts   # PhonePe API (payment verify, refund)
│   ├── orders/
│   │   └── order.service.ts     # Order lifecycle orchestration
│   ├── returns/
│   │   └── return.service.ts    # Return + refund automation
│   ├── tracking/
│   │   └── tracking.service.ts  # Delhivery tracking sync
│   └── notifications/
│       └── notification.service.ts # WhatsApp notification triggers
├── jobs/
│   └── scheduler.ts             # Cron jobs
├── routes/
│   ├── api.ts                   # REST API routes
│   ├── webhooks.ts              # Shopify webhook handler
│   └── delhivery-webhooks.ts    # Delhivery scan push webhook handler
│   └── webhooks.ts              # Shopify webhook handler
├── types/
│   └── index.ts                 # Shared types
└── utils/
    └── logger.ts                # Winston logger
prisma/
├── schema.prisma                # Database schema
└── seed.ts                      # Seed data
```

## Notes

- **Delhivery API**: All endpoints are built from the official B2C developer portal docs (https://one.delhivery.com/developer-portal/documents/b2c/). All production APIs use base URL `https://track.delhivery.com`. For staging/testing, set `DELHIVERY_BASE_URL=https://staging-express.delhivery.com`. Key implementation details:
  - Shipment creation body is URL-encoded (`format=json&data={JSON_STRING}`), not JSON
  - Pincode serviceability is checked before creating any shipment
  - Serviceability failures no longer allow a shipment to bypass the check
  - Shipping labels are generated via `/api/p/packing_slip` with PDF output
  - Shipment updates and cancellation both use `POST /api/p/edit`, but only in Delhivery's allowed package statuses
  - E-way bills for shipments above the applicable value threshold use `PUT /api/rest/ewaybill/{waybill}/`
  - Shipping-cost responses are estimates from `/api/kinko/v1/invoice/charges/.json`
  - Pickup requests use `POST /fm/request/new/` with JSON body
  - NDR actions (RE-ATTEMPT, PICKUP_RESCHEDULE) use `POST /api/p/update`
  - RVP QC requires one-time question mapping by Delhivery's BD team; the integration supports up to 2 QC items and 6 questions per item
  - Delhivery webhooks can be configured via email to lastmile-integration@delhivery.com for real-time status pushes (eliminates polling)
- **KwiKenage API**: The API endpoint paths (`/send-template`, `/send-message`) may need adjustment based on your KwiKenage API version. Check KwiKenage's API docs for the exact format.
- **WhatsApp Templates**: All template messages must be pre-approved by Meta through the KwiKenage dashboard before they can be sent.
- **Payment Gateways**: GoKwik and PhonePe are detected automatically from Shopify's transaction gateway field. Shopify transaction status is the default source of truth. Direct GoKwik verification is optional and requires a GoKwik-confirmed status path; the service uses `gk-app-id` / `gk-app-secret` headers and never logs credential values.
- **Shopify Refunds**: The refund is processed through Shopify's refund API, which handles returning money via the original payment gateway (GoKwik, PhonePe, etc.).
