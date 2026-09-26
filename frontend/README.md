# Atlas OMS admin panel

This is the local React admin interface for the Shopify Order Management System.

## Install and run

1. Start the Express API from the project root on port `3000` (`run.bat` or `npm run dev`).
2. In this directory, install dependencies:

   ```bash
   npm install
   ```

3. Start the Vite frontend:

   ```bash
   npm run dev
   ```

Open <http://localhost:5173>. Vite proxies every `/api/*` request to
`http://localhost:3000`, so the browser never needs a second API origin.

## Pages

- **Dashboard**: operational counts, payment summary, recent orders and sync actions.
- **Orders**: searchable/filterable order table and complete order detail pages.
- **Returns**: warehouse scan/QC flow and refund processing.
- **Tracking**: lookup by waybill with a timeline and raw JSON fallback.
- **Tools**: Delhivery serviceability, TAT and shipping-cost utilities.

This is an internal local tool and intentionally has **no authentication**. Do not
expose it beyond a trusted development network.
