import { Order, OrderItem } from '@prisma/client';
import { config } from '../../config';
import { isVelocityCourier, normalizeCourierName } from '../../utils/courier';

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  shipment?: any;
}

export class InvoiceService {
  /**
   * Convert number to Indian Rupees in Words
   */
  public numberToWords(amount: number): string {
    const fraction = Math.round((amount % 1) * 100);
    const whole = Math.floor(amount);

    const singleDigits = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const convertChunk = (n: number): string => {
      let str = '';
      if (n >= 100) {
        str += singleDigits[Math.floor(n / 100)] + ' Hundred ';
        n %= 100;
      }
      if (n >= 10 && n <= 19) {
        str += teens[n - 10] + ' ';
      } else if (n >= 20) {
        str += tens[Math.floor(n / 10)] + ' ' + singleDigits[n % 10] + ' ';
      } else if (n > 0) {
        str += singleDigits[n] + ' ';
      }
      return str.trim();
    };

    if (whole === 0 && fraction === 0) return 'Rupees Zero Only';

    let result = '';
    const crore = Math.floor(whole / 10000000);
    const lakh = Math.floor((whole % 10000000) / 100000);
    const thousand = Math.floor((whole % 100000) / 1000);
    const remainder = whole % 1000;

    if (crore > 0) result += convertChunk(crore) + ' Crore ';
    if (lakh > 0) result += convertChunk(lakh) + ' Lakh ';
    if (thousand > 0) result += convertChunk(thousand) + ' Thousand ';
    if (remainder > 0) result += convertChunk(remainder) + ' ';

    result = result.trim() + ' Rupees';

    if (fraction > 0) {
      result += ' and ' + convertChunk(fraction) + ' Paise';
    }

    return result + ' Only';
  }

  /**
   * Map Indian state name to standard 2-digit GST state code
   */
  public getStateCode(state: string): string {
    const s = (state || '').toLowerCase().trim();
    const stateMap: Record<string, string> = {
      'jammu and kashmir': '01',
      'himachal pradesh': '02',
      'punjab': '03',
      'chandigarh': '04',
      'uttarakhand': '05',
      'haryana': '06',
      'delhi': '07',
      'rajasthan': '08',
      'uttar pradesh': '09',
      'bihar': '10',
      'sikkim': '11',
      'arunachal pradesh': '12',
      'nagaland': '13',
      'manipur': '14',
      'mizoram': '15',
      'tripura': '16',
      'meghalaya': '17',
      'assam': '18',
      'west bengal': '19',
      'jharkhand': '20',
      'odisha': '21',
      'chhattisgarh': '22',
      'madhya pradesh': '23',
      'gujarat': '24',
      'daman and diu': '25',
      'dadra and nagar haveli': '26',
      'maharashtra': '27',
      'andhra pradesh': '28',
      'karnataka': '29',
      'goa': '30',
      'lakshadweep': '31',
      'kerala': '32',
      'tamil nadu': '33',
      'puducherry': '34',
      'andaman and nicobar': '35',
      'telangana': '36',
      'ladakh': '38',
    };
    return stateMap[s] || '27';
  }

  /**
   * Generates single GST Tax Invoice HTML for an order formatted strictly for 4x6" (100mm x 150mm) thermal label printers.
   */
  public generateInvoiceHtml(order: OrderWithDetails): string {
    const invoiceNumber = `INV-2026-${order.shopifyOrderNumber || order.id}`;
    const invoiceDate = new Date(order.shopifyCreatedAt || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const destStateCode = this.getStateCode(order.customerState);
    const isIntraState = destStateCode === '24'; // Gujarat seller to Gujarat buyer

    const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
    const totalAmount = order.totalAmount || 0;

    // GST Calculation: Apparels under ₹1000 have 5% GST rate (2.5% CGST + 2.5% SGST or 5% IGST)
    // Inclusive tax breakdown: Taxable = Total / 1.05
    const taxableTotal = Math.round((totalAmount / 1.05) * 100) / 100;
    const taxTotal = Math.round((totalAmount - taxableTotal) * 100) / 100;
    const cgstAmount = isIntraState ? Math.round((taxTotal / 2) * 100) / 100 : 0;
    const sgstAmount = isIntraState ? Math.round((taxTotal - cgstAmount) * 100) / 100 : 0;
    const igstAmount = isIntraState ? 0 : taxTotal;

    const amountInWords = this.numberToWords(totalAmount);

    const waybill = order.shipment?.waybillNumber || '';
    const courierName = order.shipment?.courier || (order as any).courierPartner;
    const isVel = isVelocityCourier(courierName, order.shipment?.labelUrl, waybill);
    const carrierLabel = isVel
      ? 'Velocity'
      : courierName
      ? normalizeCourierName(courierName, order.shipment?.labelUrl, waybill)
      : 'Delhivery';

    const itemsHtml = (order.items || [])
      .map((item, idx) => {
        const itemGross = item.price * item.quantity;
        const itemTaxable = Math.round((itemGross / 1.05) * 100) / 100;
        const itemTax = Math.round((itemGross - itemTaxable) * 100) / 100;
        const titleSnippet = item.title.length > 38 ? `${item.title.substring(0, 36)}…` : item.title;
        return `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td>
            <div class="thermal-item-title">${titleSnippet}</div>
            <div class="thermal-item-meta">${item.variantTitle ? `Size: ${item.variantTitle} · ` : ''}SKU: ${item.sku || 'N/A'}</div>
          </td>
          <td style="text-align: center;">6204</td>
          <td style="text-align: center;"><strong>${item.quantity}</strong></td>
          <td style="text-align: right;">₹${(itemTaxable / item.quantity).toFixed(2)}</td>
          <td style="text-align: center;">5%</td>
          <td style="text-align: right; font-weight: 700;">₹${itemGross.toFixed(2)}</td>
        </tr>`;
      })
      .join('');

    return `
    <div class="invoice-wrapper">
      <div class="invoice-container">
        <!-- 1. Compact Header -->
        <div class="invoice-header">
          <div class="header-left">
            <div class="brand-title">YOUTHNIC</div>
            <div class="legal-name">VB EXPORTS</div>
            <div class="company-details">
              7004, HTC Market-1, Ring Rd, Surat - 395002<br>
              <strong>GSTIN:</strong> 24AAFFV1234P1Z8 (State: 24)<br>
              <strong>Support:</strong> +91 7984984563
            </div>
          </div>
          <div class="header-right">
            <div class="tax-invoice-badge">TAX INVOICE</div>
            <div class="invoice-meta-table">
              <div class="meta-row"><span class="meta-label">Inv No:</span> <strong>${invoiceNumber}</strong></div>
              <div class="meta-row"><span class="meta-label">Date:</span> ${invoiceDate}</div>
              <div class="meta-row"><span class="meta-label">Order:</span> <strong>${order.shopifyOrderName}</strong></div>
              <div class="meta-row"><span class="meta-label">${carrierLabel} AWB:</span> <strong>${waybill || 'Pending AWB'}</strong></div>
            </div>
          </div>
        </div>

        <!-- 2. Customer & Place of Supply Block -->
        <div class="customer-section">
          <div class="customer-box">
            <div class="box-title">SOLD & SHIPPED TO:</div>
            <div class="customer-name">${order.customerName} <span class="customer-phone">· 📞 ${order.customerPhone}</span></div>
            <div class="customer-address">${order.customerAddress}, ${order.customerCity}, ${order.customerState} - ${order.customerPincode}</div>
            <div class="customer-footer-row">
              <span class="supply-state">Place of Supply: <strong>${order.customerState} (${destStateCode})</strong></span>
              <span class="payment-badge-inline ${isCod ? 'cod-mode' : 'prepaid-mode'}">
                ${isCod ? `CASH ON DELIVERY: COLLECT ₹${totalAmount.toFixed(2)}` : 'PREPAID (ONLINE) — DO NOT COLLECT'}
              </span>
            </div>
          </div>
        </div>

        <!-- 3. Items Table -->
        <div class="table-items-wrapper">
          <table class="table-items">
            <thead>
              <tr>
                <th style="width: 14px; text-align: center;">#</th>
                <th>Item Description / SKU</th>
                <th style="width: 28px; text-align: center;">HSN</th>
                <th style="width: 18px; text-align: center;">Qty</th>
                <th style="width: 42px; text-align: right;">Rate</th>
                <th style="width: 24px; text-align: center;">GST</th>
                <th style="width: 48px; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
        </div>

        <!-- 4. Summary & Tax Breakdown -->
        <div class="summary-section">
          <div class="summary-left">
            <div class="tax-breakdown-row">
              <strong>Taxable:</strong> ₹${taxableTotal.toFixed(2)} &nbsp;|&nbsp;
              ${isIntraState ? `<strong>CGST+SGST (5%):</strong> ₹${taxTotal.toFixed(2)}` : `<strong>IGST (5%):</strong> ₹${igstAmount.toFixed(2)}`}
            </div>
            <div class="words-text"><strong>In Words:</strong> ${amountInWords}</div>
          </div>
          <div class="summary-right">
            <div class="grand-total-row">
              <span class="grand-label">INVOICE TOTAL:</span>
              <span class="grand-value">₹${totalAmount.toFixed(2)}</span>
            </div>
          </div>
        </div>

        <!-- 5. Footer & Signatory -->
        <div class="invoice-footer">
          <div class="terms-text">
            Goods covered under Youthnic 7-day hassle-free return/exchange policy.<br>
            Disputes subject to Surat, Gujarat jurisdiction. Computer generated invoice.
          </div>
          <div class="signatory-box">
            <div class="sign-for">For <strong>VB EXPORTS (YOUTHNIC)</strong></div>
            <div class="auth-stamp">AUTHORISED SIGNATORY</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /**
   * Generates a printable single invoice page strictly formatted for 4x6" (100mm x 150mm) thermal printers
   */
  public generatePrintableInvoicePage(order: OrderWithDetails): string {
    const invoiceHtml = this.generateInvoiceHtml(order);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tax Invoice - ${order.shopifyOrderName}</title>
  <style>
    ${this.getInvoiceStyles()}
  </style>
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">GST Commercial Tax Invoice (4x6" Thermal)</span>
      <span class="controls-info">Order: ${order.shopifyOrderName} · Invoice: INV-2026-${order.shopifyOrderNumber || order.id}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print 4x6" Invoice</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${invoiceHtml}
</body>
</html>`;
  }

  /**
   * Generates a bulk printable page for multiple invoices strictly formatted for 4x6" (100mm x 150mm) thermal printers
   */
  public generateBulkPrintableInvoicesPage(orders: OrderWithDetails[]): string {
    const invoicesHtml = orders
      .map((order) => this.generateInvoiceHtml(order))
      .join('<div class="page-break"></div>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bulk Tax Invoices (${orders.length} Orders)</title>
  <style>
    ${this.getInvoiceStyles()}
  </style>
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Bulk GST Tax Invoices (4x6" Thermal)</span>
      <span class="controls-info">Total Invoices: ${orders.length}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print All ${orders.length} Invoices</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${invoicesHtml}
</body>
</html>`;
  }

  public getInvoiceStyles(): string {
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
        background: #0f172a;
        color: #fff;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
      .controls-badge { font-weight: 700; font-size: 13px; color: #38bdf8; display: block; }
      .controls-info { font-size: 11px; color: #94a3b8; }
      .controls-right { display: flex; gap: 8px; }
      .btn {
        cursor: pointer;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        transition: all 0.2s;
      }
      .btn-primary { background: #0284c7; color: #fff; }
      .btn-primary:hover { background: #0369a1; }
      .btn-secondary { background: #334155; color: #fff; }
      .btn-secondary:hover { background: #1e293b; }

      .invoice-wrapper {
        width: 100mm;
        height: 150mm;
        max-height: 150mm;
        background: #fff;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15);
        margin: 0 auto 20px auto;
        overflow: hidden;
        page-break-after: always;
        break-after: page;
        page-break-inside: avoid;
        break-inside: avoid;
      }

      .invoice-container {
        width: 100%;
        height: 100%;
        max-height: 100%;
        border: 2px solid #000;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 2.5mm 3.5mm;
        box-sizing: border-box;
        overflow: hidden;
      }

      /* 1. Header */
      .invoice-header {
        display: flex;
        justify-content: space-between;
        border-bottom: 1.5px solid #000;
        padding-bottom: 4px;
      }
      .header-left {
        flex: 1.2;
      }
      .brand-title {
        font-size: 14px;
        font-weight: 900;
        letter-spacing: 1px;
        color: #000;
        line-height: 1.1;
      }
      .legal-name {
        font-size: 9px;
        font-weight: 800;
        color: #333;
        letter-spacing: 0.5px;
      }
      .company-details {
        font-size: 7.5px;
        color: #222;
        line-height: 1.25;
        margin-top: 2px;
      }

      .header-right {
        flex: 1.1;
        text-align: right;
      }
      .tax-invoice-badge {
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 1px;
        color: #000;
        border: 1px solid #000;
        display: inline-block;
        padding: 1px 6px;
        margin-bottom: 3px;
      }
      .invoice-meta-table {
        font-size: 8px;
        line-height: 1.25;
      }
      .meta-row {
        margin-bottom: 1px;
      }
      .meta-label { color: #444; }

      /* 2. Customer Section */
      .customer-section {
        margin: 3px 0;
      }
      .customer-box {
        border: 1px solid #000;
        padding: 3px 5px;
        font-size: 8px;
        line-height: 1.25;
      }
      .box-title {
        font-size: 7.5px;
        font-weight: 800;
        color: #444;
        letter-spacing: 0.5px;
      }
      .customer-name { font-size: 9.5px; font-weight: 800; color: #000; }
      .customer-phone { font-weight: 700; color: #111; }
      .customer-address { margin-top: 1px; color: #111; }
      .customer-footer-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 2px;
        padding-top: 2px;
        border-top: 0.5px dashed #666;
      }
      .supply-state { font-size: 7.5px; }
      .payment-badge-inline {
        font-size: 8px;
        font-weight: 900;
        padding: 1px 5px;
        border-radius: 3px;
        letter-spacing: 0.2px;
      }
      .prepaid-mode { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
      .cod-mode { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }

      /* 3. Items Table */
      .table-items-wrapper {
        flex: 1;
        overflow: hidden;
        margin: 2px 0;
      }
      .table-items {
        width: 100%;
        border-collapse: collapse;
        font-size: 8px;
        line-height: 1.15;
      }
      .table-items th {
        background: #000;
        color: #fff;
        padding: 2.5px 3px;
        font-weight: 700;
        text-align: left;
        font-size: 7.5px;
      }
      .table-items td {
        padding: 2.5px 3px;
        border-bottom: 0.5px solid #ccc;
        vertical-align: top;
      }
      .thermal-item-title { font-weight: 700; color: #000; }
      .thermal-item-meta { font-size: 7px; color: #555; }

      /* 4. Summary Section */
      .summary-section {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 1.5px solid #000;
        border-bottom: 1.5px solid #000;
        padding: 3px 0;
        margin: 2px 0;
      }
      .summary-left {
        flex: 1.4;
        font-size: 7.5px;
        line-height: 1.25;
      }
      .tax-breakdown-row { color: #111; }
      .words-text { font-size: 7px; color: #333; margin-top: 1px; }
      .summary-right {
        flex: 1;
        text-align: right;
      }
      .grand-total-row {
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 4px;
      }
      .grand-label { font-size: 8.5px; font-weight: 800; color: #000; }
      .grand-value { font-size: 13px; font-weight: 900; color: #000; }

      /* 5. Footer & Signatory */
      .invoice-footer {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        padding-top: 2px;
      }
      .terms-text {
        font-size: 6.5px;
        color: #444;
        line-height: 1.2;
        max-width: 62%;
      }
      .signatory-box {
        text-align: right;
      }
      .sign-for { font-size: 7.5px; color: #222; }
      .auth-stamp {
        display: inline-block;
        border-top: 0.5px dashed #000;
        padding-top: 1px;
        margin-top: 12px;
        font-size: 7px;
        font-weight: 800;
        color: #000;
      }

      .page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
      }

      @media print {
        body { background: #fff !important; padding: 0 !important; margin: 0 !important; }
        .no-print { display: none !important; }
        .invoice-wrapper {
          box-shadow: none !important;
          margin: 0 !important;
          width: 100mm !important;
          height: 150mm !important;
          max-width: 100mm !important;
          max-height: 150mm !important;
          page-break-after: always !important;
          break-after: page !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
          overflow: hidden !important;
        }
        .invoice-container {
          border: 1.5px solid #000 !important;
          box-shadow: none !important;
          margin: 0 !important;
          width: 100% !important;
          height: 100% !important;
          max-height: 100% !important;
          box-sizing: border-box !important;
          overflow: hidden !important;
        }
        @page {
          size: 100mm 150mm;
          margin: 0;
        }
      }
    `;
  }
}

export default new InvoiceService();
