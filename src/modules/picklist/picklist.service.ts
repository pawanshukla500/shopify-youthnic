import { Order, OrderItem, Shipment } from '@prisma/client';

export type OrderWithDetails = Order & {
  items: OrderItem[];
  shipment?: Shipment | null;
};

export interface PicklistSkuItem {
  sku: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  unitPrice: number;
  totalQuantity: number;
  orderCount: number;
  orders: Array<{
    orderId: number;
    orderName: string;
    quantity: number;
    customerName: string;
    city: string;
    state: string;
    paymentMethod: string;
    waybill?: string | null;
  }>;
}

export interface PicklistOrderSummary {
  orderId: number;
  orderName: string;
  customerName: string;
  customerCity: string;
  customerState: string;
  paymentMethod: string;
  totalAmount: number;
  waybillNumber: string | null;
  courier: string | null;
  items: Array<{
    sku: string;
    title: string;
    variantTitle: string | null;
    quantity: number;
    price: number;
  }>;
}

export interface AggregatedPicklist {
  batchId: string;
  generatedAt: string;
  totalOrders: number;
  totalItems: number;
  uniqueSkus: number;
  totalValue: number;
  items: PicklistSkuItem[];
  orders: PicklistOrderSummary[];
}

export class PicklistService {
  /**
   * Aggregate line items across multiple orders into a consolidated picking list.
   * Groups by SKU (or title+variant when SKU is absent) and calculates total quantities,
   * unique SKUs, and per-order breakdowns.
   */
  aggregateOrders(orders: OrderWithDetails[]): AggregatedPicklist {
    const skuMap = new Map<string, PicklistSkuItem>();
    const orderSummaries: PicklistOrderSummary[] = [];

    let totalItems = 0;
    let totalValue = 0;

    for (const order of orders) {
      totalValue += order.totalAmount || 0;
      const orderSummaryItems: PicklistOrderSummary['items'] = [];

      for (const item of order.items) {
        const qty = item.quantity || 1;
        totalItems += qty;

        const normalizedSku = (item.sku || '').trim().toUpperCase() || 'NO-SKU';
        const key = normalizedSku !== 'NO-SKU'
          ? normalizedSku
          : `${item.title.trim().toUpperCase()}|${(item.variantTitle || '').trim().toUpperCase()}`;

        orderSummaryItems.push({
          sku: item.sku || 'NO-SKU',
          title: item.title,
          variantTitle: item.variantTitle,
          quantity: qty,
          price: item.price,
        });

        const existing = skuMap.get(key);
        if (existing) {
          existing.totalQuantity += qty;
          existing.orders.push({
            orderId: order.id,
            orderName: order.shopifyOrderName,
            quantity: qty,
            customerName: order.customerName || 'Customer',
            city: order.customerCity || 'N/A',
            state: order.customerState || 'N/A',
            paymentMethod: order.paymentMethod || 'Prepaid',
            waybill: order.shipment?.waybillNumber,
          });
          existing.orderCount = new Set(existing.orders.map((o) => o.orderId)).size;
        } else {
          skuMap.set(key, {
            sku: item.sku || 'NO-SKU',
            title: item.title,
            variantTitle: item.variantTitle,
            imageUrl: item.imageUrl,
            unitPrice: item.price,
            totalQuantity: qty,
            orderCount: 1,
            orders: [
              {
                orderId: order.id,
                orderName: order.shopifyOrderName,
                quantity: qty,
                customerName: order.customerName || 'Customer',
                city: order.customerCity || 'N/A',
                state: order.customerState || 'N/A',
                paymentMethod: order.paymentMethod || 'Prepaid',
                waybill: order.shipment?.waybillNumber,
              },
            ],
          });
        }
      }

      orderSummaries.push({
        orderId: order.id,
        orderName: order.shopifyOrderName,
        customerName: order.customerName || 'Customer',
        customerCity: order.customerCity || 'N/A',
        customerState: order.customerState || 'N/A',
        paymentMethod: order.paymentMethod || 'Prepaid',
        totalAmount: order.totalAmount,
        waybillNumber: order.shipment?.waybillNumber || null,
        courier: order.shipment?.courier || null,
        items: orderSummaryItems,
      });
    }

    // Sort SKUs alphabetically by SKU code (with NO-SKU at end)
    const sortedItems = Array.from(skuMap.values()).sort((a, b) => {
      if (a.sku === 'NO-SKU') return 1;
      if (b.sku === 'NO-SKU') return -1;
      return a.sku.localeCompare(b.sku);
    });

    const now = new Date();
    const batchId = `PKL-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;

    return {
      batchId,
      generatedAt: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
      totalOrders: orders.length,
      totalItems,
      uniqueSkus: sortedItems.length,
      totalValue,
      items: sortedItems,
      orders: orderSummaries,
    };
  }

  /**
   * Generate high-density, print-ready HTML for the consolidated Picklist.
   */
  generatePicklistHtml(orders: OrderWithDetails[]): string {
    const data = this.aggregateOrders(orders);

    const skuRowsHtml = data.items
      .map(
        (item, index) => `
        <tr class="item-row">
          <td class="col-num">${index + 1}</td>
          <td class="col-checkbox"><div class="checkbox-box"></div></td>
          <td class="col-sku">
            <span class="sku-badge">${item.sku}</span>
          </td>
          <td class="col-desc">
            <div class="item-title">${item.title}</div>
            ${item.variantTitle ? `<div class="item-variant">Variant: ${item.variantTitle}</div>` : ''}
          </td>
          <td class="col-qty">
            <span class="qty-pill">${item.totalQuantity}</span>
          </td>
          <td class="col-orders">
            <div class="orders-summary"><strong>${item.orderCount}</strong> ${item.orderCount === 1 ? 'order' : 'orders'}</div>
            <div class="orders-list">
              ${item.orders
                .map(
                  (o) =>
                    `<span class="order-chip" title="${o.customerName} (${o.city})">${o.orderName} <span class="chip-qty">×${o.quantity}</span></span>`
                )
                .join(' ')}
            </div>
          </td>
        </tr>
      `
      )
      .join('\n');

    const orderBreakdownRowsHtml = data.orders
      .map(
        (o, index) => `
        <tr class="order-ref-row">
          <td>${index + 1}</td>
          <td><strong>${o.orderName}</strong></td>
          <td>${o.customerName}<br><span class="meta-sub">${o.customerCity}, ${o.customerState}</span></td>
          <td>
            ${
              o.waybillNumber
                ? `<span class="awb-badge">${o.waybillNumber}</span>`
                : '<span class="pending-badge">Pending Dispatch</span>'
            }
          </td>
          <td><span class="badge ${o.paymentMethod === 'COD' ? 'badge-cod' : 'badge-prepaid'}">${o.paymentMethod}</span></td>
          <td class="order-items-cell">
            ${o.items
              .map(
                (i) => `
              <div class="order-item-line">
                <span class="line-qty">${i.quantity}x</span>
                <span class="line-sku">${i.sku}</span>
                <span class="line-title">${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ''}</span>
              </div>
            `
              )
              .join('')}
          </td>
          <td class="col-price">₹${o.totalAmount.toFixed(2)}</td>
        </tr>
      `
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Warehouse Master Picklist · ${data.batchId} (${data.totalOrders} Orders)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #f8fafc;
      padding: 24px;
      font-size: 13px;
      line-height: 1.4;
    }
    .picklist-container {
      max-width: 1050px;
      margin: 0 auto;
      background: #ffffff;
      padding: 32px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.06);
      border: 1px solid #e2e8f0;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 18px;
      margin-bottom: 20px;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #0f172a;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-sub {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
      font-weight: 500;
    }
    .header-meta {
      text-align: right;
    }
    .batch-badge {
      display: inline-block;
      background: #0f172a;
      color: #ffffff;
      padding: 4px 10px;
      border-radius: 6px;
      font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .meta-date {
      color: #64748b;
      font-size: 11.5px;
      margin-top: 5px;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 16px;
    }
    .kpi-label {
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 800;
      color: #0f172a;
      margin-top: 2px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #0f172a;
      margin: 28px 0 12px 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 8px;
      border-bottom: 1.5px solid #cbd5e1;
    }
    .section-badge {
      background: #e2e8f0;
      color: #334155;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 12.5px;
    }
    th {
      background: #f1f5f9;
      color: #334155;
      font-weight: 700;
      text-align: left;
      padding: 10px 12px;
      border-top: 1px solid #e2e8f0;
      border-bottom: 2px solid #cbd5e1;
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: middle;
    }
    .item-row:hover { background: #f8fafc; }
    .col-num { width: 32px; color: #94a3b8; font-weight: 600; text-align: center; }
    .col-checkbox { width: 36px; text-align: center; }
    .checkbox-box {
      width: 18px;
      height: 18px;
      border: 2px solid #64748b;
      border-radius: 4px;
      margin: 0 auto;
      background: #ffffff;
    }
    .col-sku { width: 170px; }
    .sku-badge {
      display: inline-block;
      font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
      font-weight: 800;
      font-size: 13px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 4px 8px;
      border-radius: 6px;
      color: #0f172a;
      letter-spacing: 0.3px;
    }
    .col-desc { min-width: 200px; }
    .item-title { font-weight: 600; color: #0f172a; line-height: 1.3; }
    .item-variant { font-size: 11.5px; color: #64748b; margin-top: 2px; }
    .col-qty { width: 90px; text-align: center; }
    .qty-pill {
      display: inline-block;
      font-size: 18px;
      font-weight: 900;
      background: #0f172a;
      color: #ffffff;
      padding: 4px 14px;
      border-radius: 20px;
      min-width: 44px;
      text-align: center;
    }
    .col-orders { width: 340px; }
    .orders-summary { font-size: 11px; color: #475569; margin-bottom: 4px; }
    .orders-list { display: flex; flex-wrap: wrap; gap: 4px; }
    .order-chip {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e40af;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-family: monospace;
      font-weight: 600;
    }
    .chip-qty { color: #dc2626; font-weight: 800; margin-left: 2px; }
    
    /* Order Breakdown Table */
    .order-ref-row td { vertical-align: top; padding: 8px 10px; font-size: 12px; }
    .meta-sub { color: #64748b; font-size: 11px; }
    .awb-badge {
      font-family: monospace;
      font-weight: 700;
      font-size: 11px;
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
      color: #0f172a;
    }
    .pending-badge {
      font-size: 11px;
      color: #b45309;
      background: #fef3c7;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .badge {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .badge-cod { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .badge-prepaid { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
    .order-item-line {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
      font-size: 11.5px;
    }
    .line-qty {
      font-weight: 800;
      color: #0f172a;
      background: #e2e8f0;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
    }
    .line-sku { font-family: monospace; font-weight: 700; color: #2563eb; }
    .line-title { color: #334155; }
    .col-price { text-align: right; font-weight: 700; font-family: monospace; }
    
    /* Footer Sign-off */
    .signoff-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-top: 36px;
      padding-top: 20px;
      border-top: 1.5px dashed #cbd5e1;
    }
    .signoff-box {
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 24px;
    }
    .signoff-label {
      font-size: 11.5px;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Print Controls */
    .print-controls {
      position: fixed;
      top: 20px;
      right: 20px;
      display: flex;
      gap: 10px;
      z-index: 100;
    }
    .btn-print {
      background: #0f172a;
      color: #ffffff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.15);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }
    .btn-print:hover { background: #1e293b; }

    @media print {
      body { background: #ffffff; padding: 0; }
      .picklist-container {
        border: none;
        box-shadow: none;
        padding: 0;
        max-width: 100%;
      }
      .print-controls { display: none; }
      .page-break { page-break-after: always; }
      tr { page-break-inside: avoid; }
      table { page-break-inside: auto; }
    }
  </style>
</head>
<body>
  <div class="print-controls">
    <button class="btn-print" onclick="window.print()">
      🖨️ Print Master Picklist
    </button>
  </div>

  <div class="picklist-container">
    <div class="header-bar">
      <div>
        <div class="brand-title">
          <span>YOUTHNIC</span>
          <span style="font-size:16px; font-weight:600; color:#64748b;">· Warehouse Picklist</span>
        </div>
        <div class="brand-sub">Consolidated SKU picking and batch order packing manifest</div>
      </div>
      <div class="header-meta">
        <div class="batch-badge">${data.batchId}</div>
        <div class="meta-date">Generated: ${data.generatedAt}</div>
      </div>
    </div>

    <!-- Summary KPIs -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Total Orders</div>
        <div class="kpi-value">${data.totalOrders}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Items to Pick</div>
        <div class="kpi-value" style="color:#2563eb;">${data.totalItems}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Unique SKUs</div>
        <div class="kpi-value" style="color:#7c3aed;">${data.uniqueSkus}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Batch Value</div>
        <div class="kpi-value">₹${data.totalValue.toFixed(0)}</div>
      </div>
    </div>

    <!-- Master SKU Aggregation Table -->
    <div class="section-title">
      <span>1. Master SKU Picking Checklist (Aggregated)</span>
      <span class="section-badge">${data.uniqueSkus} unique SKUs · ${data.totalItems} total units</span>
    </div>

    <table>
      <thead>
        <tr>
          <th class="col-num">#</th>
          <th class="col-checkbox">Done</th>
          <th class="col-sku">SKU Code</th>
          <th class="col-desc">Item Description</th>
          <th class="col-qty">Total Qty</th>
          <th class="col-orders">Required In Orders</th>
        </tr>
      </thead>
      <tbody>
        ${skuRowsHtml}
      </tbody>
    </table>

    <div class="page-break"></div>

    <!-- Order-by-Order Breakdown Table -->
    <div class="section-title">
      <span>2. Order-by-Order Packing Reference</span>
      <span class="section-badge">${data.totalOrders} orders</span>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:30px;">#</th>
          <th style="width:110px;">Order #</th>
          <th style="width:160px;">Customer</th>
          <th style="width:130px;">Waybill (AWB)</th>
          <th style="width:80px;">Payment</th>
          <th>Items Breakdown</th>
          <th style="width:90px; text-align:right;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${orderBreakdownRowsHtml}
      </tbody>
    </table>

    <!-- Warehouse Sign-off -->
    <div class="signoff-grid">
      <div class="signoff-box">
        <div class="signoff-label">Picked By (Signature & Date)</div>
      </div>
      <div class="signoff-box">
        <div class="signoff-label">Quality Checked By</div>
      </div>
      <div class="signoff-box">
        <div class="signoff-label">Packed & Manifested By</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }
}

export default new PicklistService();
