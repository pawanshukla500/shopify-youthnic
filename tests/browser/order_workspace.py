"""Isolated interaction checks. Run: python tests/browser/order_workspace.py.

Uses Python Playwright and installed frontend deps. ALL APIs are mocked and
non-local network requests blocked; no production credentials or actions.
"""
import copy
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect
from order_detail import BASE, ORDER, ROOT

SHIPMENT = {
    "id": 1, "orderId": 1883, "courier": "Delhivery", "waybillNumber": "30100810012703",
    "status": "IN_TRANSIT", "trackingStatus": "In Transit", "trackingLocation": "Bhiwandi, Maharashtra",
    "paymentMode": "Pre-paid", "forwardCharge": 45.68, "shippingCostSource": "ESTIMATE",
    "trackingLogs": [
        {"id": i * 2 + duplicate, "status": "UD:In Transit" if duplicate else "In Transit",
         "location": "Bhiwandi", "remark": f"Carrier scan {i}",
         "scannedAt": f"2026-10-{17 - i:02}T05:03:00Z"}
        for i in range(9) for duplicate in range(2)
    ],
}


def run():
    artifacts = Path(os.environ.get("ORDER_UI_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="youthnic-workspace-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    checks = []
    with (artifacts / "vite.log").open("w") as log:
        server = subprocess.Popen(
            ["node", str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
             "--host", "127.0.0.1", "--port", "5179", "--strictPort"],
            cwd=ROOT / "frontend", stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise RuntimeError(f"Vite exited: {artifacts / 'vite.log'}")
                try:
                    with urllib.request.urlopen(BASE, timeout=1):
                        break
                except OSError:
                    time.sleep(.5)
            else:
                raise RuntimeError("Vite did not start")
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
                context.route("**/src/context/AuthContext.tsx*", lambda route: route.fulfill(
                    content_type="application/javascript",
                    body="export const AuthProvider=({children})=>children; export const useAuth=()=>"
                         "({isAuthenticated:true,loading:false,user:{name:'Test Operator',avatar:'TO',role:'Operations'},logout:async()=>{}});"))
                context.route("**/src/firebase.ts*", lambda route: route.fulfill(
                    content_type="application/javascript", body="export const auth={currentUser:null}; export const googleProvider={};"))
                context.add_init_script("""
                    localStorage.setItem('youthnic_theme','light');
                    window.__opened=[]; window.__copied=[]; window.__confirm=true;
                    window.confirm=()=>window.__confirm;
                    window.open=(url)=>{window.__opened.push(url); return null;};
                    Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text)=>window.__copied.push(text)}});
                """)
                errors = []
                pages = []
                held_requests = {}

                def scenario(**overrides):
                    current = copy.deepcopy(ORDER)
                    current.update({"status": "IN_TRANSIT", "fulfillmentStatus": "fulfilled",
                                    "shipment": copy.deepcopy(SHIPMENT), "shopifyNote": "Call before delivery."})
                    current.update(overrides)
                    page = context.new_page()
                    page.set_default_timeout(10000)
                    pages.append(page)
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    calls = []
                    failures = set()

                    def api(route):
                        request = route.request
                        path = urlparse(request.url).path.removeprefix("/api/")
                        calls.append((request.method, path, request.post_data_json if request.post_data else None))
                        if "hold:" + path in failures:
                            held_requests[path] = route
                            return
                        if path in failures:
                            route.fulfill(status=502, content_type="application/json", body=json.dumps({"error": "Simulated upstream outage"}))
                            return
                        if path.endswith("/download"):
                            extension = "zip" if "bulk-pack" in path else "html"
                            route.fulfill(content_type="application/octet-stream", headers={
                                "Content-Disposition": f'attachment; filename="order-test.{extension}"',
                            }, body="<html>Mock document</html>")
                            return
                        if path == "orders/1883":
                            data = {"order": current}
                        elif path == "orders/1883/payment":
                            data = {"payment": current}
                        elif path.endswith("/account-trail"):
                            data = {"events": []}
                        elif path == "health":
                            data = {"status": "ok"}
                        elif path.endswith("/epod"):
                            data = {"epodUrl": "https://example.invalid/mock-epod"}
                        elif path.endswith("/refund"):
                            data = {"refundId": "MOCK-REFUND", "moneyMoved": current["paymentMethod"] != "COD"}
                        elif path.endswith("/returns"):
                            data = {"returnWaybill": "MOCK-RETURN-AWB", "pickupAutomatic": True}
                        elif path.endswith("/sync-external"):
                            data = {"found": True, "waybillNumber": "MOCK-AWB", "courier": "Delhivery"}
                        elif path.endswith("/refunds/manual"):
                            data = {"event": {"id": 1}}
                        else:
                            data = {"success": True, "verified": True, "closedNow": 0, "order": current,
                                    "shipment": current["shipment"], "tracking": {"scans": []},
                                    "message": "Mock action completed.", "orders": [], "counts": {}, "events": []}
                        route.fulfill(content_type="application/json", body=json.dumps(data))

                    page.route("**/api/**", api)
                    page.goto(BASE + "/orders/1883")
                    expect(page.get_by_role("heading", name="#26YOU6061")).to_be_visible()
                    return page, calls, failures, current

                def tab(page, name):
                    page.get_by_role("tab", name=name, exact=True).click()
                    expect(page.get_by_role("tab", name=name, exact=True)).to_have_attribute("aria-selected", "true")

                def menu(page, name):
                    page.get_by_role("button", name="More actions", exact=True).click()
                    if page.get_by_role("menuitem", name=name, exact=True).count() == 0:
                        print("Menu diagnostic:", name, page.get_by_role("menuitem").all_text_contents())
                        page.screenshot(path=str(artifacts / "menu-failure.png"))
                    page.get_by_role("menuitem", name=name, exact=True).click()

                def called(calls, path, method="POST"):
                    return [body for verb, endpoint, body in calls if endpoint == path and verb == method]

                page, calls, failures, current = scenario()
                overview = page.get_by_role("tabpanel", name="Overview", exact=True)
                expect(overview.locator(".timeline-item")).to_have_count(4)
                overview.get_by_role("button", name="View all 9 tracking events").click()
                expect(overview.locator(".timeline-item")).to_have_count(9)
                overview.get_by_role("button", name="Show recent activity").click()
                expect(overview.locator(".timeline-item")).to_have_count(4)
                expect(page.get_by_role("heading", name="Create reverse pickup", exact=True)).not_to_be_visible()
                page.get_by_role("button", name="Copy order name").click()
                page.get_by_role("button", name="Copy Address", exact=True).click()
                page.get_by_title("Copy SKU").click()
                assert len(page.evaluate("window.__copied")) == 3
                assert page.get_by_role("link", name="WhatsApp Chat").get_attribute("href").startswith("https://wa.me/919999999999?")
                assert page.get_by_role("link", name="Call Customer").get_attribute("href") == "tel:919999999999"
                page.get_by_role("tab", name="Overview", exact=True).focus()
                page.keyboard.press("ArrowRight")
                expect(page.get_by_role("tab", name="Shipment", exact=True)).to_be_focused()
                page.keyboard.press("Home")
                expect(page.get_by_role("tab", name="Overview", exact=True)).to_be_focused()
                page.get_by_role("button", name="Manage shipment", exact=True).click()
                expect(page.get_by_role("tabpanel", name="Shipment", exact=True)).to_be_visible()
                page.get_by_role("button", name="Refresh Live Tracking", exact=True).click()
                expect(page.get_by_text(re.compile("Live tracking refreshed"))).to_be_visible()
                assert len(called(calls, "orders/1883/track")) == 1
                menu(page, "Edit phone / address")
                expect(page.get_by_label("Corrected phone", exact=True)).to_have_value("919999999999")
                page.get_by_label("Corrected phone", exact=True).fill("9888888888")
                page.get_by_label("Corrected address", exact=True).fill("Corrected test address")
                page.get_by_role("button", name="Push to Delhivery", exact=True).click()
                expect(page.get_by_text("Corrected details pushed to Delhivery!")).to_be_visible()
                assert called(calls, "delhivery/shipment/30100810012703", "PATCH")[-1] == {"phone": ["9888888888"], "address": "Corrected test address"}
                page.evaluate("window.__confirm=false")
                page.get_by_role("button", name="Cancel shipment", exact=True).click()
                assert not called(calls, "delhivery/shipment/30100810012703/cancel")
                page.evaluate("window.__confirm=true")
                page.get_by_role("button", name="Cancel shipment", exact=True).click()
                expect(page.get_by_text("Shipment cancellation requested.")).to_be_visible()
                assert len(called(calls, "delhivery/shipment/30100810012703/cancel")) == 1
                checks.append("navigation, keyboard tabs, display scan dedup, copy/contact links, tracking refresh, shipment edit/cancel")

                # Document buttons must download or open only the correct order document.
                for name, endpoint in [
                    ("Download label", "orders/1883/label/download"),
                    ("Download label + invoice", "orders/1883/label-and-invoice/download"),
                    ("Download invoice", "orders/1883/invoice/download"),
                    ("Order pack (ZIP)", "orders/bulk-pack/download"),
                ]:
                    with page.expect_download():
                        menu(page, name)
                    assert any(path == endpoint for _, path, _ in calls), endpoint
                for name, suffix in [("Print label", "/label"), ("Print label + invoice", "/label-and-invoice"), ("GST tax invoice", "/invoice")]:
                    menu(page, name)
                    assert suffix in page.evaluate("window.__opened")[-1]
                menu(page, "Delhivery packing slip")
                expect(page.get_by_text(re.compile("Printable label opened"))).to_be_visible()
                page.get_by_role("button", name="More actions", exact=True).click()
                page.keyboard.press("Escape")
                expect(page.get_by_role("menu")).not_to_be_visible()
                expect(page.get_by_role("button", name="More actions", exact=True)).to_be_focused()
                checks.append("all document downloads/print routes, packing slip, menu Escape/focus")

                tab(page, "Payments")
                page.get_by_role("button", name="Mark payment received", exact=True).click()
                page.locator(".money-form").get_by_role("button", name="Save", exact=True).click()
                expect(page.get_by_text("Enter the bank UTR.")).to_be_visible()
                assert not called(calls, "accounts/orders/1883/payment-received")
                page.get_by_label("Bank UTR", exact=True).fill("TEST-UTR-ONLY")
                page.get_by_label("Amount", exact=False).first.fill("573.32")
                page.locator(".money-form").get_by_role("button", name="Save", exact=True).click()
                expect(page.get_by_text("Payment recorded.", exact=True)).to_be_visible()
                assert called(calls, "accounts/orders/1883/payment-received")[-1]["utr"] == "TEST-UTR-ONLY"
                page.get_by_role("button", name="Record manual refund", exact=True).click()
                page.get_by_role("button", name="Save refund audit record", exact=True).click()
                expect(page.get_by_text("Choose how the refund was sent.")).to_be_visible()
                page.get_by_label(re.compile("^Refund mode")).select_option("UPI")
                page.get_by_label(re.compile("^Account / source used")).fill("Test account ending 4821")
                tab(page, "Overview")
                tab(page, "Payments")
                expect(page.get_by_label(re.compile("^Account / source used"))).to_have_value("Test account ending 4821")
                page.get_by_role("button", name="Save refund audit record", exact=True).click()
                expect(page.get_by_text("Manual refund recorded in the account trail.")).to_be_visible()
                assert len(called(calls, "orders/1883/refunds/manual")) == 1
                page.evaluate("window.__confirm=false")
                page.get_by_role("button", name="Refund", exact=True).click()
                assert not called(calls, "orders/1883/refund")
                page.evaluate("window.__confirm=true")
                page.get_by_role("button", name="Refund", exact=True).click()
                expect(page.get_by_text(re.compile("Shopify refund processed successfully"))).to_be_visible()
                assert len(called(calls, "orders/1883/refund")) == 1
                checks.append("bank UTR validation/save, manual audit validation/save, form preservation, refund confirmation")

                tab(page, "Returns")
                expect(page.get_by_role("heading", name="Customer delivery required")).to_be_visible()
                expect(page.get_by_role("button", name="Create reverse pickup", exact=True)).to_have_count(0)
                failures.add("orders/1883/refresh-shopify")
                page.get_by_role("button", name="Refresh from Shopify", exact=True).click()
                expect(page.get_by_text("Simulated upstream outage")).to_be_visible()
                checks.append("in-transit return guard and upstream error feedback")

                delivered = copy.deepcopy(SHIPMENT)
                delivered["status"] = "DELIVERED"
                page, calls, _, _ = scenario(status="DELIVERED", deliveredAt="2026-10-16T05:00:00Z", shipment=delivered)
                menu(page, "Create reverse pickup")
                expect(page.get_by_role("tabpanel", name="Returns", exact=True)).to_be_visible()
                page.get_by_role("button", name="Create reverse pickup", exact=True).click()
                expect(page.get_by_text("Add a reason before creating the return.")).to_be_visible()
                page.get_by_role("button", name="Size mismatch", exact=True).click()
                page.get_by_role("button", name="Create reverse pickup", exact=True).click()
                expect(page.get_by_text("Select at least one item to return.")).to_be_visible()
                page.locator(".return-items input[type=checkbox]").check()
                page.get_by_role("button", name="Link an AWB that already exists", exact=True).click()
                page.get_by_label("Existing return AWB").fill("999000111")
                page.get_by_role("button", name="Create reverse pickup", exact=True).click()
                expect(page.get_by_text(re.compile("Reverse AWB MOCK-RETURN-AWB"))).to_be_visible()
                payload = called(calls, "orders/1883/returns")[-1]
                assert payload["items"] == [{"orderItemId": 1, "quantity": 1}]
                assert payload["returnReason"] == "Size mismatch" and payload["returnWaybillNumber"] == "999000111"
                tab(page, "Shipment")
                expect(page.get_by_role("button", name="Cancel shipment", exact=True)).to_have_count(0)
                page.get_by_role("button", name="View EPOD", exact=True).click()
                page.wait_for_function("window.__opened.some(url => url.includes('mock-epod'))")
                assert "mock-epod" in page.evaluate("window.__opened")[-1]
                checks.append("delivered return validation, selected items/existing AWB payload, terminal cancel guard and EPOD")

                active_return = {"id": 7, "orderId": 1883, "returnStatus": "PICKUP_SCHEDULED",
                                 "returnReason": "Changed mind", "returnWaybillNumber": "REV123", "pickupAutomatic": True}
                page, calls, _, _ = scenario(status="RETURN_REQUESTED", returns=[active_return], deliveredAt="2026-10-16T05:00:00Z")
                tab(page, "Returns")
                page.get_by_label("Update return reason").select_option("Size mismatch")
                page.get_by_role("button", name="Update reason", exact=True).click()
                expect(page.get_by_text(re.compile("Reason saved."))).to_be_visible()
                assert called(calls, "returns/7/reason", "PATCH")[-1] == {"returnReason": "Size mismatch"}
                checks.append("existing return reason update")

                page, calls, _, _ = scenario(status="NEW", financialStatus="pending", paymentMethod="COD", paymentVerified=False, shipment=None, tags="")
                page.get_by_role("button", name="Confirm COD", exact=True).click()
                expect(page.get_by_text("Mock action completed.", exact=True)).to_be_visible()
                assert len(called(calls, "orders/1883/confirm-cod")) == 1
                tab(page, "Payments")
                page.get_by_role("button", name="Verify payment", exact=True).click()
                expect(page.get_by_text("Payment verified.", exact=True)).to_be_visible()
                assert len(called(calls, "orders/1883/payment/verify")) == 1
                page.get_by_role("button", name="Refund", exact=True).click()
                expect(page.get_by_text(re.compile("no online payment was available"))).to_be_visible()
                tab(page, "Shipment")
                page.get_by_role("button", name="Get External AWB", exact=True).click()
                expect(page.get_by_text(re.compile("Found tracking ID: MOCK-AWB"))).to_be_visible()
                menu(page, "WhatsApp alert")
                dialog = page.get_by_role("dialog", name="Send WhatsApp message")
                dialog.locator("select").select_option("CUSTOM")
                dialog.locator("textarea").fill("Test only message")
                dialog.get_by_role("button", name="Send WhatsApp Message", exact=True).click()
                expect(dialog).not_to_be_visible()
                assert called(calls, "orders/1883/whatsapp-trigger")[-1]["customText"] == "Test only message"
                menu(page, "Cancel order")
                expect(page.get_by_role("dialog", name="Cancel order")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog")).not_to_be_visible()
                menu(page, "Cancel order")
                page.get_by_role("button", name="Confirm Order Cancellation", exact=True).click()
                expect(page.get_by_role("dialog")).not_to_be_visible()
                assert len(called(calls, "orders/1883/cancel")) == 1
                checks.append("COD approval, payment verification, COD refund messaging, external AWB, WhatsApp, cancel/escape")

                page, calls, pending, _ = scenario(status="DISPATCH_PENDING", shipment=None)
                pending.add("hold:orders/1883/dispatch")
                page.get_by_role("button", name="Dispatch with Delhivery", exact=True).click()
                expect(page.get_by_role("button", name="Dispatch with Delhivery", exact=True)).to_be_disabled()
                pending.clear()
                held_requests.pop("orders/1883/dispatch").fulfill(content_type="application/json", body=json.dumps({"success": True, "waybillNumber": "MOCK-AWB"}))
                expect(page.get_by_text(re.compile("Order dispatched"))).to_be_visible()
                assert len(called(calls, "orders/1883/dispatch")) == 1
                menu(page, "Email customer")
                expect(page).to_have_url(re.compile("/communications"))
                page, calls, _, _ = scenario(status="FAILED_DELIVERY", hasNdrException=True)
                page.get_by_role("button", name="Resolve NDR", exact=True).click()
                page.get_by_placeholder(re.compile("Customer requested evening")).fill("Test instruction")
                page.get_by_role("button", name=re.compile("Schedule Courier Re-Attempt")).click()
                expect(page.get_by_role("dialog")).not_to_be_visible()
                assert called(calls, "orders/1883/ndr-action")[-1]["action"] == "RE-ATTEMPT"
                page.get_by_role("button", name="Resolve NDR", exact=True).click()
                page.get_by_role("dialog", name="Resolve NDR").locator('input[type="radio"][value="RTO"]').check()
                page.get_by_role("button", name=re.compile("Mark Return to Origin")).click()
                expect(page.get_by_role("dialog")).not_to_be_visible()
                assert called(calls, "orders/1883/ndr-action")[-1]["action"] == "RTO"
                page, calls, _, _ = scenario(status="RTO_DELIVERED")
                tab(page, "Returns")
                expect(page.get_by_role("heading", name="Customer delivery required")).to_be_visible()
                page.get_by_role("button", name="Refund RTO order", exact=True).click()
                expect(page.get_by_text("Mock action completed.", exact=True)).to_be_visible()
                assert len(called(calls, "orders/1883/rto-refund")) == 1
                page, calls, _, _ = scenario(status="CANCELLED")
                expect(page.get_by_role("button", name="Refund", exact=True)).to_have_count(0)
                menu(page, "Delete order")
                page.get_by_role("button", name="Permanently Delete", exact=True).click()
                expect(page).to_have_url(re.compile("/orders$"))
                assert len(called(calls, "orders/1883", "DELETE")) == 1
                checks.append("dispatch, email navigation, NDR, RTO guard/refund and cancelled-order delete")
                page, _, _, _ = scenario(status="DELIVERED", deliveredAt="2026-10-16T05:00:00Z", shipment=delivered)
                page.goto(BASE + "/orders/1883#return-panel")
                expect(page.get_by_role("tab", name="Returns", exact=True)).to_have_attribute("aria-selected", "true")
                checks.append("return deep link, dispatch loading guard and both NDR actions")

                # Inspect actual user-facing themes, section layouts, and reduced motion.
                page, _, _, _ = scenario()
                page.emulate_media(reduced_motion="reduce")
                for width in [375, 768, 1440]:
                    page.set_viewport_size({"width": width, "height": 1000})
                    for section in ["Overview", "Shipment", "Payments", "Returns", "Details"]:
                        tab(page, section)
                        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), (width, section)
                    tab(page, "Overview")
                    page.screenshot(path=str(artifacts / f"overview-{width}.png"))
                page.get_by_role("button", name=re.compile("^.*Dark$")).first.click()
                expect(page.locator("html")).to_have_attribute("data-theme", "dark")
                page.screenshot(path=str(artifacts / "overview-dark.png"))
                tab(page, "Payments")
                page.screenshot(path=str(artifacts / "payments-dark.png"))
                checks.append("375/768/1440px all sections, dark theme and reduced motion")
                assert not errors, errors
                browser.close()
                print(json.dumps({"result": "PASS", "checks": checks, "screenshots": str(artifacts)}, indent=2))
        finally:
            server.terminate()
            server.wait(timeout=15)


if __name__ == "__main__":
    run()
