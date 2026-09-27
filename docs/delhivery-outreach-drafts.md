# Delhivery Outreach Drafts (ready to send)

> Values below are taken from the live app config (verified 2026-09-28 via
> `npm run delhivery:check`). Replace `[SET A SECRET]` before sending Mail 1 —
> generate any random 24+ character string, put it in `.env` as
> `DELHIVERY_WEBHOOK_SECRET=<secret>`, redeploy, then paste the same value
> in the mail.

---

## Mail 1 — Scan-Push webhook enablement

**To:** lastmile-integration@delhivery.com
**Cc:** (your Delhivery business SPOC)
**Subject:** Request to enable Scan-Push webhook for Youthnic (Surat Warehouse)

```
Hello Delhivery Integration Team,

Please configure real-time Scan-Push (status updates) for our account to the
endpoint below:

  Webhook URL : https://shopify.youthnic.shop/webhooks/delhivery
  Method      : POST (JSON)
  Account     : Youthnic / VB Exports
  Pickup location (warehouse name): Surat Warehouse
  Seller pincode: 395002 (Surat, Gujarat)

Payload shapes accepted: official nested { Shipment: { AWB, Status: { Status,
StatusDateTime, StatusType, StatusLocation, Instructions } } } as well as the
legacy flat { waybill, status, status_type } shape.

Authentication: our endpoint accepts an optional shared secret via
`?secret=` query param or `x-delhivery-secret` header. We have set the secret
to:

  Secret: [SET A SECRET]

Please confirm once Scan-Push is live so we can verify with a test AWB
(e.g. 30100810010054).

Contact for integration issues:
  Pawan Shukla — returnorders@vbexports.co.in — +91 88661 54721

Thank you,
Youthnic Operations (Surat Fulfillment Center)
```

**After they confirm:** run `npm run delhivery:check`, then dispatch a test order
and watch `POST /webhooks/delhivery` return `200 { received: true }`. Until then,
tracking works via polling (`CRON_TRACKING_SYNC=*/30 * * * *`).

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
  Brand / Seller name : Youthnic
  Address             : [CONFIRM — must match DELHIVERY_SELLER_ADDRESS in our .env]
  City / State / Pin  : Surat / Gujarat / 395002
  Phone               : [CONFIRM — must match DELHIVERY_SELLER_PHONE]
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
