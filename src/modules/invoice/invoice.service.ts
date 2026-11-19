import { Order, OrderItem } from '@prisma/client';
import { config } from '../../config';
import { YOUTHNIC_LOGO_BASE64 } from '../delhivery/label-logos';
import { gstService } from '../accounts/gst.service';

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  shipment?: any;
}

export interface InvoiceLine {
  title: string;
  sku: string;
  hsn: string;
  qty: number;
  amount: number; // qty x unit price, before discount
  discount: number;
  gst: number; // GST included in net
  gstRate: number; // apparel slab for this line's per-piece value after discount
  net: number;
}

export interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: string;
  orderDate: string;
  orderName: string;
  store: string;
  paymentStatus: string;
  isCod: boolean;
  shipTo: { name: string; address: string; city: string; state: string; pincode: string };
  from: { name: string; address: string; gstin: string };
  gstRate: number;
  lines: InvoiceLine[];
  shipping: number;
  otherCharges: number;
  total: number;
  received: number;
  due: number;
  words: string;
}

// Default apparel GST rate and HSN on invoices (prices are GST-inclusive); each line's rate follows the slab.
export const INVOICE_GST_RATE = 5;
export const INVOICE_HSN = '6204';
// Rows that fit on a 4x6" page; the rest are summarised in one line
export const INVOICE_MAX_ROWS = 4;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

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
   * Shared invoice numbers for the HTML and PDF invoices.
   * Order-level discounts aren't stored per item, so they're spread by line value and the lines add up to the order total.
   */
  public buildInvoiceData(order: OrderWithDetails): InvoiceData {
    const fmtDate = (d: Date | string | null | undefined) =>
      new Date(d || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    const items = order.items || [];
    const gross = items.map((i) => round2((i.price || 0) * (i.quantity || 1)));
    const grossTotal = round2(gross.reduce((a, b) => a + b, 0));
    const shipping = round2(order.totalShipping || 0);
    const total = round2(order.totalAmount || 0);
    const discountTotal = Math.max(0, round2(grossTotal + shipping - total));

    let allocated = 0;
    const lines: InvoiceLine[] = items.map((item, idx) => {
      const share = grossTotal > 0
        ? idx === items.length - 1
          ? round2(discountTotal - allocated)
          : round2((discountTotal * gross[idx]) / grossTotal)
        : 0;
      const discount = Math.min(Math.max(share, 0), gross[idx]);
      allocated = round2(allocated + discount);
      const net = round2(gross[idx] - discount);
      const gstRate = gstService.apparelRate(net / (item.quantity || 1), order.shopifyCreatedAt || new Date());
      return {
        title: item.variantTitle && !item.title.includes(item.variantTitle) ? `${item.title} - ${item.variantTitle}` : item.title,
        sku: item.sku || '',
        hsn: INVOICE_HSN,
        qty: item.quantity || 1,
        amount: gross[idx],
        discount,
        gst: round2(net - net / (1 + gstRate / 100)),
        gstRate,
        net,
      };
    });

    const linesNet = round2(lines.reduce((a, l) => a + l.net, 0));
    const otherCharges = Math.max(0, round2(total - shipping - linesNet));
    const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
    const fs = String(order.financialStatus || '').toLowerCase();
    // Refunds are issued separately, so a refunded sale still counts as received on its invoice.
    // No status recorded (older rows): keep the old prepaid = paid assumption.
    const isPaid = ['paid', 'refunded', 'partially_refunded'].includes(fs) || (!fs && !isCod);
    const titleCase = (v: string) => v.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const paymentStatus = isPaid ? (fs && fs !== 'paid' ? titleCase(fs) : 'Paid') : isCod ? 'Cash on Delivery' : titleCase(fs);
    const brand = config.company?.brandName || 'YOUTHNIC';

    return {
      invoiceNumber: `INV-2026-${order.shopifyOrderNumber || order.id}`,
      invoiceDate: fmtDate(order.shopifyCreatedAt),
      orderDate: fmtDate(order.shopifyCreatedAt),
      orderName: order.shopifyOrderName,
      store: brand.charAt(0) + brand.slice(1).toLowerCase(),
      paymentStatus,
      isCod,
      shipTo: {
        name: order.customerName || '',
        address: order.customerAddress || '',
        city: order.customerCity || '',
        state: order.customerState || '',
        pincode: order.customerPincode || '',
      },
      from: {
        name: config.company?.legalName || 'VB EXPORTS',
        address: config.company?.address || '7004, HTC Market-1, Surat, Gujarat - 395002',
        gstin: config.company?.gstin || config.delhivery?.seller?.gstin || '24AERPB8666E1ZB',
      },
      gstRate: lines.reduce((max, l) => Math.max(max, l.gstRate), INVOICE_GST_RATE),
      lines,
      shipping,
      otherCharges,
      total,
      received: isPaid ? total : 0,
      due: isPaid ? 0 : total,
      words: this.numberToWords(total),
    };
  }

  /**
   * Single GST Tax Invoice HTML in the Velocity-style layout, sized for 4x6" (100mm x 150mm) thermal printers.
   */
  public generateInvoiceHtml(order: OrderWithDetails): string {
    const d = this.buildInvoiceData(order);
    const money = (n: number) => `₹${n.toFixed(2)}`;
    const shown = d.lines.slice(0, INVOICE_MAX_ROWS);
    const hidden = d.lines.length - shown.length;

    const rows = shown
      .map((l, idx) => `
          <tr class="inv-row">
            <td class="c">${idx + 1}.</td>
            <td>
              <div class="inv-item inv-clamp2">${esc(l.title)}</div>
              <div class="inv-sub">SKU: ${esc(l.sku)}</div>
              <div class="inv-sub">HSN: ${esc(l.hsn)}</div>
            </td>
            <td class="c">${l.qty}</td>
            <td class="r">${money(l.amount)}</td>
            <td class="r">${l.discount.toFixed(2)}</td>
            <td class="r">${l.gst.toFixed(2)} | ${l.gstRate}%</td>
            <td class="r">${money(l.net)}</td>
          </tr>`)
      .join('');

    const sumRow = (label: string, value: number) =>
      `<tr class="inv-sum"><td colspan="6" class="r">${label}</td><td class="r">${money(value)}</td></tr>`;

    return `
    <div class="invoice-wrapper">
      <div class="invoice-container">
        <div class="inv-head">
          <img class="inv-logo" src="${YOUTHNIC_LOGO_BASE64}" alt="Youthnic">
          <div class="inv-title">Tax Invoice</div>
        </div>

        <div class="inv-meta">
          <div><span>Invoice Date</span><b>${d.invoiceDate}</b></div>
          <div><span>Order No.</span><b>${esc(d.orderName)}</b></div>
          <div><span>Order Date</span><b>${d.orderDate}</b></div>
          <div><span>Invoice No.</span><b>${d.invoiceNumber}</b></div>
          <div><span>Payment Status</span><b>${d.paymentStatus}</b></div>
          <div><span>Store</span><b>${esc(d.store)}</b></div>
        </div>

        <div class="inv-parties">
          <div class="inv-card">
            <div class="inv-card-label">Shipping Address</div>
            <div class="inv-strong">${esc(d.shipTo.name)}</div>
            <div class="inv-clamp3">${esc(d.shipTo.address)}</div>
            <div>${esc(d.shipTo.city)},</div>
            <div>${esc(d.shipTo.state)} ${esc(d.shipTo.pincode)}</div>
          </div>
          <div class="inv-card">
            <div class="inv-card-label">From</div>
            <div>${esc(d.from.name)}</div>
            <div class="inv-clamp3">${esc(d.from.address)}</div>
            <div><b>GSTIN:</b> ${esc(d.from.gstin)}</div>
          </div>
        </div>

        <table class="inv-table">
          <thead>
            <tr>
              <th class="c" style="width:8%">S No.</th>
              <th>Product Name</th>
              <th class="c" style="width:6%">Qty</th>
              <th class="r" style="width:13%">Amount</th>
              <th class="r" style="width:11%">Discount</th>
              <th class="r" style="width:13%">GST</th>
              <th class="r" style="width:13%">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
            ${hidden > 0 ? `<tr class="inv-sum"><td colspan="7">+ ${hidden} more item${hidden > 1 ? 's' : ''} (included in the total)</td></tr>` : ''}
            ${d.shipping > 0 ? sumRow('Shipping', d.shipping) : ''}
            ${d.otherCharges > 0 ? sumRow('Other Charges', d.otherCharges) : ''}
            ${sumRow('Total', d.total)}
            ${sumRow('Payment Received', d.received)}
            ${sumRow('Total Payment Due', d.due)}
            <tr class="inv-words"><td colspan="7"><span>Amount Chargeable (in words)</span><div>INR ${d.words}</div></td></tr>
          </tbody>
        </table>

        <div class="inv-foot">
          This is a computer-generated invoice; no signature is required.<br>
          Unless otherwise stated, tax on this invoice is not payable under reverse charge
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
        display: flex;
        flex-direction: column;
        padding: 4mm 4mm 3mm;
        box-sizing: border-box;
        overflow: hidden;
      }

      .invoice-container * { color: #2b3561; }
      .inv-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5mm; }
      .inv-logo { height: 8mm; width: auto; display: block; }
      .inv-title { font-size: 15px; font-weight: 700; color: #2e3a66; }

      .inv-meta { display: grid; grid-template-columns: repeat(3, 1fr); row-gap: 1.5mm; margin-bottom: 2.5mm; }
      .inv-meta > div { padding: 0 2mm; border-left: 0.5px solid #dfe3ec; line-height: 1.25; }
      .inv-meta > div:nth-child(3n+1) { border-left: none; padding-left: 0; }
      .inv-meta span { display: block; font-size: 6.5px; color: #6b7280; }
      .inv-meta b { display: block; font-size: 8px; font-weight: 500; }

      .inv-parties { display: flex; gap: 2mm; margin-bottom: 2.5mm; }
      .inv-card { flex: 1; background: #f6f7fb; border-radius: 2mm; padding: 1.8mm 2.2mm; font-size: 7px; line-height: 1.3; overflow-wrap: anywhere; }
      .inv-card-label { font-size: 7px; color: #6b7280; }
      .inv-strong { font-weight: 700; }

      .inv-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 6.5px; line-height: 1.3; table-layout: fixed; }
      .inv-table th { background: #3a3e6b; color: #fff; font-weight: 500; padding: 1.2mm 1mm; text-align: left; }
      .inv-table th:first-child { border-top-left-radius: 1.5mm; }
      .inv-table th:last-child { border-top-right-radius: 1.5mm; }
      .inv-table td { padding: 1.2mm 1mm; vertical-align: top; border-bottom: 0.5px solid #e3e6ee; overflow-wrap: anywhere; }
      .inv-table td:first-child { border-left: 0.5px solid #e3e6ee; }
      .inv-table td:last-child { border-right: 0.5px solid #e3e6ee; }
      .inv-table .c { text-align: center; }
      .inv-table .r { text-align: right; }
      .inv-item { font-size: 6.8px; }
      /* Capped so 4 rows + totals always fit on the fixed 4x6" page */
      .inv-clamp2, .inv-clamp3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
      .inv-clamp2 { -webkit-line-clamp: 2; }
      .inv-clamp3 { -webkit-line-clamp: 3; }
      .inv-sub { font-size: 5.5px; color: #6b7280; }
      .inv-words td { font-size: 6.5px; }
      .inv-words span { color: #6b7280; }

      .inv-foot { margin-top: auto; font-size: 5.5px; color: #6b7280; line-height: 1.35; padding-top: 2mm; }

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
          border: none !important;
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
