"""Browser checks with every API mocked; no live bank/courier operations."""
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
from order_detail import BASE, ROOT, ORDER
from order_workspace import SHIPMENT


def run():
    artifacts = Path(os.environ.get("ORDER_UI_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="youthnic-payments-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    with (artifacts / "payments-vite.log").open("w") as log:
        server = subprocess.Popen(["node", str(ROOT / "frontend/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5179", "--strictPort"], cwd=ROOT / "frontend", stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise RuntimeError(f"Vite exited; {artifacts}")
                try:
                    with urllib.request.urlopen(BASE, timeout=1):
                        break
                except OSError:
                    time.sleep(.5)
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                context.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
                context.route("**/src/context/AuthContext.tsx*", lambda r: r.fulfill(content_type="application/javascript", body="export const AuthProvider=({children})=>children; export const useAuth=()=>({isAuthenticated:true,loading:false,user:{name:'Test Operator',avatar:'TO',role:'Finance'},logout:async()=>{}});"))
                context.route("**/src/firebase.ts*", lambda r: r.fulfill(content_type="application/javascript", body="export const auth={currentUser:null}; export const googleProvider={};"))
                context.add_init_script("localStorage.setItem('youthnic_theme','light'); window.confirm=()=>true; window.__copied=[]; Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>window.__copied.push(t)}});")
                order = copy.deepcopy(ORDER)
                order.update({"status": "DISPATCHED", "paymentReference": "CUSTOMER-CHECKOUT-REF", "gatewayTransactionId": "GATEWAY-TXN",
                              "paymentReceivedAt": "2026-10-16T05:00:00Z", "paymentReceivedAmount": 558.32,
                              "paymentReceivedUtr": "BANK-SETTLEMENT-UTR", "paymentReceivedRef": "SETTLEMENT-R1", "paymentReceivedSource": "GOKWIK_SETTLEMENT", "gatewayFee": 15})
                order["shipment"] = copy.deepcopy(SHIPMENT)
                order["shipment"].update({"status": "CREATED", "trackingStatus": "Label generated", "manifestedByOms": True,
                    "pickupBatch": {"key": "test:2026-10-18", "pickupLocation": "Test Warehouse", "pickupDate": "2026-10-18",
                                    "pickupTime": "14:00:00", "status": "QUEUED", "pickupId": None, "submittedPackageCount": 0, "message": "Awaiting consolidation"}})
                events = [{"id": "a1", "type": "PAYMENT_RECEIVED", "title": "bank receipt recorded", "at": "2026-10-16T05:00:00Z",
                           "actor": "Riya Finance", "actorEmail": "riya@example.com", "actorRole": "FINANCE", "source": "OMS_UI",
                           "status": "COMPLETED", "note": "Bank receipt recorded.", "amount": 558.32, "reference": "BANK-SETTLEMENT-UTR"}]
                imports = [
                    {"id": 10, "kind": "DELHIVERY_REMITTANCE", "fileName": "single.csv", "rowCount": 1, "matchedCount": 1,
                     "unmatched": [], "uploadedBy": "riya@example.com", "createdAt": "2026-10-16T05:00:00Z",
                     "summary": {"remittanceNumber": "SINGLE-R1", "totalRemittance": 500, "matchedOrders": [
                         {"orderId": 1883, "shopifyOrderName": "#26YOU6061", "waybillNumber": "AWB1", "amount": 500, "utr": None, "remittanceRef": "R1", "status": "DELIVERED"}]}},
                    {"id": 11, "kind": "DELHIVERY_REMITTANCE", "fileName": "mixed.csv", "rowCount": 2, "matchedCount": 2,
                     "unmatched": [], "uploadedBy": "riya@example.com", "createdAt": "2026-10-16T05:00:00Z",
                     "summary": {"remittanceNumber": "MIXED", "state": "Completed", "totalRemittance": 800, "matchedOrders": [
                         {"orderId": 1884, "shopifyOrderName": "#OTHER1", "amount": 300, "utr": "UTR-A", "remittanceRef": "R2"},
                         {"orderId": 1885, "shopifyOrderName": "#OTHER2", "amount": 500, "utr": None, "remittanceRef": "R3"}]}},
                    {"id": 12, "kind": "DELHIVERY_CHARGES", "fileName": "wallet.xlsx", "rowCount": 1, "matchedCount": 1,
                     "unmatched": [], "uploadedBy": "riya@example.com", "createdAt": "2026-10-16T05:00:00Z",
                     "summary": {"remittanceNumber": "WALLET", "totalRemittance": 80, "matchedOrders": [{"orderId": 1883, "amount": 80, "status": "Freight debit"}]}},
                ]
                calls, errors = [], []

                def api(route):
                    req = route.request
                    parsed = urlparse(req.url)
                    path = parsed.path.removeprefix("/api/")
                    body = req.post_data_json if req.post_data else None
                    calls.append((req.method, path, body, parsed.query))
                    if path == "orders/1883":
                        data = {"order": order}
                    elif path == "orders/1883/payment":
                        data = {"payment": order}
                    elif path == "orders/1883/activity":
                        data = {"events": events}
                    elif path == "orders/1883/activity/notes":
                        events.insert(0, {**events[0], "id": "note1", "type": "STAFF_NOTE", "title": "staff note", "note": body["text"], "amount": None, "reference": None})
                        data = {"id": "note1"}
                    elif path == "orders/1883/pickup":
                        order["shipment"]["pickupBatch"].update({"status": "SCHEDULED", "pickupId": "PUR-MOCK", "submittedPackageCount": 2, "message": "Carrier confirmed warehouse pickup."})
                        data = {"success": True, "message": "Warehouse pickup scheduled.", "batch": order["shipment"]["pickupBatch"]}
                    elif path.endswith("/account-trail"):
                        data = {"events": []}
                    elif path == "accounts/overview":
                        data = {"imports": imports, "summary": [{"label": "Orders placed", "value": 3}, {"label": "Received in bank (₹)", "value": 558.32}], "openOrders": [], "recipients": [], "connectors": {}, "reportDay": 8}
                    elif re.match(r"accounts/remittance/\d+/utr", path):
                        record = next(i for i in imports if str(i["id"]) == path.split("/")[2])
                        for item in record["summary"]["matchedOrders"]:
                            if not body.get("orderId") or item["orderId"] == body["orderId"]:
                                item["utr"] = body["utr"]
                        data = {"success": True, "closedNow": 0}
                    elif path == "accounts/import":
                        if not body.get("force"):
                            route.fulfill(status=409, content_type="application/json", body=json.dumps({"code": "DUPLICATE_FILE_ALREADY_UPLOADED", "error": "Duplicate file upload blocked."}))
                            return
                        data = {"matchedCount": 0, "rowCount": 1, "unmatched": [], "notes": ["Existing AWB was not credited twice."]}
                    elif path.startswith("accounts/template/") or path == "accounts/report":
                        route.fulfill(content_type="application/octet-stream", headers={"Content-Disposition": 'attachment; filename="mock-report.xlsx"'}, body="mock")
                        return
                    else:
                        data = {"events": [], "orders": [], "counts": {}, "status": "ok"}
                    route.fulfill(content_type="application/json", body=json.dumps(data))

                context.route("**/api/**", api)
                page = context.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(BASE + "/orders/1883")
                evidence = page.locator(".order-payment-evidence")
                expect(evidence).to_contain_text("CUSTOMER-CHECKOUT-REF")
                expect(evidence).to_contain_text("BANK-SETTLEMENT-UTR")
                expect(evidence).to_contain_text("558.32")
                expect(page.locator(".order-activity-feed")).to_contain_text("Riya Finance")
                page.locator(".order-activity-feed").get_by_role("button", name="Add internal note").click()
                note = "<script>window.noteExecuted=true</script> Staff-only test"
                page.get_by_label("Internal note", exact=True).fill(note)
                page.get_by_role("button", name="Post note").click()
                expect(page.locator(".order-activity-feed")).to_contain_text(note)
                assert page.evaluate("window.noteExecuted") is None
                request = next(c[2] for c in calls if c[1] == "orders/1883/activity/notes")
                assert request["requestId"] and request["text"] == note
                evidence.screenshot(path=str(artifacts / "payment-bank-evidence.png"))
                page.locator(".order-activity-feed").screenshot(path=str(artifacts / "staff-activity.png"))
                page.get_by_role("tab", name="Shipment", exact=True).click()
                expect(page.locator(".order-pickup-status")).to_contain_text("2026-10-18")
                page.get_by_role("button", name="Submit warehouse batch now").click()
                expect(page.locator(".order-pickup-status")).to_contain_text("PUR-MOCK")
                expect(page.get_by_role("button", name="Submit warehouse batch now")).to_have_count(0)
                page.locator(".order-pickup-status").screenshot(path=str(artifacts / "pickup-status.png"))
                page.goto(BASE + "/remittance")
                expect(page.get_by_role("heading", name="Payments & remittance", exact=True)).to_be_visible()
                mixed = page.locator("tr").filter(has=page.get_by_role("button", name="MIXED", exact=True)).first
                expect(mixed).to_contain_text("UTR missing")
                expect(mixed.get_by_role("button", name="Correct UTR", exact=True)).to_be_disabled()
                page.get_by_role("button", name="SINGLE-R1", exact=True).click()
                page.locator(".remittance-order-list").get_by_role("button", name="Correct order UTR").click()
                page.get_by_label("Correct bank UTR").fill("CORRECTED-UTR")
                page.get_by_role("button", name="Save UTR", exact=True).click()
                expect(page.get_by_text("Bank UTR updated; existing amount and settlement date preserved.")).to_be_visible()
                correction = next(c[2] for c in calls if c[0] == "PATCH")
                assert correction == {"utr": "CORRECTED-UTR", "orderId": 1883}
                page.get_by_label("Find a settlement or order").fill("wallet")
                expect(page.locator(".remittance-state")).to_have_text("Reconciled")
                expect(page.get_by_role("button", name="Correct UTR", exact=True)).to_have_count(0)
                page.get_by_label("Find a settlement or order").fill("")
                page.get_by_role("button", name="Import report", exact=True).click()
                with page.expect_download():
                    page.get_by_role("button", name="Download template").click()
                page.get_by_label("Report file").set_input_files({"name": "single.csv", "mimeType": "text/csv", "buffer": b"AWB,Amount\nAWB1,500"})
                page.get_by_role("button", name="Upload & reconcile", exact=True).click()
                expect(page.get_by_text("Duplicate file upload blocked.", exact=True)).to_be_visible()
                page.get_by_role("button", name="Reprocess matching data").click()
                expect(page.get_by_role("status").filter(has_text="Existing AWB was not credited twice.")).to_be_visible()
                uploads = [c[2] for c in calls if c[1] == "accounts/import"]
                assert not uploads[0].get("force") and uploads[1]["force"]
                with page.expect_download():
                    page.get_by_role("button", name="Export Excel").click()
                page.get_by_label("Custom date range").check()
                page.get_by_label("From", exact=True).fill("2026-10-31")
                page.get_by_label("Through", exact=True).fill("2026-10-01")
                expect(page.get_by_role("button", name="Export Excel")).to_be_disabled()
                page.get_by_label("From", exact=True).fill("2026-10-01")
                page.get_by_label("Through", exact=True).fill("2026-10-31")
                page.get_by_role("button", name="Import report", exact=True).click()
                for width in [375, 768, 1440]:
                    page.set_viewport_size({"width": width, "height": 1000})
                    page.wait_for_timeout(250)  # Wait for the existing sidebar CSS transition before capturing.
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), width
                    page.screenshot(path=str(artifacts / f"remittance-{width}.png"))
                page.get_by_role("button", name=re.compile(".*Dark$")).first.click()
                expect(page.locator("html")).to_have_attribute("data-theme", "dark")
                page.wait_for_timeout(250)  # Theme controls use a 150ms color transition.
                page.screenshot(path=str(artifacts / "remittance-dark.png"))
                assert not errors, errors
                browser.close()
                print(f"PASS: separate payment/bank references, staff notes/XSS, pickup evidence, remittance corrections/search/upload/duplicate guard/export and responsive/dark layouts. Screenshots: {artifacts}")
        finally:
            server.terminate()
            server.wait(timeout=15)


if __name__ == "__main__":
    run()
