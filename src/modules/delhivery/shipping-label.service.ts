import { Order, OrderItem } from '@prisma/client';
import { generateCode128Svg } from './barcode';
import { config } from '../../config';
import { YOUTHNIC_LOGO_BASE64, DELHIVERY_LOGO_BASE64 } from './label-logos';
import invoiceService from '../invoice/invoice.service';
import { isVelocityCourier } from '../../utils/courier';

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  shipment?: any;
}

export interface PrintableLabelItem {
  order: OrderWithDetails;
  waybillNumber: string;
  pdfBuffer?: Buffer | null;
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
   * Generates single 4x6" (100mm x 150mm) thermal shipping label HTML.
   * Dynamically renders carrier-authentic branding (Amazon Transportation,
   * Velocity, Blue Dart, Ekart, or Delhivery). Never hardcodes Delhivery onto
   * Velocity / Amazon parcels.
   */
  public generateSingleLabelHtml(order: OrderWithDetails, waybillNumber: string): string {
    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
    const courierRaw = (order.shipment?.courier || '').trim();
    const isAmazon =
      isVelocity &&
      (/amazon|ats/i.test(courierRaw) ||
        /labels\/amazon/i.test(order.shipment?.labelUrl || ''));
    const isBlueDart = isVelocity && /bluedart|blue dart/i.test(courierRaw);
    const isEkart = isVelocity && /ekart/i.test(courierRaw);

    const isCod = order.paymentMethod === 'COD' || order.shipment?.paymentMode === 'COD';
    const totalAmount = order.totalAmount || 0;

    const city = (order.customerCity || 'City').trim();
    const state = (order.customerState || (order as any).customerProvince || 'State').trim();

    const sortCode = isVelocity
      ? isAmazon
        ? `AMZN / ${order.customerPincode}`
        : isBlueDart
          ? `BLUEDART / ${order.customerPincode}`
          : isEkart
            ? `EKART / ${order.customerPincode}`
            : `VEL / ${order.customerPincode}`
      : this.getSortCode(order.customerPincode, city, state);

    const barcodeSvg = generateCode128Svg(waybillNumber, { width: 330, height: 68 });
    const orderBarcodeSvg = generateCode128Svg(order.shopifyOrderName.replace('#', ''), {
      width: 170,
      height: 38,
      textBelow: order.shopifyOrderName.replace('#', ''),
    });
    const formattedDate = new Date(order.shopifyCreatedAt || Date.now()).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const currentTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

    let carrierBadgeHtml: string;
    if (isAmazon) {
      carrierBadgeHtml = `
        <div class="carrier-badge carrier-amazon">
          <div class="amazon-wordmark">
            <span class="amz-text">amazon</span>
            <svg class="amz-smile" viewBox="0 0 100 24" width="68" height="15">
              <path d="M5 14 Q50 28 95 6" stroke="#000" stroke-width="4.5" fill="none" stroke-linecap="round"/>
              <path d="M85 3 L96 7 L93 17 Z" fill="#000"/>
            </svg>
          </div>
          <div class="carrier-sub-text">transportation services</div>
        </div>
      `;
    } else if (isBlueDart) {
      carrierBadgeHtml = `
        <div class="carrier-badge carrier-bluedart">
          <div class="bluedart-wordmark">BLUE DART</div>
          <div class="carrier-sub-text">apex express</div>
        </div>
      `;
    } else if (isEkart) {
      carrierBadgeHtml = `
        <div class="carrier-badge carrier-ekart">
          <div class="ekart-wordmark">ekart</div>
          <div class="carrier-sub-text">logistics</div>
        </div>
      `;
    } else if (isVelocity) {
      carrierBadgeHtml = `
        <div class="carrier-badge carrier-velocity">
          <div class="velocity-wordmark">⚡ VELOCITY</div>
          <div class="carrier-sub-text">shipping network</div>
        </div>
      `;
    } else {
      carrierBadgeHtml = `<img src="${DELHIVERY_LOGO_BASE64}" alt="Delhivery" class="delhivery-logo-img" />`;
    }

    const itemsRows = (order.items || [])
      .map(
        (item) =>
          `<tr>
            <td class="col-prod">
              <span class="item-title">${item.title.substring(0, 40)}${item.title.length > 40 ? '...' : ''}</span>
              ${item.variantTitle ? `<span class="item-variant">(${item.variantTitle})</span>` : ''}
              ${item.sku ? `<span class="item-sku">SKU: ${item.sku}</span>` : ''}
            </td>
            <td class="col-qty">${item.quantity}</td>
            <td class="col-price">${item.price.toFixed(2)}</td>
            <td class="col-total">${(item.price * item.quantity).toFixed(2)}</td>
          </tr>`
      )
      .join('');

    return `
    <div class="label-wrapper">
      <div class="label-container">
        <!-- 1. Header: Youthnic Brand & Official Carrier Badge -->
        <div class="label-row header-row">
          <div class="header-left">
            <span class="seller-org">V B EXPORT</span>
            <div class="brand-logo-wrap">
              <img src="${YOUTHNIC_LOGO_BASE64}" alt="Youthnic" class="youthnic-logo-img" />
            </div>
          </div>
          <div class="header-right">
            ${carrierBadgeHtml}
          </div>
        </div>

        <!-- 2. AWB Barcode & Destination Hub Row -->
        <div class="label-row barcode-row">
          <div class="awb-number-top">AWB# ${waybillNumber}</div>
          <div class="awb-barcode-wrap">${barcodeSvg}</div>
          <div class="awb-sub-meta">
            <span class="meta-dest-pin">${order.customerPincode}</span>
            <span class="meta-center-awb">AWB# ${waybillNumber}</span>
            <span class="meta-sort-hub">${sortCode}</span>
          </div>
        </div>

        <!-- 3. Consignee (Ship to) & Payment Information (Split 2-Column Grid) -->
        <div class="label-row split-row mid-row">
          <div class="split-col-left consignee-col">
            <div class="ship-to-header">Ship to - <strong class="consignee-name">${order.customerName}</strong></div>
            <div class="consignee-addr">${order.customerAddress}</div>
            <div class="consignee-geo"><strong>${city.toUpperCase()} (${state.toUpperCase()})</strong></div>
            <div class="consignee-pin"><strong>PIN - ${order.customerPincode}</strong></div>
            <div class="consignee-phone">Phone: ${this.formatPhone(order.customerPhone)}</div>
          </div>
          <div class="split-col-right payment-col">
            <div class="pay-mode-line"><strong>${isCod ? 'COD - Surface' : 'Pre-paid - Surface'}</strong></div>
            <div class="pay-amount-line"><strong>INR ${totalAmount.toFixed(2)}</strong></div>
            ${
              isCod
                ? `<div class="cod-action-pill">COLLECT CASH</div>`
                : `<div class="prepaid-action-pill">DO NOT COLLECT CASH</div>`
            }
            <div class="date-block">
              <div class="date-label">Date</div>
              <div class="date-val">${formattedDate} | ${currentTime}</div>
            </div>
          </div>
        </div>

        <!-- 4. Seller & Order Barcode Row (Split 2-Column Grid) -->
        <div class="label-row split-row seller-order-row">
          <div class="split-col-left seller-col">
            <div class="seller-header">Seller: <strong>Youthnic</strong></div>
            <div class="seller-addr-text">
              7004, Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat, Gujarat - 395002
            </div>
          </div>
          <div class="split-col-right order-barcode-col">
            <div class="order-code-top">${order.shopifyOrderName.replace('#', '')}</div>
            <div class="order-barcode-svg">${orderBarcodeSvg}</div>
          </div>
        </div>

        <!-- 5. Product Contents Table -->
        <div class="label-row items-row">
          <table class="items-table">
            <thead>
              <tr>
                <th style="width: 58%;">Product Name</th>
                <th style="width: 12%; text-align: center;">Qty.</th>
                <th style="width: 15%; text-align: right;">Price</th>
                <th style="width: 15%; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows}
            </tbody>
          </table>
        </div>

        <!-- 6. Footer Return Address & Page -->
        <div class="label-row footer-row">
          <div class="footer-return-text">
            <strong>Return Address:</strong> 7004, Hi-tech Textile Centre (HTC Market - 1), Anjana Farm, Near Raghukul Market, Surat - 395002
          </div>
          <div class="footer-page-text">
            Page 1 of 1
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
    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
    const courierLabel = isVelocity ? 'Velocity' : 'Delhivery';
    const labelHtml = this.generateSingleLabelHtml(order, waybillNumber);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${courierLabel} Shipping Label - ${order.shopifyOrderName} (${waybillNumber})</title>
  <style>
    ${this.getLabelStyles()}
  </style>
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Youthnic · ${courierLabel} 4R Shipping Label</span>
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
   * Generates a complete multi-label printable document for bulk orders.
   * Embeds official carrier PDFs (Amazon Transportation, Velocity, Blue Dart)
   * with high-res PDF.js canvas rendering and clean HTML fallbacks.
   */
  public generateBulkPrintableLabelsPage(orderList: PrintableLabelItem[]): string {
    const hasPdfBuffers = orderList.some((item) => Boolean(item.pdfBuffer && item.pdfBuffer.length > 50));

    const labelsHtml = orderList
      .map(({ order, waybillNumber, pdfBuffer }) => {
        const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
        // Only Velocity / Amazon shipments embed official 4x6" PDF labels.
        // Delhivery shipments display Youthnic's standard 4R thermal label format.
        const pdfBase64 = isVel && pdfBuffer && pdfBuffer.length > 50 ? pdfBuffer.toString('base64') : '';
        return `
          <div class="label-print-page" data-order-name="${order.shopifyOrderName}" data-awb="${waybillNumber}" ${
          pdfBase64 ? `data-pdf-base64="${pdfBase64}"` : ''
        }>
            ${
              pdfBase64
                ? `
              <div class="pdf-canvas-container" style="display:none; text-align:center; width:100mm; height:150mm; margin:0 auto 20px auto;">
                <canvas class="official-label-canvas" style="width:100mm; height:150mm; border:2px solid #000; box-shadow:0 4px 15px rgba(0,0,0,0.15); box-sizing:border-box; background:#fff; display:block; margin:0 auto;"></canvas>
              </div>`
                : ''
            }
            <div class="html-label-fallback">
              ${this.generateSingleLabelHtml(order, waybillNumber)}
            </div>
          </div>
        `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bulk Shipping Labels (${orderList.length} Orders)</title>
  <style>
    ${this.getLabelStyles()}
  </style>
  ${hasPdfBuffers ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>` : ''}
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Youthnic · Bulk 4R Shipping Labels</span>
      <span class="controls-info">Total Packages: ${orderList.length}</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print All ${orderList.length} Labels</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${labelsHtml}
  ${
    hasPdfBuffers
      ? `
  <script>
    (function() {
      if (typeof pdfjsLib === 'undefined') return;
      try {
        if (window.location.protocol === 'file:') {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        } else {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        var pages = document.querySelectorAll('.label-print-page[data-pdf-base64]');
        pages.forEach(async function(pageEl) {
          var base64 = pageEl.getAttribute('data-pdf-base64');
          if (!base64) return;
          try {
            var raw = atob(base64);
            var uint8 = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) {
              uint8[i] = raw.charCodeAt(i);
            }
            var loadingTask = pdfjsLib.getDocument({ data: uint8 });
            var pdf = await loadingTask.promise;
            var page = await pdf.getPage(1);

            var container = pageEl.querySelector('.pdf-canvas-container');
            var canvas = pageEl.querySelector('.official-label-canvas');
            var fallback = pageEl.querySelector('.html-label-fallback');
            if (!container || !canvas) return;

            var viewport = page.getViewport({ scale: 3.0 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            var ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            container.style.display = 'block';
            if (fallback) fallback.style.display = 'none';
          } catch (err) {
            console.warn('PDF.js render fallback to HTML:', err);
          }
        });
      } catch (e) {
        console.warn('PDF.js init error:', e);
      }
    })();
  </script>`
      : ''
  }
</body>
</html>`;
  }

  /**
   * Generates a printable page with Shipping Label, then Invoice (in that exact sequence)
   */
  public generateLabelAndInvoiceHtml(order: OrderWithDetails, waybillNumber: string, pdfBuffer?: Buffer | null): string {
    const isVelocity = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
    const courierLabel = isVelocity ? 'Velocity' : 'Delhivery';
    const invoiceHtml = invoiceService.generateInvoiceHtml(order);
    const pdfBase64 = isVelocity && pdfBuffer && pdfBuffer.length > 20 ? pdfBuffer.toString('base64') : '';

    const labelHtml = isVelocity
      ? (pdfBase64
          ? `
          <div class="pdf-canvas-container" style="text-align:center; width:100mm; height:150mm; margin:0 auto 20px auto;">
            <canvas class="official-label-canvas" style="width:100mm; height:150mm; border:2px solid #000; box-shadow:0 4px 15px rgba(0,0,0,0.15); box-sizing:border-box; background:#fff; display:block; margin:0 auto;"></canvas>
          </div>`
          : `
          <div class="velocity-label-pending" style="width:100mm; height:150mm; display:flex; flex-direction:column; align-items:center; justify-content:center; border:2px dashed #7c3aed; padding:20px; box-sizing:border-box; text-align:center; font-family:sans-serif; background:#faf5ff;">
            <h3 style="color:#7c3aed; margin:0 0 8px 0;">⚡ Official Velocity Label</h3>
            <p style="font-size:12px; color:#475569; margin:0 0 6px 0;">AWB: <strong>${waybillNumber}</strong></p>
            <p style="font-size:11px; color:#64748b; margin:0;">Official PDF label is being fetched from the Velocity Shipping Network. Click Reload or Print to refresh.</p>
          </div>`)
      : this.generateSingleLabelHtml(order, waybillNumber);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Shipping Label & Invoice - ${order.shopifyOrderName}</title>
  <style>
    ${this.getCombinedStyles()}
  </style>
  ${pdfBase64 ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>` : ''}
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Youthnic · ${courierLabel} Label + GST Tax Invoice</span>
      <span class="controls-info">Order ${order.shopifyOrderName} · Label then Invoice</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print (Label + Invoice)</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  <div class="label-page-wrapper" data-order-name="${order.shopifyOrderName}" data-awb="${waybillNumber}" ${pdfBase64 ? `data-pdf-base64="${pdfBase64}"` : ''}>
    ${labelHtml}
  </div>
  <div class="invoice-page-wrapper">
    ${invoiceHtml}
  </div>
  ${pdfBase64 ? `
  <script>
    (function() {
      if (typeof pdfjsLib === 'undefined') return;
      try {
        if (window.location.protocol === 'file:') {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        } else {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        var pageEl = document.querySelector('.label-page-wrapper[data-pdf-base64]');
        if (!pageEl) return;
        var base64 = pageEl.getAttribute('data-pdf-base64');
        if (!base64) return;
        var raw = atob(base64);
        var uint8 = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);
        pdfjsLib.getDocument({ data: uint8 }).promise.then(function(pdf) {
          return pdf.getPage(1);
        }).then(function(page) {
          var container = pageEl.querySelector('.pdf-canvas-container');
          var canvas = pageEl.querySelector('.official-label-canvas');
          if (!container || !canvas) return;
          var viewport = page.getViewport({ scale: 3.0 });
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          var ctx = canvas.getContext('2d');
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function() {
            container.style.display = 'block';
          });
        }).catch(function(err) {
          console.warn('PDF.js render error:', err);
        });
      } catch (e) {
        console.warn('PDF.js init error:', e);
      }
    })();
  </script>` : ''}
</body>
</html>`;
  }

  /**
   * Generates a combined multi-order printable document with alternating sequence:
   * Order 1 Label -> Order 1 Invoice -> Order 2 Label -> Order 2 Invoice -> ...
   * strictly "label then invoice label then invoice"
   */
  public generateBulkLabelsAndInvoicesHtml(orderList: PrintableLabelItem[]): string {
    const hasPdfBuffers = orderList.some((item) => Boolean(item.pdfBuffer && item.pdfBuffer.length > 50));

    const pagesHtml = orderList
      .map(({ order, waybillNumber, pdfBuffer }) => {
        const isVel = isVelocityCourier(order.shipment?.courier, order.shipment?.labelUrl, waybillNumber);
        const pdfBase64 = isVel && pdfBuffer && pdfBuffer.length > 50 ? pdfBuffer.toString('base64') : '';
        const labelHtml = this.generateSingleLabelHtml(order, waybillNumber);
        const invoiceHtml = invoiceService.generateInvoiceHtml(order);
        return `
          <div class="order-pair-wrapper">
            <div class="label-page-wrapper" data-order-name="${order.shopifyOrderName}" data-awb="${waybillNumber}" ${
          pdfBase64 ? `data-pdf-base64="${pdfBase64}"` : ''
        }>
              ${
                pdfBase64
                  ? `
                <div class="pdf-canvas-container" style="display:none; text-align:center; width:100mm; height:150mm; margin:0 auto 20px auto;">
                  <canvas class="official-label-canvas" style="width:100mm; height:150mm; border:2px solid #000; box-shadow:0 4px 15px rgba(0,0,0,0.15); box-sizing:border-box; background:#fff; display:block; margin:0 auto;"></canvas>
                </div>`
                  : ''
              }
              <div class="html-label-fallback">
                ${labelHtml}
              </div>
            </div>
            <div class="invoice-page-wrapper">
              ${invoiceHtml}
            </div>
          </div>
        `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bulk Shipping Labels & Invoices (${orderList.length} Orders)</title>
  <style>
    ${this.getCombinedStyles()}
  </style>
  ${hasPdfBuffers ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>` : ''}
</head>
<body>
  <div class="print-controls no-print">
    <div class="controls-left">
      <span class="controls-badge">Youthnic · Bulk Labels & Invoices</span>
      <span class="controls-info">${orderList.length} Orders · Alternating Label then Invoice (${orderList.length * 2} Pages)</span>
    </div>
    <div class="controls-right">
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print All (${orderList.length * 2} Pages)</button>
      <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
    </div>
  </div>
  ${pagesHtml}
  ${
    hasPdfBuffers
      ? `
  <script>
    (function() {
      if (typeof pdfjsLib === 'undefined') return;
      try {
        if (window.location.protocol === 'file:') {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        } else {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        var pages = document.querySelectorAll('.label-page-wrapper[data-pdf-base64]');
        pages.forEach(async function(pageEl) {
          var base64 = pageEl.getAttribute('data-pdf-base64');
          if (!base64) return;
          try {
            var raw = atob(base64);
            var uint8 = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) {
              uint8[i] = raw.charCodeAt(i);
            }
            var loadingTask = pdfjsLib.getDocument({ data: uint8 });
            var pdf = await loadingTask.promise;
            var page = await pdf.getPage(1);

            var container = pageEl.querySelector('.pdf-canvas-container');
            var canvas = pageEl.querySelector('.official-label-canvas');
            var fallback = pageEl.querySelector('.html-label-fallback');
            if (!container || !canvas) return;

            var viewport = page.getViewport({ scale: 3.0 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            var ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            container.style.display = 'block';
            if (fallback) fallback.style.display = 'none';
          } catch (err) {
            console.warn('PDF.js render fallback to HTML:', err);
          }
        });
      } catch (e) {
        console.warn('PDF.js init error:', e);
      }
    })();
  </script>`
      : ''
  }
</body>
</html>`;
  }

  public getCombinedStyles(): string {
    return `
      ${this.getLabelStyles()}
      ${invoiceService.getInvoiceStyles()}

      .label-page-wrapper {
        display: flex;
        justify-content: center;
        width: 100%;
      }

      .invoice-page-wrapper {
        display: flex;
        justify-content: center;
        width: 100%;
        margin-top: 10px;
      }

      .order-pair-wrapper {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
      }

      @media print {
        body { background: #fff !important; padding: 0 !important; margin: 0 !important; }
        .no-print { display: none !important; }
        .label-wrapper { box-shadow: none !important; margin: 0 !important; }
        .pdf-canvas-container { margin: 0 !important; page-break-after: always; break-after: page; }
        .official-label-canvas { width: 100mm !important; height: 150mm !important; max-width: 100mm !important; max-height: 150mm !important; border: none !important; box-shadow: none !important; }
        
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
          box-shadow: none !important;
          margin: 0 !important;
          width: 100% !important;
          height: 100% !important;
          max-height: 100% !important;
          box-sizing: border-box !important;
          border: 1.5px solid #000 !important;
          overflow: hidden !important;
        }
        
        .label-page-wrapper {
          page-break-after: always;
          break-after: page;
        }
        
        .invoice-page-wrapper {
          page-break-after: always;
          break-after: page;
          margin-top: 0 !important;
        }

        .order-pair-wrapper {
          page-break-inside: auto;
          break-inside: auto;
        }

        @page {
          size: 100mm 150mm;
          margin: 0;
        }
      }
    `;
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
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
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
        padding: 3mm 4mm;
        box-sizing: border-box;
      }
      .label-row {
        border-bottom: 1.5px solid #000;
        padding: 3px 0;
      }
      
      /* 1. Header */
      .header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 4px;
      }
      .header-left {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }
      .seller-org {
        font-size: 10.5px;
        font-weight: 800;
        letter-spacing: 0.5px;
        color: #000;
        text-transform: uppercase;
      }
      .brand-logo-wrap {
        margin-top: 1px;
      }
      .youthnic-logo-img {
        height: 24px;
        max-width: 135px;
        object-fit: contain;
        display: block;
      }
      .header-right {
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }
      .delhivery-logo-img {
        height: 25px;
        max-width: 130px;
        object-fit: contain;
        display: block;
      }

      /* Carrier Badges (Amazon Transportation, Velocity, Blue Dart, Ekart) */
      .carrier-badge {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        justify-content: center;
      }
      .amazon-wordmark {
        display: flex;
        flex-direction: column;
        align-items: center;
        line-height: 1;
      }
      .amz-text {
        font-size: 20px;
        font-weight: 900;
        letter-spacing: -0.5px;
        color: #000;
        font-family: Arial, Helvetica, sans-serif;
      }
      .amz-smile {
        display: block;
        margin-top: -3px;
      }
      .carrier-sub-text {
        font-size: 8px;
        font-weight: 800;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: #111;
        margin-top: 1px;
      }
      .bluedart-wordmark {
        font-size: 15px;
        font-weight: 900;
        font-style: italic;
        letter-spacing: 0.5px;
        color: #000;
      }
      .ekart-wordmark {
        font-size: 17px;
        font-weight: 900;
        letter-spacing: -0.5px;
        color: #000;
      }
      .velocity-wordmark {
        font-size: 14px;
        font-weight: 900;
        letter-spacing: 0.5px;
        color: #000;
      }

      /* 2. Barcode & Routing */
      .barcode-row {
        text-align: center;
        padding: 3px 0;
      }
      .awb-number-top {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.5px;
        margin-bottom: 1px;
      }
      .awb-barcode-wrap {
        display: flex;
        justify-content: center;
      }
      .awb-sub-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 2px 4px 0 4px;
        font-size: 10px;
        font-weight: 800;
      }
      .meta-dest-pin { font-size: 10px; font-weight: 800; }
      .meta-center-awb { font-size: 10.5px; font-weight: 800; }
      .meta-sort-hub { font-size: 11px; font-weight: 900; letter-spacing: 0.5px; }

      /* Split Rows */
      .split-row {
        display: flex;
      }
      .split-col-left {
        width: 63%;
        padding-right: 4px;
      }
      .split-col-right {
        width: 37%;
        border-left: 1.5px solid #000;
        padding-left: 6px;
      }

      /* 3. Consignee & Payment */
      .consignee-col {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .ship-to-header {
        font-size: 10.5px;
        margin-bottom: 2px;
      }
      .consignee-name {
        font-size: 13px;
        font-weight: 800;
        text-transform: capitalize;
      }
      .consignee-addr {
        font-size: 9.5px;
        line-height: 1.2;
        margin-top: 1px;
        word-break: break-word;
      }
      .consignee-geo {
        font-size: 10px;
        font-weight: 800;
        margin-top: 2px;
      }
      .consignee-pin {
        font-size: 11px;
        font-weight: 900;
        margin-top: 1px;
      }
      .consignee-phone {
        font-size: 9.5px;
        font-weight: 600;
        margin-top: 2px;
      }

      .payment-col {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
      }
      .pay-mode-line {
        font-size: 10.5px;
        font-weight: 800;
      }
      .pay-amount-line {
        font-size: 13.5px;
        font-weight: 900;
        margin-top: 1px;
      }
      .cod-action-pill {
        display: inline-block;
        background: #000;
        color: #fff;
        font-size: 9px;
        font-weight: 900;
        padding: 1px 4px;
        margin-top: 2px;
        letter-spacing: 0.5px;
      }
      .prepaid-action-pill {
        display: inline-block;
        border: 1px solid #000;
        font-size: 8px;
        font-weight: 800;
        padding: 1px 3px;
        margin-top: 2px;
      }
      .date-block {
        margin-top: 5px;
      }
      .date-label {
        font-size: 8.5px;
        font-weight: 700;
        color: #333;
      }
      .date-val {
        font-size: 9.5px;
        font-weight: 600;
      }

      /* 4. Seller & Order */
      .seller-order-row {
        align-items: center;
      }
      .seller-col {
        font-size: 8.5px;
        line-height: 1.2;
      }
      .seller-header {
        font-size: 9.5px;
        font-weight: 800;
        margin-bottom: 1px;
      }
      .seller-addr-text {
        font-size: 8px;
        color: #222;
      }
      .order-barcode-col {
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .order-code-top {
        font-size: 10.5px;
        font-weight: 800;
        letter-spacing: 0.5px;
      }
      .order-barcode-svg {
        display: flex;
        justify-content: center;
        margin-top: 1px;
      }

      /* 5. Products Table */
      .items-row {
        padding: 2px 0;
        flex-grow: 1;
        overflow: hidden;
      }
      .items-table {
        width: 100%;
        border-collapse: collapse;
      }
      .items-table th {
        font-size: 8.5px;
        font-weight: 800;
        text-align: left;
        padding: 2px 3px;
        border-bottom: 1px solid #000;
        background: #f8fafc;
      }
      .items-table td {
        padding: 2px 3px;
        vertical-align: top;
      }
      .col-prod {
        font-size: 8.5px;
        line-height: 1.15;
      }
      .item-title { font-weight: 600; }
      .item-variant { font-size: 8px; color: #444; }
      .item-sku { display: block; font-size: 7.5px; color: #64748b; font-weight: 600; }
      .col-qty { font-size: 9.5px; font-weight: 800; text-align: center; }
      .col-price { font-size: 8.5px; text-align: right; }
      .col-total { font-size: 9px; font-weight: 800; text-align: right; }

      /* 6. Footer */
      .footer-row {
        border-bottom: none;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 3px;
        font-size: 8px;
      }
      .footer-return-text {
        width: 82%;
        font-size: 8px;
        line-height: 1.15;
      }
      .footer-page-text {
        width: 18%;
        text-align: right;
        font-weight: 700;
        font-size: 8.5px;
      }

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
        }
        .pdf-canvas-container {
          margin: 0 !important;
          page-break-after: always;
          break-after: page;
        }
        .official-label-canvas {
          width: 100mm !important;
          height: 150mm !important;
          max-width: 100mm !important;
          max-height: 150mm !important;
          border: none !important;
          box-shadow: none !important;
        }
        .label-print-page {
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .label-print-page:not(:last-child) {
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

export const shippingLabelService = new ShippingLabelService();
export default shippingLabelService;
