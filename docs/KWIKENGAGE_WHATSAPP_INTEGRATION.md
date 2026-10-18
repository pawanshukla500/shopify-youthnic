# KwikEngage WhatsApp Integration Documentation & Runbook

**Branch:** `kwikengage`  
**Repository:** `shopify-youthnic`  
**Last Verified:** October 18, 2026  

---

## 1. Overview & Credentials

Youthnic integrates with **KwikEngage (GoKwik Customer Engagement Platform)** via its official `v2` messaging endpoint:
`https://api.kwikengage.ai/send-message/v2`

This service connects Youthnic's Order Management System (OMS) to Meta's WhatsApp Business Account (WABA) to deliver automated, real-time order lifecycle updates to customers in tandem with transactional emails.

### Production Environment Variables (`.env`)

| Variable | Value | Description |
| :--- | :--- | :--- |
| `KWIKENGAGE_API_KEY` | `03c3feeab704cf72859251c3961cb8bddb51b7ad6944d7df56955444f9a0` | Production API authorization key |
| `KWIKENGAGE_MERCHANT_ID` | `68b58602a7da924255508380` (`youthnic`) | Merchant Identifier |
| `KWIKENGAGE_SENDER_PHONE` | `+91 79849 84563` (`917984984563`) | Registered WhatsApp sender mobile number |
| `KWIKENGAGE_WABA_ID` | `1173075567986214` | Meta WhatsApp Business Account ID |
| `KWIKENGAGE_API_URL` | `https://api.kwikengage.ai/send-message/v2` | Primary KwikEngage API endpoint |

---

## 2. Meta WhatsApp Business API Protocol: Session vs. Template Messages

Understanding this distinction is critical for production operations:

### A. Session Messages (`type: "session"`)
- **When Allowed:** Only within a **24-hour customer service window**.
- **Window Trigger:** The 24-hour timer starts whenever a customer sends an inbound message (e.g., `"Hi"`) to `+91 79849 84563`.
- **Capabilities:** Freeform text, images, PDF documents, videos, and interactive lists without pre-approval.
- **Error if Outside 24h:**
  ```json
  {
    "statusCode": 400,
    "message": "You can no longer reply directly to this user as it's been over 24 hours since their last message. You may now only send a template message on WhatsApp",
    "error": "Bad Request"
  }
  ```

### B. Template Messages (`type: "template"`)
- **When Allowed:** **Any time**, 24/7/365, without requiring prior customer interaction.
- **Category:** **Utility** (Transactional notifications for orders, shipping, delivery, returns, and refunds).
- **Requirement:** Templates must be created and approved in the **KwikEngage Template Builder** or Meta WhatsApp Manager.

---

## 3. Official API Request Payloads (`send-message/v2`)

All requests use:
- **Method:** `POST`
- **URL:** `https://api.kwikengage.ai/send-message/v2`
- **Headers:**
  ```http
  Content-Type: application/json
  Authorization: <KWIKENGAGE_API_KEY>
  x-api-key: <KWIKENGAGE_API_KEY>
  x-merchant-id: <KWIKENGAGE_MERCHANT_ID>
  ```

### 3.1. Session Text Message
```json
{
  "to": "919426279142",
  "channel": "whatsapp",
  "type": "session",
  "content": {
    "type": "text",
    "text": "✨ *Youthnic Order Confirmed!* ✨\n\nHi Pawan,\nThank you for shopping with Youthnic! Your order #26YOU1001 for ₹1499 has been confirmed.\n\n🚚 We are packaging your items for immediate dispatch from our Surat Hub."
  }
}
```

### 3.2. Session Media Message (Image / Document / Video)
```json
{
  "to": "919426279142",
  "channel": "whatsapp",
  "type": "session",
  "content": {
    "type": "media",
    "media": {
      "url": "https://storage.googleapis.com/shopify-134b9.firebasestorage.app/public/youthnic-logo.png",
      "type": "image",
      "caption": "Your Youthnic Order Invoice & Delivery Pass"
    }
  }
}
```

### 3.3. Template Message (Meta Utility HSM)
```json
{
  "to": "919426279142",
  "channel": "whatsapp",
  "type": "template",
  "content": {
    "type": "template",
    "template": {
      "template_id": "youthnic_order_confirmed",
      "language": "en",
      "parameters": [
        "Pawan Shukla",
        "#26YOU1001",
        "1499",
        "30100810010054"
      ]
    }
  }
}
```

### 3.4. Successful Response Format
```json
{
  "success": true,
  "messageId": "CAGHDVFHVFUDUYRFGUFJYR"
}
```

---

## 4. Multi-Channel Synchronization (Email + WhatsApp)

Every customer transactional email sent through `Resend` is paired with an equivalent WhatsApp utility message:

| Lifecycle Stage | Email Template | WhatsApp Trigger | Courier / Link Data |
| :--- | :--- | :--- | :--- |
| **Order Placed / Synced** | `ORDER_CONFIRMED` | `ORDER_CONFIRMED` | Order details & Surat hub status |
| **COD Verification** | `ORDER_CONFIRMED` | `COD_CONFIRMATION` | Interactive prompt: Reply `1` or `CONFIRM` |
| **Manifest / Dispatched** | `IN_TRANSIT` | `ORDER_SHIPPED` | Delhivery AWB + Live tracking link |
| **Hub-to-Hub Transit** | `IN_TRANSIT` | `IN_TRANSIT` | Current transit hub location + Delhivery tracking |
| **Transit Delayed** | `TRANSIT_DELAY` | `TRANSIT_DELAY` | Delay reason + Revised ETA + Live tracking |
| **Dispatch Delayed** | `DISPATCH_DELAY` | `DISPATCH_DELAY` | Fulfillment volume update (24-48h ETA) |
| **Out For Delivery** | `OUT_FOR_DELIVERY` | `OUT_FOR_DELIVERY` | Cash/UPI readiness prompt for COD |
| **Delivery Unsuccessful** | `NDR_ALERT` | `NDR_ALERT` | Reschedule link to prevent RTO |
| **Delivered** | `DELIVERED` | `DELIVERED` | Delivery confirmation & size assistance |
| **Return Initiated** | `RETURN_INITIATED` | `RETURN_INITIATED` | Reverse pickup AWB (Delhivery Reverse) |
| **Return Received** | `RETURN_RECEIVED` | `RETURN_RECEIVED` | Warehouse QC check in progress notice |
| **Refund Completed** | `RETURN_REFUND` | `REFUND_PROCESSED` | Amount + Gateway confirmation (2-4 days) |
| **Support Desk Reply** | `SUPPORT_REPLY` | `SUPPORT_REPLY` | Ticket reply text |

---

## 5. Live Testing on Phone Number `919426279142`

We have provided a dedicated diagnostic script: `scripts/test-whatsapp-kwikengage.ts`.

### How to Run:
```bash
npx tsx scripts/test-whatsapp-kwikengage.ts 919426279142
```

### Test Results Summary:
1. **API Key Authentication:** **SUCCESS** (API key is authorized by KwikEngage).
2. **KwikEngage v2 Schema Validation:** **SUCCESS** (All request fields validated).
3. **Session Delivery to `919426279142`:**
   - **Current Status:** `400 Bad Request` — `Over 24 hours since recipient sent message`.
   - **Instant Fix to receive message now:** Open WhatsApp on `919426279142` and send `"Hi"` to `+91 79849 84563`. Then run the script again. It will deliver immediately.

---

## 6. Official Meta WhatsApp Utility Templates (Ready to Copy-Paste)

In your **KwikEngage Dashboard** ([app.kwikengage.ai](https://app.kwikengage.ai)), go to:
**Templates** -> **WhatsApp Templates** -> **Create Template**

> [!IMPORTANT]
> - **Category:** Always select **UTILITY** (for fast approval and lowest Meta delivery pricing).
> - **Language:** `English` (`en` or `en_US`).

---

### Template 1: `youthnic_order_confirmed`
- **Category:** Utility
- **Header:** None (or Text: `Youthnic Order Confirmation`)
- **Body Text:**
```text
Hi {{1}}, thank you for shopping with Youthnic! Your order {{2}} for ₹{{3}} has been confirmed. Delivery to: {{4}}. We are packaging your items for immediate dispatch from our Surat Hub.
```
- **Footer (Optional):** `Youthnic · Surat Fulfillment Center`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`
  - `{{3}}`: `1499`
  - `{{4}}`: `Surat, Gujarat`

---

### Template 2: `youthnic_order_dispatched`
- **Category:** Utility
- **Header:** None (or Text: `Shipment Dispatched`)
- **Body Text:**
```text
Hi {{1}}, your Youthnic order {{2}} has been dispatched via {{3}}! Tracking AWB: {{4}}. Expected delivery is 2 to 4 business days.
```
- **Buttons (Optional):**
  - **Type:** URL Button
  - **Button Text:** `Track Package`
  - **URL:** `https://www.delhivery.com/track/package/` (Dynamic: `{{1}}`)
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`
  - `{{3}}`: `Delhivery Express`
  - `{{4}}`: `30100810010054`

---

### Template 3: `youthnic_out_for_delivery`
- **Category:** Utility
- **Header:** None (or Text: `Out For Delivery Today`)
- **Body Text:**
```text
Hi {{1}}, your Youthnic parcel for order {{2}} is OUT FOR DELIVERY today via {{3}}. Payment info: {{4}}. Please keep your phone reachable for smooth doorstep delivery.
```
- **Footer (Optional):** `Youthnic Express Delivery`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`
  - `{{3}}`: `Delhivery Express`
  - `{{4}}`: `₹1499 (Cash / UPI QR)`

---

### Template 4: `youthnic_order_delivered`
- **Category:** Utility
- **Header:** None (or Text: `Delivered Successfully`)
- **Body Text:**
```text
Hi {{1}}, your Youthnic order {{2}} has been successfully delivered! We hope you love your new ethnic wear. Thank you for choosing Youthnic!
```
- **Footer (Optional):** `Youthnic Customer Care`
- **Buttons (Optional):**
  - **Type:** Quick Reply Button
  - **Button Text:** `Need Size Help`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`

---

### Template 5: `youthnic_transit_delay`
- **Category:** Utility
- **Header:** None (or Text: `Shipment Transit Update`)
- **Body Text:**
```text
Hi {{1}}, your Youthnic order {{2}} is experiencing a brief transit delay due to: {{3}}. Revised estimated delivery: {{4}}. Tracking AWB: {{5}}. Our logistics team is actively tracking your shipment.
```
- **Footer (Optional):** `Youthnic Logistics Support`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`
  - `{{3}}`: `Logistics routing transit check`
  - `{{4}}`: `Within 2 business days`
  - `{{5}}`: `30100810010054`

---

### Template 6: `youthnic_ndr_reschedule`
- **Category:** Utility
- **Header:** None (or Text: `Delivery Attempt Unsuccessful`)
- **Body Text:**
```text
Hi {{1}}, a delivery attempt for your Youthnic order {{2}} was unsuccessful (Reason: {{3}}). AWB: {{4}}. Please click below or reply to reschedule your delivery before the package returns to Surat.
```
- **Buttons (Optional):**
  - **Type:** URL Button
  - **Button Text:** `Reschedule Delivery`
  - **URL:** `https://www.delhivery.com/track/package/`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla`
  - `{{2}}`: `#26YOU5752`
  - `{{3}}`: `Customer unreachable / premises closed`
  - `{{4}}`: `30100810010054`

---

### Template 7: `youthnic_refund_processed`
- **Category:** Utility
- **Header:** None (or Text: `Refund Processed`)
- **Body Text:**
```text
Hi {{1}}, your refund for Youthnic order {{2}} of ₹{{3}} has been processed successfully to your {{4}}. The amount will reflect in your account within 2 to 4 business days.
```
- **Footer (Optional):** `Youthnic Accounts Team`
- **Sample Values:**
  - `{{1}}`: `Pawan Shukla` (customer_name)
  - `{{2}}`: `#26YOU5752` (order_id)
  - `{{3}}`: `1499` (refund_amount)
  - `{{4}}`: `Original Payment Method (GoKwik / Easebuzz)` (payment_source)

---

## 7. Git Branch & Merge Guidance

- All modifications have been isolated on branch: **`kwikengage`**.
- Branch **`main`** is untouched and completely clean.
- Unit and integration tests: **19/19 passing** (`tests/kwikengage-and-gokwik.spec.ts`).
- TypeScript check: **0 errors** (`npx tsc --noEmit`).

### Recommended Action:
You can safely merge `kwikengage` into `main` whenever ready:
```bash
git checkout main
git merge kwikengage
git push origin main
```
