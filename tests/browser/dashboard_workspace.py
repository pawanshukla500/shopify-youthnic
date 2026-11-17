"""Isolated Dashboard UI & pop-up modal checks. Run: python tests/browser/dashboard_workspace.py.

Uses Python Playwright and installed frontend deps with mocked API responses.
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect
from order_detail import BASE, ROOT


STATS_ALL = {
    "success": True,
    "timestamp": "2026-11-17T13:30:00.000Z",
    "period": "all",
    "latestSettlement": {
        "batchId": "PTQXJM2TN3",
        "gateway": "EASEBUZZ",
        "settlementDate": "2026-11-17T00:00:00.000Z",
        "netAmount": 7448.84,
        "grossAmount": 7676.30,
        "feeAmount": 191.91,
        "gstAmount": 34.55,
        "bankUtr": "HDFCH01411242767",
        "orderCount": 6,
        "refundCount": 1,
        "refundAmount": 1,
        "verificationStatus": "UNVERIFIED",
    },
    "carriers": {
        "priority": "DELHIVERY_FIRST",
        "activePriority": "DELHIVERY_FIRST",
        "autoFailover": True,
        "delhivery": {
            "name": "Delhivery Express", "total": 336, "totalShipments": 336,
            "inTransit": 1, "delivered": 286, "ndr": 8, "configured": True, "status": "CONNECTED",
        },
        "velocity": {
            "name": "Velocity Shipping", "total": 320, "totalShipments": 320,
            "inTransit": 23, "delivered": 219, "ndr": 6, "configured": True, "status": "CONNECTED",
        },
    },
    "kpis": {
        "totalRevenue": 815636.86, "totalOrders": 805, "averageOrderValue": 1013.21,
        "prepaidCount": 345, "prepaidRevenue": 360000, "prepaidRatio": 42.8,
        "codCount": 460, "codRevenue": 455636.86, "codRatio": 57.2,
        "readyToDispatch": 3, "prepaidPendingDispatchCount": 2,
        "delayedDispatchCount": 1, "activeShipments": 38, "deliveredCount": 466,
        "ndrExceptions": 19, "totalReturnsCount": 41, "returnRate": 5.09,
        "totalEstimatedLogisticsCost": 96149.62,
    },
    "reconciliation": {
        "delhiveryCod": {
            "orderCount": 460, "totalAmount": 455636.86, "collectedAmount": 320000,
            "remittedAmount": 295000, "pendingRemittance": 25000, "inTransitAmount": 135636.86,
            "settlementChannel": "Delhivery COD", "payoutSchedule": "Weekly (T+4)", "estimatedCodFee": 17480,
        },
        "gokwikPrepaid": {
            "orderCount": 345, "totalAmount": 360000, "verifiedCount": 340, "unverifiedCount": 5,
            "estimatedFees": 7200, "estimatedPayout": 352800,
            "settlementChannel": "GoKwik", "payoutSchedule": "T+1",
        },
        "phonepePrepaid": {
            "orderCount": 0, "totalAmount": 0, "verifiedCount": 0, "unverifiedCount": 0,
            "estimatedFees": 0, "estimatedPayout": 0,
            "settlementChannel": "PhonePe", "payoutSchedule": "T+1",
        },
        "manualPrepaid": {
            "orderCount": 0, "totalAmount": 0, "settlementChannel": "Direct", "payoutSchedule": "Offline",
        },
    },
    "funnel": {
        "intake": {"total": 69, "unverified": 69},
        "warehouse": {"dispatchPending": 3, "dispatched": 35},
        "logistics": {"shipped": 12, "inTransit": 18, "outForDelivery": 8},
        "finalMile": {"delivered": 466, "failedDelivery": 6, "rtoInitiated": 13, "rtoDelivered": 22},
        "returns": {"requested": 1, "dispatched": 0, "received": 0, "refunded": 40},
    },
    "topStates": [
        {"state": "Maharashtra", "orders": 148, "revenue": 152400, "citiesCount": 24, "percentage": 18.4},
        {"state": "Karnataka", "orders": 112, "revenue": 118900, "citiesCount": 14, "percentage": 13.9},
        {"state": "Gujarat", "orders": 94, "revenue": 96200, "citiesCount": 16, "percentage": 11.7},
    ],
    "actionItems": [],
    "recentOrders": [
        {
            "id": 901, "shopifyOrderId": "100901", "shopifyOrderName": "#26YOU7101",
            "customerName": "Ananya Sharma", "customerCity": "Mumbai", "customerState": "Maharashtra",
            "customerPhone": "9876543210", "totalAmount": 1299, "currency": "INR",
            "status": "DISPATCH_PENDING", "paymentGateway": "gokwik", "paymentMethod": "Pre-paid",
            "paymentVerified": True, "salesChannel": "Youthnic <> GoKwik", "itemsCount": 1,
            "waybillNumber": None, "estimatedShippingCost": 92.4, "shippingZone": "Zone B",
            "shippingZoneCode": "B", "createdAt": "2026-11-17T10:10:00Z",
        },
    ],
    "delhiveryStatus": {"tokenConfigured": True, "originPincode": "395002", "originCity": "Surat", "originState": "Gujarat"},
}

DISPATCH_ORDERS = [
    {
        "id": 901, "shopifyOrderId": "100901", "shopifyOrderName": "#26YOU7101",
        "shopifyOrderNumber": 7101, "customerName": "Ananya Sharma", "customerPhone": "9876543210",
        "customerCity": "Mumbai", "customerState": "Maharashtra", "customerPincode": "400001",
        "totalAmount": 1299, "currency": "INR", "paymentMethod": "Pre-paid", "status": "DISPATCH_PENDING",
        "shipment": None,
    },
    {
        "id": 902, "shopifyOrderId": "100902", "shopifyOrderName": "#26YOU7102",
        "shopifyOrderNumber": 7102, "customerName": "Rohan Patel", "customerPhone": "9876543211",
        "customerCity": "Ahmedabad", "customerState": "Gujarat", "customerPincode": "380001",
        "totalAmount": 999, "currency": "INR", "paymentMethod": "COD", "status": "DISPATCH_PENDING",
        "shipment": None,
    },
]

BATCH_DETAIL = {
    "batchId": "PTQXJM2TN3", "gateway": "EASEBUZZ", "settlementDate": "2026-11-17T00:00:00.000Z",
    "grossAmount": 7676.30, "feeAmount": 191.91, "gstAmount": 34.55, "netAmount": 7448.84,
    "bankUtr": "HDFCH01411242767", "orderCount": 6, "refundCount": 1, "refundAmount": 1,
    "settledOrders": [
        {
            "id": 1, "shopifyOrderName": "#26YOU7090", "merchantTrxnId": "MTX_101",
            "easebuzzTrxnId": "EBZ_991", "customerPhone": "9876500001",
            "transactionAmount": 1499.00, "netAmount": 1455.20, "status": "MATCHED",
        },
    ],
    "settledRefunds": [
        {
            "id": 11, "shopifyOrderName": "#26YOU7010", "refundId": "RF_001",
            "refundAmount": 1.00, "settlementAmount": -1.00, "status": "MATCHED",
        },
    ],
}


def run():
    artifacts = Path(os.environ.get("DASHBOARD_UI_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="youthnic-dashboard-ui-"))
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
                context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
                context.route("**/src/context/AuthContext.tsx*", lambda route: route.fulfill(
                    content_type="application/javascript",
                    body="export const AuthProvider=({children})=>children; export const useAuth=()=>"
                         "({isAuthenticated:true,loading:false,user:{name:'Pawan Shukla',avatar:'PS',role:'Admin'},logout:async()=>{}});"))
                context.route("**/src/firebase.ts*", lambda route: route.fulfill(
                    content_type="application/javascript",
                    body="export const auth={currentUser:null}; export const googleProvider={};"))
                context.add_init_script("localStorage.setItem('youthnic_theme','light');")

                errors = []
                api_calls = []
                page = context.new_page()
                page.set_default_timeout(10000)
                page.on("pageerror", lambda err: errors.append(str(err)))

                def handle_api(route):
                    req = route.request
                    parsed = urlparse(req.url)
                    path = parsed.path
                    qs = parse_qs(parsed.query)
                    api_calls.append((req.method, path, qs))

                    if path == "/api/health":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"status": "ok", "timestamp": "2026-11-17T13:30:00Z"}))
                    elif path == "/api/orders/count":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"count": 69}))
                    elif path == "/api/dashboard/stats":
                        period = qs.get("period", ["all"])[0]
                        payload = json.loads(json.dumps(STATS_ALL))
                        payload["period"] = period
                        if period == "today":
                            payload["kpis"]["totalOrders"] = 14
                            payload["kpis"]["totalRevenue"] = 15800.0
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
                    elif path == "/api/orders" and req.method == "GET":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"orders": DISPATCH_ORDERS}))
                    elif path == "/api/orders/901/dispatch" and req.method == "POST":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"success": True, "waybillNumber": "30100810099999", "courier": "Delhivery"}))
                    elif path == "/api/accounts/gateway/batches/PTQXJM2TN3":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(BATCH_DETAIL))
                    elif path == "/api/delhivery/shipping-cost":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"total_amount": 88.5, "charges": {"base": 60}}))
                    else:
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"success": True}))

                page.route("**/logos/**", lambda route: (
                    lambda p: route.fulfill(status=200, path=str(p)) if p.exists() else route.continue_()
                )(ROOT / "frontend/public" / urlparse(route.request.url).path.lstrip("/")))
                page.route("**/api/**", handle_api)
                page.goto(BASE + "/", wait_until="networkidle")

                # 1. Verify header, actual prepaid unshipped count (2, NOT 345), and Period filter
                expect(page.get_by_role("heading", name="Good evening, Pawan.") if "evening" in page.content() else page.locator(".dash-title")).to_be_visible()
                expect(page.locator(".dash-triage-card").nth(1)).to_contain_text("2Prepaid Unshipped")
                expect(page.locator("body")).not_to_contain_text("345 Prepaid")
                page.screenshot(path=str(artifacts / "01-dashboard-light.png"), full_page=True)

                # Switch to Today period tab and verify dynamic update
                page.get_by_role("tab", name="Today").click()
                expect(page.locator(".dash-meta-line")).to_contain_text("14 orders (today)")
                page.get_by_role("tab", name="All Time").click()

                # 2. Click Manifest Pending -> Dispatch Queue Pop-up opens & dispatches inside modal
                page.locator(".dash-triage-card").nth(0).click()
                expect(page.get_by_role("dialog")).to_be_visible()
                expect(page.get_by_role("dialog")).to_contain_text("#26YOU7101")
                page.screenshot(path=str(artifacts / "02-dispatch-popup.png"))
                page.get_by_role("button", name="Dispatch AWB").first.click()
                expect(page.locator(".toast")).to_contain_text("30100810099999")
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog")).to_have_count(0)

                # 3. Click Inspect Batch -> Easebuzz Settlement Pop-up opens
                page.get_by_role("button", name="Inspect Batch").click()
                expect(page.get_by_role("dialog")).to_be_visible()
                expect(page.get_by_role("dialog")).to_contain_text("HDFCH01411242767")
                expect(page.get_by_role("dialog")).to_contain_text("#26YOU7090")
                page.screenshot(path=str(artifacts / "03-settlement-popup.png"))
                page.get_by_role("button", name="Close", exact=True).click()

                # 4. Click Rate Calc -> Rate Estimator Pop-up opens & calculates
                page.get_by_role("button", name="Rate Calc", exact=True).click()
                expect(page.get_by_role("dialog")).to_be_visible()
                page.get_by_role("button", name="Calculate Freight").click()
                expect(page.get_by_role("dialog")).to_contain_text("88.50")
                page.screenshot(path=str(artifacts / "04-rate-popup.png"))
                page.keyboard.press("Escape")

                # 5. Toggle Dark Theme and verify settled dark render
                page.get_by_title("Switch to Dark Theme").click()
                expect(page.locator(".app-shell.theme-dark")).to_be_visible()
                page.wait_for_timeout(300)
                page.screenshot(path=str(artifacts / "05-dashboard-dark.png"), full_page=True)

                assert not errors, f"Page JS errors: {errors}"
                print(json.dumps({"ok": True, "artifacts": str(artifacts), "calls": len(api_calls)}))
        finally:
            server.terminate()


if __name__ == "__main__":
    run()
