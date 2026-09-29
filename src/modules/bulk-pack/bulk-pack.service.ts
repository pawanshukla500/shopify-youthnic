import { ZipArchive } from 'archiver';
import { Writable } from 'node:stream';
import picklistService, { OrderWithDetails } from '../picklist/picklist.service';
import shippingLabelService from '../delhivery/shipping-label.service';
import invoiceService from '../invoice/invoice.service';

export class BulkPackService {
  /**
   * Generate manifest CSV summary for the orders in the batch.
   */
  generateManifestCsv(orders: OrderWithDetails[]): string {
    const headers = [
      'Order Name',
      'Shopify Order ID',
      'Order Date',
      'Customer Name',
      'Phone',
      'Email',
      'City',
      'State',
      'Pincode',
      'Payment Method',
      'Delhivery Waybill',
      'Items Count',
      'SKUs Summary',
      'Total Amount (INR)',
      'Order Status',
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = orders.map((o) => {
      const skus = (o.items || []).map((i) => i.sku || 'NO-SKU').join(', ');
      const totalUnits = (o.items || []).reduce((sum, i) => sum + (i.quantity || 1), 0);
      const waybill = o.shipment?.waybillNumber || 'PENDING';
      const dateStr = o.shopifyCreatedAt ? new Date(o.shopifyCreatedAt).toISOString().slice(0, 10) : '';

      return [
        escapeCsv(o.shopifyOrderName),
        escapeCsv(o.shopifyOrderId),
        escapeCsv(dateStr),
        escapeCsv(o.customerName),
        escapeCsv(o.customerPhone),
        escapeCsv(o.customerEmail || ''),
        escapeCsv(o.customerCity),
        escapeCsv(o.customerState),
        escapeCsv(o.customerPincode),
        escapeCsv(o.paymentMethod || 'Prepaid'),
        escapeCsv(waybill),
        escapeCsv(totalUnits),
        escapeCsv(skus),
        escapeCsv((o.totalAmount || 0).toFixed(2)),
        escapeCsv(o.status),
      ].join(',');
    });

    return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  }

  /**
   * Streams a complete ZIP archive to the writable stream containing:
   * 1. 00_Picklist_Summary.html (consolidated SKU picking list)
   * 2. 01_Labels_and_Invoices_Collated.html (alternating Label then Invoice for all orders)
   * 3. 02_All_Shipping_Labels_4R.html (consolidated thermal 4R labels)
   * 4. 03_All_GST_Invoices.html (consolidated GST commercial invoices)
   * 5. 04_Manifest_Summary.csv (batch packing manifest)
   * 6. labels/ (folder with individual order labels)
   * 7. invoices/ (folder with individual order invoices)
   */
  async streamBulkPackZip(orders: OrderWithDetails[], destination: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      const archive = new ZipArchive({
        zlib: { level: 9 }, // Maximum compression
      });

      archive.on('error', (err) => reject(err));
      destination.on('finish', () => resolve());
      destination.on('error', (err) => reject(err));

      archive.pipe(destination);

      const orderList = orders.map((order) => ({
        order: order as any,
        waybillNumber: order.shipment?.waybillNumber || `PENDING-${order.shopifyOrderName.replace('#', '')}`,
      }));

      // 1. Consolidated Picklist
      const picklistHtml = picklistService.generatePicklistHtml(orders);
      archive.append(picklistHtml, { name: '00_Picklist_Summary.html' });

      // 2. Collated Labels and Invoices (Strictly alternating: Order 1 Label -> Order 1 Invoice -> Order 2 Label -> ...)
      const collatedHtml = shippingLabelService.generateBulkLabelsAndInvoicesHtml(orderList);
      archive.append(collatedHtml, { name: '01_Labels_and_Invoices_Collated.html' });

      // 3. Consolidated Shipping Labels
      const bulkLabelsHtml = shippingLabelService.generateBulkPrintableLabelsPage(orderList);
      archive.append(bulkLabelsHtml, { name: '02_All_Shipping_Labels_4R.html' });

      // 4. Consolidated GST Invoices
      const bulkInvoicesHtml = invoiceService.generateBulkPrintableInvoicesPage(orders as any);
      archive.append(bulkInvoicesHtml, { name: '03_All_GST_Invoices.html' });

      // 5. Batch Manifest CSV
      const manifestCsv = this.generateManifestCsv(orders);
      archive.append(manifestCsv, { name: '04_Manifest_Summary.csv' });

      // 6. Individual Labels and Invoices Folders
      for (const order of orders) {
        const cleanName = order.shopifyOrderName.replace('#', '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const waybill = order.shipment?.waybillNumber || `PENDING-${cleanName}`;

        const singleLabelHtml = shippingLabelService.generatePrintableLabelPage(order as any, waybill);
        archive.append(singleLabelHtml, { name: `labels/Order_${cleanName}_Label_${waybill}.html` });

        const singleInvoiceHtml = invoiceService.generatePrintableInvoicePage(order as any);
        archive.append(singleInvoiceHtml, { name: `invoices/Order_${cleanName}_Invoice.html` });
      }

      archive.finalize().catch(reject);
    });
  }
}

export default new BulkPackService();
