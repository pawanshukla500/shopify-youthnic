"""Returns & Reverse Logistics Workspace Playwright Integration Test.
Run: python tests/browser/returns_workspace.py
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
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent.parent
BASE = "http://127.0.0.1:5180"

MOCK_RETURNS = [
    {
        "id": 101,
        "orderId": 2001,
        "returnWaybillNumber": "REV-DEL-888999",
        "returnReason": "Wrong size received",
        "returnStatus": "PICKED_UP",
        "qcStatus": None,
        "qcRemark": None,
        "refundStatus": "NONE",
        "refundAmount": 1499,
        "isExchange": False,
        "pickupAutomatic": True,
        "trackingStatus": "In Transit",
        "trackingLocation": "Surat Hub",
        "forwardWaybill": "301008100111",
        "createdAt": "2026-10-29T10:00:00Z",
        "order": {
            "shopifyOrderName": "#26YOU2001",
            "customerName": "Ramesh Kumar",
            "paymentMethod": "COD",
            "paymentGateway": "Cash on Delivery",
            "financialStatus": "pending",
            "status": "DELIVERED",
            "totalAmount": 1499,
        },
    },
    {
        "id": 102,
        "orderId": 2002,
        "returnWaybillNumber": "REV-VEL-777888",
        "returnReason": "Size replacement request",
        "returnStatus": "DELIVERED",
        "qcStatus": "APPROVED",
        "qcRemark": "Item in pristine condition",
        "refundStatus": "NONE",
        "refundAmount": 0,
        "isExchange": True,
        "pickupAutomatic": True,
        "trackingStatus": "Delivered to Warehouse",
        "trackingLocation": "Surat Warehouse",
        "forwardWaybill": "374645218888",
        "createdAt": "2026-10-28T09:30:00Z",
        "order": {
            "shopifyOrderName": "#26YOU2002",
            "customerName": "Pooja Patel",
            "paymentMethod": "PREPAID",
            "paymentGateway": "Razorpay",
            "financialStatus": "paid",
            "status": "DELIVERED",
            "totalAmount": 2199,
        },
    },
    {
        "id": 103,
        "orderId": 2003,
        "returnWaybillNumber": "REV-DEL-555666",
        "returnReason": "Color faded / damaged",
        "returnStatus": "DELIVERED",
        "qcStatus": "APPROVED",
        "qcRemark": "Verified manufacturing defect",
        "refundStatus": "NONE",
        "refundAmount": 1850,
        "isExchange": False,
        "pickupAutomatic": True,
        "trackingStatus": "Delivered to Warehouse",
        "trackingLocation": "Surat Warehouse",
        "forwardWaybill": "301008100222",
        "createdAt": "2026-10-27T14:15:00Z",
        "order": {
            "shopifyOrderName": "#26YOU2003",
            "customerName": "Suresh Raina",
            "paymentMethod": "COD",
            "paymentGateway": "manual_cod",
            "financialStatus": "pending",
            "status": "DELIVERED",
            "totalAmount": 1850,
        },
    },
    {
        "id": 104,
        "orderId": 2004,
        "returnWaybillNumber": "REV-VEL-111222",
        "returnReason": "Fabric torn",
        "returnStatus": "DELIVERED",
        "qcStatus": "APPROVED",
        "qcRemark": "QC verified",
        "refundStatus": "PROCESSED",
        "refundAmount": 999,
        "isExchange": False,
        "pickupAutomatic": True,
        "trackingStatus": "Delivered",
        "trackingLocation": "Surat Warehouse",
        "forwardWaybill": "374645219999",
        "createdAt": "2026-10-25T11:00:00Z",
        "order": {
            "shopifyOrderName": "#26YOU2004",
            "customerName": "Ananya Sen",
            "paymentMethod": "PREPAID",
            "paymentGateway": "Shopify Payments",
            "financialStatus": "refunded",
            "status": "REFUNDED",
            "totalAmount": 999,
        },
    },
]


def run():
    artifacts = Path(os.environ.get("ORDER_UI_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="returns-workspace-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    checks = []

    with (artifacts / "vite.log").open("w") as log:
        server = subprocess.Popen(
            [
                "node",
                str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
                "--host",
                "127.0.0.1",
                "--port",
                "5180",
                "--strictPort",
            ],
            cwd=ROOT / "frontend",
            stdout=log,
            stderr=subprocess.STDOUT,
        )

        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise RuntimeError(f"Vite exited: {artifacts / 'vite.log'}")
                try:
                    with urllib.request.urlopen(BASE, timeout=1):
                        break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("Vite did not start")

            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                context = browser.new_context(viewport={"width": 1440, "height": 900})

                context.route(
                    "**/src/context/AuthContext.tsx*",
                    lambda route: route.fulfill(
                        content_type="application/javascript",
                        body="export const AuthProvider=({children})=>children; export const useAuth=()=>"
                        "({isAuthenticated:true,loading:false,user:{name:'Test Operator',avatar:'TO',role:'Operations'},logout:async()=>{}});",
                    ),
                )
                context.route(
                    "**/src/firebase.ts*",
                    lambda route: route.fulfill(
                        content_type="application/javascript",
                        body="export const auth={currentUser:null}; export const googleProvider={};",
                    ),
                )
                context.add_init_script("""
                    localStorage.setItem('youthnic_theme','light');
                    window.__opened=[]; window.__copied=[]; window.__confirm=true;
                    window.confirm=()=>window.__confirm;
                    window.open=(url)=>{window.__opened.push(url); return null;};
                """)

                # Route all API calls
                calls = []

                def handle_api(route):
                    url = route.request.url
                    method = route.request.method
                    body = None
                    try:
                        body = route.request.post_data_json
                    except Exception:
                        pass
                    calls.append((method, url, body))

                    if "/api/returns" in url and method == "GET":
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({"returns": MOCK_RETURNS}),
                        )
                    elif "/api/returns/scan" in url and method == "POST":
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({
                                "success": True,
                                "message": f"Package {body.get('waybillNumber')} scanned successfully.",
                                "refundProcessed": False,
                            }),
                        )
                    elif "/refunds/manual" in url and method == "POST":
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({
                                "success": True,
                                "event": {
                                    "id": 999,
                                    "eventType": "REFUND_MANUAL",
                                    "amount": body.get("amount"),
                                    "status": "COMPLETED",
                                    "accountUsed": body.get("accountUsed"),
                                    "externalReference": body.get("externalReference"),
                                },
                            }),
                        )
                    elif "/api/auth/me" in url:
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({"id": 1, "email": "test@youthnic.com", "role": "admin"}),
                        )
                    else:
                        route.fulfill(status=200, content_type="application/json", body="[]")

                context.route("**/api/**", handle_api)

                page = context.new_page()
                page.goto(f"{BASE}/returns")

                # Verify Page Heading & 5 Metric Cards
                expect(page.get_by_role("heading", name="Returns & Refunds")).to_be_visible()
                expect(page.get_by_text("Reverse Logistics & Settlements")).to_be_visible()

                # Check metric counts
                expect(page.locator(".returns-metric-card").nth(0)).to_contain_text("4")  # Total
                expect(page.locator(".returns-metric-card").nth(1)).to_contain_text("1")  # Pending QC
                expect(page.locator(".returns-metric-card").nth(2)).to_contain_text("1")  # COD Due
                expect(page.locator(".returns-metric-card").nth(3)).to_contain_text("1")  # Size Exchanges
                expect(page.locator(".returns-metric-card").nth(4)).to_contain_text("1")  # Settled

                checks.append("5-card metrics ribbon rendered and verified")

                # Test Quick Filter Navigation Tabs
                # Tab 1: COD Refund Due
                page.get_by_role("button", name="COD Refund Due").click()
                expect(page.get_by_text("#26YOU2003")).to_be_visible()
                expect(page.get_by_text("#26YOU2001")).to_have_count(0)
                expect(page.get_by_text("#26YOU2002")).to_have_count(0)
                expect(page.get_by_text("#26YOU2004")).to_have_count(0)

                # Tab 2: Size Exchanges
                page.get_by_role("button", name="Size Exchanges").click()
                expect(page.get_by_text("#26YOU2002")).to_be_visible()
                expect(page.get_by_text("Size Replacement (No Cash Refund)")).to_be_visible()
                expect(page.get_by_text("#26YOU2003")).to_have_count(0)

                # Tab 3: Settled / Refunded
                page.get_by_role("button", name="Settled / Refunded").click()
                expect(page.get_by_text("#26YOU2004")).to_be_visible()
                expect(page.get_by_text("✓ Settled")).to_be_visible()

                # Tab 4: Back to All
                page.get_by_role("button", name="All Returns").click()
                expect(page.get_by_text("#26YOU2001")).to_be_visible()
                expect(page.get_by_text("#26YOU2003")).to_be_visible()

                checks.append("quick filter tabs correctly isolate COD, Exchange, QC, and Settled orders")

                # Test Warehouse Scan Box with Barcode gun Enter key
                waybill_input = page.get_by_placeholder("Scan or enter waybill (press Enter)")
                waybill_input.fill("REV-DEL-888999")
                waybill_input.press("Enter")

                page.wait_for_timeout(500)
                scan_calls = [c for c in calls if "/api/returns/scan" in c[1]]
                assert len(scan_calls) == 1
                assert scan_calls[0][2]["waybillNumber"] == "REV-DEL-888999"
                assert scan_calls[0][2]["qcStatus"] == "APPROVED"
                checks.append("barcode gun Enter key automatically triggers scan intake mutation")

                # Test Manual Refund Modal on COD Refund Due
                page.get_by_role("button", name="Record COD Refund").click()
                expect(page.get_by_role("heading", name="Record Manual COD Refund")).to_be_visible()
                expect(page.get_by_text("Log verified payment payout for order #26YOU2003")).to_be_visible()

                # Validation failure when neither UTR nor evidence provided
                page.get_by_role("button", name="Confirm & Record Refund").click()
                expect(page.get_by_text(re.compile("Payment proof is required"))).to_be_visible()

                # Fill UTR and submit
                page.get_by_label(re.compile("^Payment Reference")).fill("UTR-TEST-SURAT-999")
                page.get_by_role("button", name="Confirm & Record Refund").click()

                page.wait_for_timeout(500)
                payout_calls = [c for c in calls if "/refunds/manual" in c[1]]
                assert len(payout_calls) == 1
                assert payout_calls[0][2]["externalReference"] == "UTR-TEST-SURAT-999"
                assert payout_calls[0][2]["amount"] == 1850

                checks.append("manual COD refund modal validates proof requirement and submits payout record")

                page.screenshot(path=str(artifacts / "returns_workspace_complete.png"))

                browser.close()

            print(json.dumps({"result": "PASS", "checks": checks, "artifacts": str(artifacts)}, indent=2))

        finally:
            server.terminate()
            server.wait()


if __name__ == "__main__":
    run()
