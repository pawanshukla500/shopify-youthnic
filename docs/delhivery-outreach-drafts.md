# Delhivery Outreach Drafts (ready to send)

> Account values below are taken from your Delhivery One panel screenshots
> (Company Details + Pickup Locations + client-profile switcher, 2026-09-28).
> Before sending Mail 1: generate any random 24+ character string, put it in
> `.env` as `DELHIVERY_WEBHOOK_SECRET=<secret>`, redeploy, then replace
> `[SET A SECRET]` in the mail with the same value.
>
> ⚠️ Email mismatch spotted: Company Details page shows
> `returnorders@vbexports.co.in` but the Pickup Location modal shows
> `returnorders@vbexport.co.in` (no "s"). Drafts use the `vbexports` version
> (matches our app login). Please confirm which one Delhivery has on record.

**Keys / identifiers Delhivery needs (all in one place):**

| Key | Value |
|---|---|
| Client profile in use | **Domestic** (`fa5d92-VBEXPORT-do`) — B2C surface, ~100 pkgs/month |
| Company | V B EXPORT, GST `24AERPB8666E1ZB` |
| Pickup location (exact, case-sensitive) | `Surat Warehouse` (Active) |
| Pickup address | 7004, Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat, Gujarat — 395002 |
| Contact person | Pawan Shukla (Admin) — +91 7984984563 — returnorders@vbexports.co.in |
| Our webhook URL | `https://shopify.youthnic.shop/webhooks/delhivery` |
| Webhook secret | `[SET A SECRET]` (see note on top) |
| Test AWB | `30100810010054` (live Manifested shipment) |

---

## Mail 1 — Scan-Push webhook enablement (COPY-PASTE READY)

**To:** lastmile-integration@delhivery.com
**Cc:** (your Delhivery business SPOC)
**Subject:** Request to enable Scan-Push webhook — Domestic fa5d92-VBEXPORT-do / Surat Warehouse

```
Hello Delhivery Integration Team,

Please enable real-time Scan-Push (shipment status updates) for our account
with the details below. We use the Domestic profile for all B2C shipments.

  Client profile : Domestic (fa5d92-VBEXPORT-do)
  Company        : V B EXPORT (GST: 24AERPB8666E1ZB)
  Pickup location: Surat Warehouse (Active)
  Pickup address : 7004, Hi-tech Textile Centre (HTC Market - 1),
                   Anjana Farm, Near Raghukul Market,
                   Surat, Gujarat — 395002
  Webhook URL    : https://shopify.youthnic.shop/webhooks/delhivery
  Method         : POST with JSON body

Events needed: all forward scans (UD: Manifested / Not Picked / In Transit /
Pending / Dispatched, DL: Delivered) and return scans (RT: In Transit /
Pending / Dispatched, DL: RTO).

Payload formats our endpoint accepts (either is fine):
  1. Official nested: { Shipment: { AWB, ReferenceNo, Sortcode, NSLCode,
     PickUpDate, Status: { Status, StatusDateTime, StatusType, StatusLocation,
     Instructions } } }
  2. Legacy flat: { waybill, status, status_type, location, scan_datetime }

Our endpoint always responds within seconds with:
  200 { "received": true }
so no retries are needed on your side.

Authentication: our endpoint accepts a shared secret via `?secret=` query
param or `x-delhivery-secret` header. Our secret is:

  Secret: [SET A SECRET]

Please confirm once Scan-Push is live. You can verify delivery with our test
AWB 30100810010054 (currently Manifested at Surat_Dabholi_C).

Integration contact:
  Pawan Shukla (Admin) — +91 7984984563 — returnorders@vbexports.co.in
  V B EXPORT, Nidhivan Appartment 602/6B Parle Point, Athwa,
  Near Taj Gateway, Surat

Thank you,
Youthnic Operations (Surat Fulfillment Center)
```

**After they confirm:** dispatch a test order and watch `POST /webhooks/delhivery`
return `200 { received: true }`. Until then, tracking works via polling
(`CRON_TRACKING_SYNC=*/30 * * * *`).

---

## Mail 2 — Warehouse verification / creation

**To:** vendordesk@delhivery.com
**Cc:** (your Delhivery business SPOC)
**Subject:** Verify pickup warehouse "Surat Warehouse" for Youthnic API manifestation

```
Hello Delhivery Vendor Desk,

Please confirm that the pickup warehouse below is active on our account
(it was created for API manifestation). If it does not exist, please create
it with these exact details — manifestation fails otherwise with
"ClientWarehouse matching query doesn't exist".

  Warehouse name (exact, case-sensitive): Surat Warehouse
  Brand / Seller name : V B EXPORT (storefront: Youthnic)
  Address             : 7004, Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat
  City / State / Pin  : Surat / Gujarat / 395002
  Phone               : +91 7984984563 (contact: Pawan Shukla)
  Email               : returnorders@vbexports.co.in
  Return address      : same as pickup address (Surat Warehouse, 395002)

Our system can also register/update it via your Client Warehouse
Creation/Updation APIs — please confirm the registered name once done so our
DELHIVERY_PICKUP_LOCATION value matches exactly.

Thank you,
Youthnic Operations (Surat Fulfillment Center)
```

**Alternative (no mail):** register it yourself from the app — Settings →
System Stack → "Delhivery Pickup Warehouse" → fill the same fields →
"Register warehouse". Then verify with `POST /api/setup/webhooks`-style check:
`npm run delhivery:check` must show the pickup name, and a test manifest must
not return a warehouse-mismatch error.
