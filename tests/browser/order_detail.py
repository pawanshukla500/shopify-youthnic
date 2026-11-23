"""Optional UI smoke test: python tests/browser/order_detail.py.

Requires Python Playwright and its Chromium browser, plus installed frontend deps.
All API traffic and auth are intercepted in the test browser only.
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:5179"
ORDER = {
    "id": 1883, "shopifyOrderId": "18951876083911", "shopifyOrderName": "#26YOU6061",
    "shopifyOrderNumber": 6061, "customerName": "Test Customer", "customerPhone": "919999999999",
    "customerEmail": "buyer@example.com", "customerAddress": "Test delivery address",
    "customerCity": "Bengaluru", "customerState": "Karnataka", "customerPincode": "560045",
    "customerCountry": "India", "totalAmount": 573.32, "totalShipping": 45,
    "totalDiscounts": 70.68, "totalTax": 27.3, "taxesIncluded": True,
    "shippingTitle": "Shipping Fee", "discountCodes": [{"code": "newyou10"}],
    "taxLines": [{"title": "CGST", "rate": 0.05, "price": "27.30"}],
    "currency": "INR", "paymentMethod": "Pre-paid", "financialStatus": "paid",
    "fulfillmentStatus": None, "status": "DISPATCH_PENDING", "paymentVerified": True,
    "salesChannel": "Youthnic <> GoKwik", "shopifyCreatedAt": "2026-10-17T11:13:00Z",
    "createdAt": "2026-10-17T11:13:00Z", "tags": "", "returns": [], "shipment": None,
    "shopifyNote": "<script>window.untrustedNote = true</script>",
    "additionalDetails": [{"name": "Delivery instructions", "value": "Evening delivery"}],
    "items": [{"id": 1, "title": "Rust Cotton Blend Ajrak Print A-Line Front Slit Long Kurta",
               "variantTitle": "L", "sku": "B170-Jodha-Rust_L", "price": 599,
               "quantity": 1, "returnable": True, "imageUrl": None}],
}

REFUNDED_ORDER = {
    "id": 1884, "shopifyOrderId": "18968329158855", "shopifyOrderName": "#26YOU6197",
    "shopifyOrderNumber": 6197, "customerName": "Tanisha Aggarwal", "customerPhone": "919878412263",
    "customerEmail": "aggarwaltanisha42@gmail.com", "customerAddress": "Pazo premium ladies pg, Vinayak nagar",
    "customerCity": "BANGALORE", "customerState": "Karnataka", "customerPincode": "560063",
    "customerCountry": "India", "totalAmount": 1273.02, "totalShipping": 0,
    "totalDiscounts": 225.98, "totalTax": 60.62, "taxesIncluded": True,
    "shippingTitle": "Free Shipping", "discountCodes": [], "taxLines": [{"title": "IGST", "rate": 0.05, "price": "60.62"}],
    "currency": "INR", "paymentMethod": "Pre-paid", "paymentGateway": "Gokwik UPI",
    "paymentProvider": "Easebuzz", "paymentInstrument": "UPI (@ptaxis)", "paymentReference": "630059793263",
    "financialStatus": "refunded", "fulfillmentStatus": "fulfilled", "status": "REFUNDED",
    "paymentVerified": True, "salesChannel": "Youthnic <> GoKwik",
    "shopifyCreatedAt": "2026-11-18T11:13:00Z", "createdAt": "2026-11-18T11:13:00Z",
    "tags": "GoKwik, Refund_initiated, Refund_credited, Refunded, UPI",
    "refundRrn": "104519502377", "refundArn": "RVL9Z7IJ39",
    "refundSource": "UPI (@ptaxis) · Easebuzz", "refundGatewayStatus": "CREDITED",
    "refundReferenceUpdatedAt": "2026-11-23T08:15:00Z",
    "refundSummary": {
        "isRefunded": True, "isPartial": False, "isManualCod": False,
        "refundAmount": 1273.02, "shopifyRefundId": "1118855626951",
        "refundTransactionId": "#26YOU6197.2", "refundRrn": "104519502377",
        "refundArn": "RVL9Z7IJ39", "settlementBatchUtr": "HDFCH01421070008",
        "refundSource": "UPI (@ptaxis) · Easebuzz",
        "customerRefundSource": "Original UPI (@ptaxis) via Easebuzz",
        "paymentInstrument": "UPI (@ptaxis)", "paymentProvider": "Easebuzz",
        "refundGatewayStatus": "CREDITED",
        "refundProcessedAt": "2026-11-23T07:20:39Z",
        "refundCreditedAt": "2026-11-23T08:15:00Z",
        "emailSentAt": None, "rrnEmailSentAt": None,
        "checkoutReference": "630059793263",
    },
    "returns": [{
        "id": 24, "orderId": 1884, "returnWaybillNumber": "VELR1494131364",
        "carrier": "VELOCITY", "returnStatus": "REFUNDED", "qcStatus": "APPROVED",
        "refundStatus": "PROCESSED", "refundAmount": 1273.02,
        "shopifyRefundId": "1118855626951", "refundTransactionId": "#26YOU6197.2",
        "refundRrn": "104519502377", "refundArn": "RVL9Z7IJ39",
        "refundSource": "UPI (@ptaxis) · Easebuzz", "refundGatewayStatus": "CREDITED",
        "refundProcessedAt": "2026-11-23T07:20:39Z", "refundCreditedAt": "2026-11-23T08:15:00Z",
        "refundEmailSentAt": None, "returnReason": "not suiting on me",
        "createdAt": "2026-11-20T09:00:00Z",
        "items": [{"id": 10, "quantity": 1, "orderItem": {
            "id": 2, "title": "Dusty Blue Linen Floral Print Straight Short Kurti With Farshi Set",
            "variantTitle": "M", "sku": "BT165-Nishi-Dusty-Blue_M", "price": 1499, "quantity": 1,
            "returnable": True, "imageUrl": None,
        }}],
    }],
    "shipment": None,
    "shopifyNote": None,
    "additionalDetails": [
        {"name": "Payment_Provider_Name", "value": "easebuzz"},
        {"name": "Payment_Method", "value": "UPI"},
        {"name": "Payment_Sub_Method", "value": "@ptaxis"},
        {"name": "Refund RRN", "value": "104519502377"},
        {"name": "Refund ARN", "value": "RVL9Z7IJ39"},
    ],
    "items": [{"id": 2, "title": "Dusty Blue Linen Floral Print Straight Short Kurti With Farshi Set",
               "variantTitle": "M", "sku": "BT165-Nishi-Dusty-Blue_M", "price": 1499,
               "quantity": 1, "returnable": True, "imageUrl": None}],
}


def run():
    artifacts = Path(os.environ.get("ORDER_UI_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="youthnic-order-ui-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    with (artifacts / "vite.log").open("w") as log:
        server = subprocess.Popen(
            ["node", str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
             "--host", "127.0.0.1", "--port", "5179", "--strictPort"],
            cwd=ROOT / "frontend", stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise RuntimeError(f"Vite exited; see {artifacts / 'vite.log'}")
                try:
                    with urllib.request.urlopen(BASE, timeout=1):
                        break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("Vite did not start")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                context.add_init_script("localStorage.setItem('youthnic_theme', 'light')")
                context.route("**/src/context/AuthContext.tsx*", lambda route: route.fulfill(
                    content_type="application/javascript",
                    body="export const AuthProvider = ({children}) => children;"
                         "export const useAuth = () => ({isAuthenticated:true,loading:false,"
                         "user:{name:'Test Operator',avatar:'TO',role:'Operations'},logout:async()=>{}});",
                ))
                context.route("**/src/firebase.ts*", lambda route: route.fulfill(
                    content_type="application/javascript",
                    body="export const auth = {currentUser:null}; export const googleProvider = {};",
                ))
                mutations = []
                current = dict(ORDER)
                refunded = json.loads(json.dumps(REFUNDED_ORDER))

                def api(route):
                    path = route.request.url.split("/api/")[-1]
                    if route.request.method == "POST":
                        mutations.append(path)
                        if path.endswith("/refresh-shopify"):
                            current.update(ORDER)
                        elif path == "orders/1884/refund-details/sync":
                            route.fulfill(content_type="application/json", body=json.dumps({
                                "success": True, "updated": True, "newReferenceFound": True,
                                "emailSent": False, "refundSummary": refunded["refundSummary"],
                            }))
                            return
                        elif path == "orders/1884/refund-email":
                            refunded["refundSummary"]["emailSentAt"] = "2026-11-23T08:30:00Z"
                            refunded["returns"][0]["refundEmailSentAt"] = "2026-11-23T08:30:00Z"
                            route.fulfill(content_type="application/json", body=json.dumps({
                                "success": True, "recipient": refunded["customerEmail"],
                                "refundRrn": "104519502377", "refundArn": "RVL9Z7IJ39",
                                "refundSource": "Original UPI (@ptaxis) via Easebuzz",
                            }))
                            return
                    if path == "orders/1883" or path.endswith("/refresh-shopify"):
                        data = {"order": current}
                    elif path == "orders/1883/payment":
                        data = {"payment": current}
                    elif path == "orders/1884":
                        data = {"order": refunded}
                    elif path == "orders/1884/payment":
                        data = {"payment": refunded}
                    elif path.endswith("/account-trail"):
                        data = {"events": []}
                    elif path == "health":
                        data = {"status": "ok"}
                    else:
                        data = {"orders": [], "counts": {}, "events": [], "returns": []}
                    route.fulfill(content_type="application/json", body=json.dumps(data))

                context.route("**/api/**", api)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(BASE + "/orders/1883")
                expect(page.get_by_role("heading", name="#26YOU6061")).to_be_visible()
                rows = page.locator(".shopify-paid-row")
                expect(rows.filter(has_text="Subtotal")).to_contain_text("599.00")
                expect(rows.filter(has_text="Discount")).to_contain_text("-₹70.68")
                expect(rows.filter(has_text="Shipping")).to_contain_text("₹45.00")
                expect(rows.filter(has_text="Taxes")).to_contain_text("CGST 5%")
                expect(rows.filter(has_text="Taxes")).to_contain_text("₹27.30")
                expect(rows.filter(has_text="Taxes")).to_contain_text("Included")
                expect(page.locator(".shopify-paid")).not_to_contain_text("87.46")
                assert page.evaluate("window.untrustedNote") is None
                page.screenshot(path=str(artifacts / "order-desktop.png"), full_page=True)
                page.get_by_text("Additional details", exact=False).first.click()
                expect(page.get_by_text("Evening delivery", exact=True)).to_be_visible()
                page.get_by_role("button", name="More actions", exact=True).click()
                expect(page.get_by_role("menuitem", name="Download invoice", exact=True)).to_be_visible()
                page.get_by_role("button", name="More actions", exact=True).click()
                page.get_by_role("button", name="Refresh from Shopify", exact=True).click()
                expect(page.get_by_text("Order details refreshed from Shopify.")).to_be_visible()
                assert mutations == ["orders/1883/refresh-shopify"], mutations
                for width in [375, 768, 1440]:
                    page.set_viewport_size({"width": width, "height": 900})
                    page.wait_for_timeout(150)
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width
                    expect(rows.filter(has_text="Discount")).to_be_visible()
                    page.screenshot(path=str(artifacts / f"order-{width}.png"), full_page=True)
                page.get_by_role("button", name="Dark", exact=True).click()
                page.screenshot(path=str(artifacts / "order-dark.png"), full_page=True)
                current.update({"totalShipping": None, "totalDiscounts": None, "totalTax": None})
                page.reload()
                expect(page.locator(".shopify-sync-hint")).to_be_visible()
                expect(rows.filter(has_text="Shipping")).to_contain_text("Not synced")
                expect(rows.filter(has_text="Discount")).to_contain_text("Not synced")
                expect(rows.filter(has_text="Taxes")).to_contain_text("Not synced")

                # Verify highlighted Refund Details card (RRN, ARN, Source, Sync RRN, Email Receipt)
                page.set_viewport_size({"width": 1440, "height": 1000})
                page.goto(BASE + "/orders/1884")
                expect(page.get_by_role("heading", name="#26YOU6197")).to_be_visible()
                card = page.locator(".refund-highlight-card").first
                expect(card).to_be_visible()
                expect(card).to_contain_text("104519502377")
                expect(card).to_contain_text("RVL9Z7IJ39")
                expect(card).to_contain_text("UPI (@ptaxis) · Easebuzz")
                expect(card).to_contain_text("1118855626951")
                expect(card).to_contain_text("HDFCH01421070008")
                expect(card).to_contain_text("Credited · Bank Ref Verified")
                page.screenshot(path=str(artifacts / "refund-order-light.png"), full_page=True)

                page.get_by_role("button", name="Sync RRN", exact=True).click()
                expect(page.get_by_text("Refund details updated", exact=False)).to_be_visible()
                page.get_by_role("button", name="Email Receipt", exact=True).click()
                expect(page.get_by_text("Refund receipt emailed to aggarwaltanisha42@gmail.com", exact=False).first).to_be_visible()
                expect(page.get_by_role("button", name="Resend Receipt", exact=True)).to_be_visible()
                assert "orders/1884/refund-details/sync" in mutations, mutations
                assert "orders/1884/refund-email" in mutations, mutations

                # Verify Payments tab & Returns tab also highlight RRN/ARN/Source
                page.get_by_role("tab", name="Payments").click()
                payments_panel = page.locator("#order-section-payments")
                expect(payments_panel.locator(".refund-highlight-card")).to_be_visible()
                expect(payments_panel).to_contain_text("104519502377")
                expect(payments_panel).to_contain_text("RVL9Z7IJ39")
                expect(payments_panel).to_contain_text("UPI (@ptaxis) · Easebuzz")
                page.get_by_role("tab", name="Returns").click()
                returns_panel = page.locator("#order-section-returns")
                expect(returns_panel.locator(".refund-highlight-card.is-compact").first).to_be_visible()
                expect(returns_panel).to_contain_text("104519502377")
                page.get_by_role("tab", name="Overview").click()

                for width in [375, 768, 1440]:
                    page.set_viewport_size({"width": width, "height": 900})
                    page.wait_for_timeout(150)
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"refund-{width}"
                page.set_viewport_size({"width": 375, "height": 900})
                page.wait_for_timeout(150)
                page.screenshot(path=str(artifacts / "refund-order-mobile.png"), full_page=True)
                page.set_viewport_size({"width": 1440, "height": 1000})
                page.get_by_role("button", name="Dark", exact=True).click()
                page.wait_for_timeout(150)
                page.screenshot(path=str(artifacts / "refund-order-dark.png"), full_page=True)

                assert not errors, errors
                browser.close()
                print(f"PASS: amounts, unknown data, safe notes, refresh, menu, refund RRN/ARN/source card, 375/768/1440px. Screenshots: {artifacts}")
        finally:
            server.terminate()
            server.wait(timeout=15)


if __name__ == "__main__":
    run()
