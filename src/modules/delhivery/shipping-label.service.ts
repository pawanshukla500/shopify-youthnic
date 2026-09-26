import { Order, OrderItem } from '@prisma/client';
import { generateCode128Svg } from './barcode';
import { config } from '../../config';

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  shipment?: any;
}

export class ShippingLabelService {
  /**
   * Derive a destination routing hub sort code based on pincode / state
   */
  private getSortCode(pincode: string, city: string, state: string): string {
    const pin = (pincode || '').trim();
    const c = (city || '').toUpperCase();
    if (pin.startsWith('411') || c.includes('PUNE')) return 'PUN / SDW';
    if (pin.startsWith('400') || c.includes('MUMBAI')) return 'BOM / WST';
    if (pin.startsWith('380') || c.includes('AHMEDABAD')) return 'AMD / CGH';
    if (pin.startsWith('395') || c.includes('SURAT')) return 'SRT / GCI';
    if (pin.startsWith('110') || c.includes('DELHI')) return 'DEL / OBN';
    if (pin.startsWith('560') || c.includes('BANGALORE')) return 'BLR / HSR';
    if (pin.startsWith('500') || c.includes('HYDERABAD')) return 'HYD / BEG';
    if (pin.startsWith('600') || c.includes('CHENNAI')) return 'MAA / AMB';
    if (pin.startsWith('700') || c.includes('KOLKATA')) return 'CCU / SAL';
    if (pin.startsWith('302') || c.includes('JAIPUR')) return 'JAI / MNS';
    if (pin.startsWith('226') || c.includes('LUCKNOW')) return 'LKO / ALM';
    if (pin.startsWith('160') || c.includes('CHANDIGARH')) return 'IXC / CHD';
    const prefix = pin.substring(0, 3) || '000';
    return `DEL / ${prefix}`;
  }

  /**
   * Format Indian Phone
   */
  private formatPhone(phone: string): string {
    const clean = (phone || '').replace(/\D/g, '');
    if (clean.length === 12 && clean.startsWith('91')) {
      return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
    }
    if (clean.length === 10) {
      return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`;
    }
    return phone || 'N/A';
  }

  /**
   * Generates single 4x6" (100mm x 150mm) Delhivery thermal shipping label HTML
   */
  public generateSingleLabelHtml(order: OrderWithDetails, waybillNumber: string): string {
    const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
    const totalAmount = order.totalAmount || 0;
    const sortCode = this.getSortCode(order.customerPincode, order.customerCity, order.customerState);
    const barcodeSvg = generateCode128Svg(waybillNumber, { width: 330, height: 75 });
    const orderBarcodeSvg = generateCode128Svg(order.shopifyOrderName.replace('#', ''), { width: 200, height: 45, textBelow: order.shopifyOrderName });
    const formattedDate = new Date(order.shopifyCreatedAt || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

    const itemsRows = (order.items || [])
      .map(
        (item, idx) =>
          `<tr>
            <td style="padding: 2px 4px; font-size: 10px; font-weight: 600;">${idx + 1}</td>
            <td style="padding: 2px 4px; font-size: 10px; font-weight: 600;">${item.sku || 'N/A'}</td>
            <td style="padding: 2px 4px; font-size: 10px;">${item.title.substring(0, 32)}${item.title.length > 32 ? '...' : ''} ${item.variantTitle ? '(' + item.variantTitle + ')' : ''}</td>
            <td style="padding: 2px 4px; font-size: 10px; text-align: center; font-weight: 700;">${item.quantity}</td>
          </tr>`
      )
      .join('');

    return `
    <div class="label-wrapper">
      <div class="label-container">
        <!-- Top Header: Delhivery Courier & Routing Sort Code -->
        <div class="label-row header-row">
          <div class="header-courier">
            <span class="courier-brand">DELHIVERY</span>
            <span class="shipping-mode">SURFACE EXPRESS</span>
          </div>
          <div class="header-sort-code">
            <span class="sort-title">ROUTING HUB</span>
            <span class="sort-value">${sortCode}</span>
          </div>
        </div>

        <!-- Waybill Barcode -->
        <div class="label-row barcode-row">
          <div class="barcode-title">DELHIVERY WAYBILL / AWB</div>
          <div class="barcode-graphic">${barcodeSvg}</div>
        </div>

        <!-- Order & Package Metadata Row -->
        <div class="label-row meta-row">
          <div class="meta-col">
            <span class="meta-label">ORDER NUMBER</span>
            <span class="meta-val">${order.shopifyOrderName}</span>
          </div>
          <div class="meta-col">
            <span class="meta-label">DATE</span>
            <span class="meta-val">${formattedDate}</span>
          </div>
          <div class="meta-col">
            <span class="meta-label">WEIGHT</span>
            <span class="meta-val">0.40 Kg</span>
          </div>
          <div class="meta-col">
            <span class="meta-label">PKGS</span>
            <span class="meta-val">1 / 1</span>
          </div>
        </div>

        <!-- Payment Mode Banner -->
        <div class="label-row payment-banner ${isCod ? 'cod-banner' : 'prepaid-banner'}">
          ${
            isCod
              ? `<div class="banner-title">CASH ON DELIVERY (COD)</div>
                 <div class="banner-amount">COLLECT CASH: ₹${totalAmount.toFixed(2)}</div>`
              : `<div class="banner-title">PREPAID SHIPMENT</div>
                 <div class="banner-amount">DO NOT COLLECT CASH (PAID: ₹${totalAmount.toFixed(2)})</div>`
          }
        </div>

        <!-- Shipping Address (Consignee) -->
        <div class="label-row address-row">
          <div class="address-header">DELIVER TO (CONSIGNEE):</div>
          <div class="consignee-name">${order.customerName}</div>
          <div class="consignee-address">${order.customerAddress}</div>
          <div class="consignee-city-state">
            ${order.customerCity.toUpperCase()}, ${order.customerState.toUpperCase()}
          </div>
          <div class="consignee-pincode-box">
            PINCODE: <span class="huge-pincode">${order.customerPincode}</span>
          </div>
          <div class="consignee-phone">
            <strong>PHONE:</strong> ${this.formatPhone(order.customerPhone)}
          </div>
        </div>

        <!-- Return / Seller Origin Box -->
        <div class="label-row return-row">
          <div class="return-title">IF UNDELIVERED, RETURN TO:</div>
          <div class="return-name"><strong>${config.delhivery.seller.name}</strong> (VB Exports)</div>
          <div class="return-address">${config.delhivery.seller.address}, ${config.delhivery.seller.city}, ${config.delhivery.seller.state} - ${config.delhivery.seller.pincode}</div>
          <div class="return-phone">Helpline: ${this.formatPhone(config.delhivery.seller.phone)} | GSTIN: 24AAFFV1234P1Z8</div>
        </div>

        <!-- Product Contents Table -->
        <div class="label-row items-row">
          <table class="items-table">
            <thead>
              <tr>
                <th style="width: 20px;">#</th>
                <th style="width: 100px;">SKU</th>
                <th>Item Description</th>
                <th style="width: 30px;">Qty</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows}
            </tbody>
          </table>
        </div>

        <!-- Footer Order Barcode & Verification -->
        <div class="label-row footer-row">
          <div class="order-barcode-wrap">
            ${orderBarcodeSvg}
          </div>
          <div class="footer-note">
            Standard Delhivery B2C Surface Manifest · Pack & Ship
          </div>
        </div>
      </div>
    </div>
    `;
  }

  /**
   * Generates a complete standalone printable page for a single label
   */
  public generatePrintableLabelPage(order: OrderWithDetails, waybillNumber: string): string {
    const labelHtml = this.generateSingleLabelHtml(order, waybillNumber);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Delhivery Shipping Label - ${order.shopifyOrderName} (${waybillNumber})</title>
  <style>
    ${this.getLabelStyles()}
  </style>
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Delhivery 4R Thermal Shipping Label</span>
      <span class="controls-info">Order: ${order.shopifyOrderName} · AWB: ${waybillNumber}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print Label</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${labelHtml}
</body>
</html>`;
  }

  /**
   * Generates a complete multi-label printable document for bulk orders
   */
  public generateBulkPrintableLabelsPage(orderList: Array<{ order: OrderWithDetails; waybillNumber: string }>): string {
    const labelsHtml = orderList
      .map(({ order, waybillNumber }) => this.generateSingleLabelHtml(order, waybillNumber))
      .join('<div class="page-break"></div>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bulk Delhivery Shipping Labels (${orderList.length} Orders)</title>
  <style>
    ${this.getLabelStyles()}
  </style>
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Bulk Delhivery 4R Shipping Labels</span>
      <span class="controls-info">Total Packages: ${orderList.length}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print All ${orderList.length} Labels</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${labelsHtml}
</body>
</html>`;
  }

  private getLabelStyles(): string {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      body { background: #f3f4f6; color: #000; padding: 20px 0; display: flex; flex-direction: column; align-items: center; }
      
      .no-print {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100mm;
        max-width: 95vw;
        margin-bottom: 16px;
        padding: 10px 16px;
        background: #1e293b;
        color: #fff;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
      .controls-badge { font-weight: 700; font-size: 13px; color: #38bdf8; display: block; }
      .controls-info { font-size: 11px; color: #94a3b8; }
      .controls-right { display: flex; gap: 8px; }
      .btn {
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        transition: all 0.2s;
      }
      .btn-primary { background: #0284c7; color: #fff; }
      .btn-primary:hover { background: #0369a1; }
      .btn-secondary { background: #475569; color: #fff; }
      .btn-secondary:hover { background: #334155; }

      .label-wrapper {
        width: 100mm;
        height: 150mm;
        background: #fff;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15);
        margin: 0 auto 20px auto;
        overflow: hidden;
      }
      .label-container {
        width: 100%;
        height: 100%;
        border: 2px solid #000;
        display: flex;
        flex-direction: column;
        padding: 4mm 5mm;
        box-sizing: border-box;
      }
      .label-row {
        border-bottom: 1.5px solid #000;
        padding: 4px 0;
      }
      
      .header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 5px;
      }
      .courier-brand {
        font-size: 19px;
        font-weight: 900;
        letter-spacing: 1.5px;
        color: #000;
        display: block;
      }
      .shipping-mode {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1px;
        background: #000;
        color: #fff;
        padding: 1px 5px;
        border-radius: 2px;
      }
      .header-sort-code {
        text-align: right;
        border: 1.5px solid #000;
        padding: 2px 6px;
        background: #fafafa;
      }
      .sort-title { font-size: 8px; font-weight: 700; display: block; color: #555; }
      .sort-value { font-size: 16px; font-weight: 900; letter-spacing: 1px; color: #000; }

      .barcode-row {
        text-align: center;
        padding: 4px 0;
      }
      .barcode-title {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.5px;
        margin-bottom: 2px;
      }
      .barcode-graphic {
        display: flex;
        justify-content: center;
      }

      .meta-row {
        display: flex;
        justify-content: space-between;
        background: #f8fafc;
        padding: 3px 6px;
      }
      .meta-col { text-align: center; }
      .meta-label { font-size: 7.5px; font-weight: 700; color: #64748b; display: block; }
      .meta-val { font-size: 11px; font-weight: 800; color: #000; }

      .payment-banner {
        text-align: center;
        padding: 5px 4px;
        margin: 2px 0;
      }
      .prepaid-banner {
        background: #000;
        color: #fff;
      }
      .prepaid-banner .banner-title { font-size: 11px; font-weight: 900; letter-spacing: 1px; }
      .prepaid-banner .banner-amount { font-size: 13px; font-weight: 800; }

      .cod-banner {
        background: #ffffff;
        color: #000;
        border: 2px dashed #000;
      }
      .cod-banner .banner-title { font-size: 11px; font-weight: 900; letter-spacing: 1px; color: #b91c1c; }
      .cod-banner .banner-amount { font-size: 14px; font-weight: 900; color: #000; }

      .address-row {
        padding: 5px 0;
        flex-grow: 1;
      }
      .address-header { font-size: 8px; font-weight: 800; letter-spacing: 0.5px; color: #475569; }
      .consignee-name { font-size: 14px; font-weight: 800; text-transform: uppercase; margin-top: 1px; }
      .consignee-address { font-size: 10.5px; line-height: 1.25; margin-top: 2px; }
      .consignee-city-state { font-size: 11px; font-weight: 700; margin-top: 2px; }
      .consignee-pincode-box {
        margin-top: 3px;
        font-size: 11px;
        font-weight: 700;
      }
      .huge-pincode {
        font-size: 17px;
        font-weight: 900;
        letter-spacing: 1.5px;
        background: #000;
        color: #fff;
        padding: 1px 6px;
        display: inline-block;
      }
      .consignee-phone { font-size: 10.5px; margin-top: 3px; }

      .return-row {
        background: #f8fafc;
        padding: 4px;
        font-size: 8.5px;
        line-height: 1.2;
      }
      .return-title { font-size: 7.5px; font-weight: 800; color: #64748b; }

      .items-row {
        padding: 2px 0;
        max-height: 25mm;
        overflow: hidden;
      }
      .items-table {
        width: 100%;
        border-collapse: collapse;
      }
      .items-table th {
        font-size: 8px;
        text-align: left;
        background: #e2e8f0;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
      }
      .items-table td {
        border: 1px solid #e2e8f0;
      }

      .footer-row {
        border-bottom: none;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 4px;
      }
      .order-barcode-wrap { width: 55%; }
      .footer-note { font-size: 7.5px; font-weight: 600; color: #64748b; text-align: right; width: 42%; }

      .page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
      }

      @media print {
        body { background: #fff; padding: 0; }
        .no-print { display: none !important; }
        .label-wrapper {
          box-shadow: none;
          margin: 0;
          page-break-after: always;
          break-after: page;
        }
        @page {
          size: 100mm 150mm;
          margin: 0;
        }
      }
    `;
  }
}

export default new ShippingLabelService();
