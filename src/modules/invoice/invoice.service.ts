import { Order, OrderItem } from '@prisma/client';
import { config } from '../../config';

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
   * Generates single GST Tax Invoice HTML for an order
   */
  public generateInvoiceHtml(order: OrderWithDetails): string {
    const invoiceNumber = `INV-2026-${order.shopifyOrderNumber || order.id}`;
    const invoiceDate = new Date(order.shopifyCreatedAt || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const orderDate = invoiceDate;
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

    const itemsHtml = (order.items || [])
      .map((item, idx) => {
        const itemGross = item.price * item.quantity;
        const itemTaxable = Math.round((itemGross / 1.05) * 100) / 100;
        const itemTax = Math.round((itemGross - itemTaxable) * 100) / 100;
        return `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td>
            <strong>${item.title}</strong>
            ${item.variantTitle ? `<div class="item-meta">Size / Variant: ${item.variantTitle}</div>` : ''}
            <div class="item-meta">SKU: ${item.sku || 'N/A'}</div>
          </td>
          <td style="text-align: center;">6204</td>
          <td style="text-align: center;">${item.quantity}</td>
          <td style="text-align: right;">₹${(itemTaxable / item.quantity).toFixed(2)}</td>
          <td style="text-align: right;">₹${itemTaxable.toFixed(2)}</td>
          <td style="text-align: center;">5%</td>
          <td style="text-align: right;">₹${itemTax.toFixed(2)}</td>
          <td style="text-align: right; font-weight: 700;">₹${itemGross.toFixed(2)}</td>
        </tr>`;
      })
      .join('');

    return `
    <div class="invoice-container">
      <!-- Invoice Header -->
      <div class="invoice-header">
        <div class="header-left">
          <div class="brand-title">YOUTHNIC</div>
          <div class="legal-name">VB EXPORTS</div>
          <div class="company-details">
            7004, Hi-tech Textile Centre (HTC Market - 1),<br>
            Anjana Farm, Near Raghukul Market, Ring Road,<br>
            Surat, Gujarat - 395002<br>
            <strong>GSTIN:</strong> 24AAFFV1234P1Z8 &nbsp;|&nbsp; <strong>State Code:</strong> 24 (Gujarat)<br>
            <strong>Email:</strong> returnorders@vbexports.co.in &nbsp;|&nbsp; <strong>Support:</strong> +91 7984984563
          </div>
        </div>
        <div class="header-right">
          <div class="tax-invoice-badge">TAX INVOICE</div>
          <div class="invoice-meta-table">
            <div class="meta-row">
              <span class="meta-label">Invoice No:</span>
              <span class="meta-value"><strong>${invoiceNumber}</strong></span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Invoice Date:</span>
              <span class="meta-value">${invoiceDate}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Order No:</span>
              <span class="meta-value">${order.shopifyOrderName}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Delhivery AWB:</span>
              <span class="meta-value"><strong>${order.shipment?.waybillNumber || 'Pending AWB'}</strong></span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Place of Supply:</span>
              <span class="meta-value">${order.customerState} (${destStateCode})</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Customer Address & Payment Block -->
      <div class="customer-section">
        <div class="customer-box bill-to">
          <div class="box-title">BILLED TO (BUYER):</div>
          <div class="customer-name">${order.customerName}</div>
          <div class="customer-address">${order.customerAddress}</div>
          <div class="customer-city-state">${order.customerCity}, ${order.customerState} - ${order.customerPincode}</div>
          <div class="customer-phone"><strong>Phone:</strong> ${order.customerPhone}</div>
          <div class="customer-state-code">State Code: ${destStateCode}</div>
        </div>
        <div class="customer-box ship-to">
          <div class="box-title">SHIPPED TO (CONSIGNEE):</div>
          <div class="customer-name">${order.customerName}</div>
          <div class="customer-address">${order.customerAddress}</div>
          <div class="customer-city-state">${order.customerCity}, ${order.customerState} - ${order.customerPincode}</div>
          <div class="customer-phone"><strong>Phone:</strong> ${order.customerPhone}</div>
          <div class="payment-badge-inline ${isCod ? 'cod-mode' : 'prepaid-mode'}">
            ${isCod ? 'PAYMENT: CASH ON DELIVERY (COD)' : 'PAYMENT: PREPAID (ONLINE)'}
          </div>
        </div>
      </div>

      <!-- Items Table -->
      <table class="table-items">
        <thead>
          <tr>
            <th style="width: 25px;">#</th>
            <th>Item Description</th>
            <th style="width: 55px; text-align: center;">HSN</th>
            <th style="width: 35px; text-align: center;">Qty</th>
            <th style="width: 75px; text-align: right;">Unit Price</th>
            <th style="width: 80px; text-align: right;">Taxable Value</th>
            <th style="width: 45px; text-align: center;">Tax Rate</th>
            <th style="width: 65px; text-align: right;">Tax Amount</th>
            <th style="width: 85px; text-align: right;">Total (INR)</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <!-- Summary & Tax Breakdown -->
      <div class="summary-section">
        <div class="words-and-terms">
          <div class="words-title">AMOUNT IN WORDS:</div>
          <div class="words-text"><strong>${amountInWords}</strong></div>

          <div class="tax-breakdown-box">
            <div class="breakdown-title">GST Tax Breakdown:</div>
            <div class="breakdown-content">
              ${
                isIntraState
                  ? `CGST (2.5%): ₹${cgstAmount.toFixed(2)} &nbsp;|&nbsp; SGST (2.5%): ₹${sgstAmount.toFixed(2)} &nbsp;|&nbsp; Total Tax: ₹${taxTotal.toFixed(2)}`
                  : `Integrated GST (IGST 5%): ₹${igstAmount.toFixed(2)} &nbsp;|&nbsp; Total Tax: ₹${taxTotal.toFixed(2)}`
              }
            </div>
          </div>

          <div class="terms-text">
            <strong>Terms & Conditions:</strong><br>
            1. Goods once sold are covered under Youthnic 7-day hassle-free return and exchange policy.<br>
            2. All disputes subject to Surat, Gujarat jurisdiction.<br>
            3. This is a computer generated commercial tax invoice.
          </div>
        </div>

        <div class="totals-table-wrap">
          <table class="totals-table">
            <tr>
              <td>Total Taxable Value:</td>
              <td style="text-align: right;">₹${taxableTotal.toFixed(2)}</td>
            </tr>
            ${
              isIntraState
                ? `<tr>
                    <td>CGST @ 2.5%:</td>
                    <td style="text-align: right;">₹${cgstAmount.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td>SGST @ 2.5%:</td>
                    <td style="text-align: right;">₹${sgstAmount.toFixed(2)}</td>
                  </tr>`
                : `<tr>
                    <td>IGST @ 5.0%:</td>
                    <td style="text-align: right;">₹${igstAmount.toFixed(2)}</td>
                  </tr>`
            }
            <tr>
              <td>Shipping / Courier Charges:</td>
              <td style="text-align: right;">FREE</td>
            </tr>
            <tr class="grand-total-row">
              <td><strong>Invoice Total (INR):</strong></td>
              <td style="text-align: right;"><strong>₹${totalAmount.toFixed(2)}</strong></td>
            </tr>
          </table>

          <div class="signatory-box">
            <div class="sign-for">For <strong>VB EXPORTS (YOUTHNIC)</strong></div>
            <div class="sign-stamp">
              <span class="auth-stamp">AUTHORISED SIGNATORY</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    `;
  }

  /**
   * Generates a printable single invoice page
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
      <span class="controls-badge">GST Commercial Tax Invoice</span>
      <span class="controls-info">Order: ${order.shopifyOrderName} · Invoice: INV-2026-${order.shopifyOrderNumber || order.id}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print Invoice</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${invoiceHtml}
</body>
</html>`;
  }

  /**
   * Generates a bulk printable page for multiple invoices
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
      <span class="controls-badge">Bulk GST Tax Invoices</span>
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
      body { background: #f3f4f6; color: #1e293b; padding: 20px 0; display: flex; flex-direction: column; align-items: center; }

      .no-print {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 210mm;
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

      .invoice-container {
        width: 210mm;
        min-height: 280mm;
        background: #fff;
        padding: 14mm 16mm;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15);
        margin: 0 auto 20px auto;
        border: 1px solid #cbd5e1;
      }

      .invoice-header {
        display: flex;
        justify-content: space-between;
        border-bottom: 2px solid #0f172a;
        padding-bottom: 12px;
      }
      .brand-title {
        font-size: 24px;
        font-weight: 900;
        letter-spacing: 2px;
        color: #0f172a;
      }
      .legal-name {
        font-size: 13px;
        font-weight: 700;
        color: #64748b;
        letter-spacing: 1px;
      }
      .company-details {
        font-size: 11px;
        color: #334155;
        line-height: 1.4;
        margin-top: 5px;
      }

      .header-right {
        text-align: right;
      }
      .tax-invoice-badge {
        font-size: 18px;
        font-weight: 900;
        letter-spacing: 1.5px;
        color: #0f172a;
        background: #f1f5f9;
        display: inline-block;
        padding: 4px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        margin-bottom: 8px;
      }
      .invoice-meta-table {
        font-size: 11px;
        text-align: right;
      }
      .meta-row {
        margin-bottom: 3px;
      }
      .meta-label { color: #64748b; margin-right: 6px; }
      .meta-value { color: #0f172a; }

      .customer-section {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin: 14px 0;
      }
      .customer-box {
        flex: 1;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        border-radius: 6px;
        padding: 10px 12px;
        font-size: 11px;
        line-height: 1.4;
      }
      .box-title {
        font-size: 10px;
        font-weight: 800;
        color: #64748b;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .customer-name { font-size: 13px; font-weight: 800; color: #0f172a; }
      .customer-address { margin-top: 3px; }
      .customer-city-state { font-weight: 600; margin-top: 2px; }
      .customer-phone { margin-top: 2px; }
      .payment-badge-inline {
        margin-top: 6px;
        display: inline-block;
        font-size: 10px;
        font-weight: 800;
        padding: 2px 8px;
        border-radius: 4px;
      }
      .prepaid-mode { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
      .cod-mode { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

      .table-items {
        width: 100%;
        border-collapse: collapse;
        margin: 14px 0;
        font-size: 11px;
      }
      .table-items th {
        background: #0f172a;
        color: #fff;
        padding: 6px 8px;
        font-weight: 700;
        text-align: left;
      }
      .table-items td {
        padding: 8px;
        border-bottom: 1px solid #e2e8f0;
        vertical-align: top;
      }
      .item-meta { font-size: 10px; color: #64748b; margin-top: 2px; }

      .summary-section {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        margin-top: 10px;
      }
      .words-and-terms {
        flex: 1.2;
        font-size: 11px;
      }
      .words-title { font-size: 10px; font-weight: 700; color: #64748b; }
      .words-text { font-size: 12px; color: #0f172a; margin-top: 2px; padding: 4px 8px; background: #f8fafc; border-left: 3px solid #0284c7; }
      
      .tax-breakdown-box {
        margin-top: 10px;
        padding: 6px 8px;
        background: #f1f5f9;
        border-radius: 4px;
        font-size: 10.5px;
      }
      .breakdown-title { font-weight: 700; color: #475569; }
      .breakdown-content { margin-top: 2px; font-weight: 600; color: #0f172a; }

      .terms-text {
        margin-top: 12px;
        font-size: 10px;
        color: #64748b;
        line-height: 1.4;
      }

      .totals-table-wrap {
        flex: 0.9;
      }
      .totals-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11.5px;
      }
      .totals-table td {
        padding: 4px 6px;
      }
      .grand-total-row td {
        border-top: 2px solid #0f172a;
        border-bottom: 2px solid #0f172a;
        padding: 6px;
        font-size: 13px;
        color: #0f172a;
      }

      .signatory-box {
        margin-top: 25px;
        text-align: right;
      }
      .sign-for { font-size: 11px; color: #334155; }
      .sign-stamp {
        margin-top: 25px;
      }
      .auth-stamp {
        display: inline-block;
        border-top: 1px dashed #475569;
        padding-top: 4px;
        font-size: 10px;
        font-weight: 700;
        color: #475569;
      }

      .page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
      }

      @media print {
        body { background: #fff; padding: 0; }
        .no-print { display: none !important; }
        .invoice-container {
          box-shadow: none;
          margin: 0;
          border: none;
          page-break-after: always;
          break-after: page;
        }
        @page {
          size: A4 portrait;
          margin: 10mm;
        }
      }
    `;
  }
}

export default new InvoiceService();
