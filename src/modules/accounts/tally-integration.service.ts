/**
 * TallyPrime Enterprise Accounting XML & Voucher Engine
 *
 * Generates official, schema-compliant Tally XML for:
 * - Sales Vouchers (<VOUCHER VCHTYPE="Sales">)
 * - Credit Notes (<VOUCHER VCHTYPE="Credit Note">)
 * - Receipt Vouchers (<VOUCHER VCHTYPE="Receipt">)
 * - Purchase / Expense Vouchers (<VOUCHER VCHTYPE="Purchase">)
 * - Journal Vouchers (<VOUCHER VCHTYPE="Journal">)
 * - Ledger Masters (<LEDGER NAME="...">)
 *
 * Invariants:
 * 1. Debits == Credits (ALL_LEDGER_ENTRIES sum to 0 in Tally notation where Debit is negative or explicit ISDEEMEDPOSITIVE)
 * 2. GUID / RemoteID uniqueness for idempotent import into TallyPrime.
 * 3. State GST Place of Supply (POS) and buyer details included on every invoice.
 */

import prisma from '../../database/prisma';
import logger from '../../utils/logger';
import { VoucherType } from '@prisma/client';

export interface TallyExportFilter {
  period?: string; // YYYY-MM
  startDate?: Date;
  endDate?: Date;
  voucherTypes?: VoucherType[];
  includeMasters?: boolean;
}

export interface TallyLedgerMasterDef {
  name: string;
  parent: string;
  isGstApplicable?: boolean;
  taxType?: string;
  rate?: number;
}

export const TALLY_STANDARD_LEDGER_MASTERS: TallyLedgerMasterDef[] = [
  // Revenue & Returns
  { name: 'Sales Revenue', parent: 'Sales Accounts' },
  { name: 'Sales Returns', parent: 'Sales Accounts' },

  // GST Duties & Taxes
  { name: 'Output IGST', parent: 'Duties & Taxes', isGstApplicable: true, taxType: 'Integrated Tax' },
  { name: 'Output CGST', parent: 'Duties & Taxes', isGstApplicable: true, taxType: 'Central Tax' },
  { name: 'Output SGST', parent: 'Duties & Taxes', isGstApplicable: true, taxType: 'State Tax' },
  { name: 'Input GST (Eligible)', parent: 'Duties & Taxes', isGstApplicable: true, taxType: 'Input Tax Credit' },
  { name: 'Input GST (Ineligible)', parent: 'Duties & Taxes', isGstApplicable: true },

  // Debtors & Customers
  { name: 'Sundry Debtors (Prepaid Orders)', parent: 'Sundry Debtors' },
  { name: 'Sundry Debtors (COD Orders)', parent: 'Sundry Debtors' },

  // Bank & Clearing Accounts
  { name: 'HDFC Bank Current Account', parent: 'Bank Accounts' },
  { name: 'Easebuzz Clearing Account', parent: 'Bank Accounts' },
  { name: 'GoKwik Clearing Account', parent: 'Bank Accounts' },
  { name: 'PhonePe Clearing Account', parent: 'Bank Accounts' },
  { name: 'Courier Remittance Clearing', parent: 'Bank Accounts' },
  { name: 'Courier Prepaid Wallets', parent: 'Current Assets' },

  // Payment Gateway Expenses
  { name: 'Payment Gateway Fees (Easebuzz)', parent: 'Indirect Expenses' },
  { name: 'Payment Gateway Fees (GoKwik)', parent: 'Indirect Expenses' },
  { name: 'Payment Gateway Fees (PhonePe)', parent: 'Indirect Expenses' },

  // Freight & Courier Expenses
  { name: 'Forward Freight Expense', parent: 'Direct Expenses' },
  { name: 'RTO Freight Expense', parent: 'Direct Expenses' },
  { name: 'Reverse Pickup Freight Expense', parent: 'Direct Expenses' },
  { name: 'COD Handling Charges', parent: 'Direct Expenses' },
  { name: 'Weight Discrepancy Charges', parent: 'Direct Expenses' },

  // Courier Creditors
  { name: 'Delhivery Logistics Payable', parent: 'Sundry Creditors' },
  { name: 'Velocity Freight Payable', parent: 'Sundry Creditors' },
];

export class TallyIntegrationService {
  /**
   * Helper to format Date for Tally XML: "YYYYMMDD"
   */
  public formatTallyDate(d: Date): string {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yr}${mo}${da}`;
  }

  /**
   * Escape XML special characters.
   */
  public escapeXml(str: string | null | undefined): string {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Generate official Tally Ledger Masters XML envelope.
   */
  public generateTallyMastersXml(): string {
    const ledgersXml = TALLY_STANDARD_LEDGER_MASTERS.map((m) => {
      return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${this.escapeXml(m.name)}" ACTION="Create">
            <NAME>${this.escapeXml(m.name)}</NAME>
            <PARENT>${this.escapeXml(m.parent)}</PARENT>
            <ISBILLWISEON>No</ISBILLWISEON>
            <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
            ${m.isGstApplicable ? `<ISGSTAPPLICABLE>Yes</ISGSTAPPLICABLE>` : ''}
            ${m.taxType ? `<TAXTYPE>${this.escapeXml(m.taxType)}</TAXTYPE>` : ''}
          </LEDGER>
        </TALLYMESSAGE>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>YOUTHNIC (VB EXPORTS)</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${ledgersXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  }

  /**
   * Generate complete Tally XML Envelope for import into TallyPrime or Tally ERP 9.
   */
  public async generateTallyXml(filter: TallyExportFilter): Promise<string> {
    const whereClause: any = {};
    if (filter.period) {
      whereClause.accountingPeriod = filter.period;
    }
    if (filter.startDate || filter.endDate) {
      whereClause.documentDate = {};
      if (filter.startDate) whereClause.documentDate.gte = filter.startDate;
      if (filter.endDate) whereClause.documentDate.lte = filter.endDate;
    }
    if (filter.voucherTypes && filter.voucherTypes.length > 0) {
      whereClause.voucherType = { in: filter.voucherTypes };
    }

    const journalEntries = await prisma.journalEntry.findMany({
      where: whereClause,
      include: {
        lines: {
          include: { account: true },
        },
        order: true,
        returnObj: true,
      },
      orderBy: { documentDate: 'asc' },
    });

    // Validate that every voucher is strictly balanced before exporting
    for (const entry of journalEntries) {
      let sumDebits = 0;
      let sumCredits = 0;
      for (const line of entry.lines) {
        sumDebits += line.debit.toNumber();
        sumCredits += line.credit.toNumber();
      }
      if (Math.abs(sumDebits - sumCredits) > 0.05) {
        throw new Error(
          `Voucher ${entry.entryNumber} is unbalanced: Debits ₹${sumDebits.toFixed(2)} != Credits ₹${sumCredits.toFixed(2)}`
        );
      }
    }

    let mastersXml = '';
    if (filter.includeMasters) {
      mastersXml = TALLY_STANDARD_LEDGER_MASTERS.map((m) => {
        return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${this.escapeXml(m.name)}" ACTION="Create">
            <NAME>${this.escapeXml(m.name)}</NAME>
            <PARENT>${this.escapeXml(m.parent)}</PARENT>
            <ISBILLWISEON>No</ISBILLWISEON>
            <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
            ${m.isGstApplicable ? `<ISGSTAPPLICABLE>Yes</ISGSTAPPLICABLE>` : ''}
            ${m.taxType ? `<TAXTYPE>${this.escapeXml(m.taxType)}</TAXTYPE>` : ''}
          </LEDGER>
        </TALLYMESSAGE>`;
      }).join('\n') + '\n';
    }

    const vouchersXml = journalEntries.map((entry) => this.renderTallyVoucher(entry)).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>YOUTHNIC (VB EXPORTS)</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${mastersXml}${vouchersXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  }

  /**
   * Render a single JournalEntry into a TallyPrime <VOUCHER> element.
   */
  private renderTallyVoucher(entry: any): string {
    const dateStr = this.formatTallyDate(entry.documentDate);
    let vchType = 'Journal';
    if (entry.voucherType === VoucherType.SALES) vchType = 'Sales';
    else if (entry.voucherType === VoucherType.CREDIT_NOTE) vchType = 'Credit Note';
    else if (entry.voucherType === VoucherType.RECEIPT) vchType = 'Receipt';
    else if (entry.voucherType === VoucherType.PURCHASE) vchType = 'Purchase';
    else if (entry.voucherType === VoucherType.PAYMENT) vchType = 'Payment';

    const narration = this.escapeXml(entry.narration || `${vchType} voucher ${entry.entryNumber}`);
    const partyName = this.escapeXml(entry.lines[0]?.partyName || 'Cash / Counter Customer');
    const statePos = entry.lines.find((l: any) => l.statePos)?.statePos || '24-Gujarat';

    const linesXml = entry.lines
      .map((line: any) => {
        const isDebit = line.debit.toNumber() > 0;
        const amount = isDebit ? line.debit.toNumber() : line.credit.toNumber();
        // In Tally XML:
        // ISDEEMEDPOSITIVE = Yes for Debit entries, No for Credit entries
        // AMOUNT tag: Negative value for Debit, Positive for Credit
        const deemedPositive = isDebit ? 'Yes' : 'No';
        const tallyAmount = isDebit ? -amount : amount;

        return `          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${this.escapeXml(line.account.name)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>
            <AMOUNT>${tallyAmount.toFixed(2)}</AMOUNT>
            ${line.narration ? `<NARRATION>${this.escapeXml(line.narration)}</NARRATION>` : ''}
          </ALLLEDGERENTRIES.LIST>`;
      })
      .join('\n');

    return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${vchType}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${this.escapeXml(entry.entryNumber)}</VOUCHERNUMBER>
            <REFERENCE>${this.escapeXml(entry.reference || entry.entryNumber)}</REFERENCE>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <STATENAME>${this.escapeXml(statePos)}</STATENAME>
            <NARRATION>${narration}</NARRATION>
            <GUID>YOUTHNIC-${entry.id}-${entry.entryNumber}</GUID>
${linesXml}
          </VOUCHER>
        </TALLYMESSAGE>`;
  }

  /**
   * Helper to generate a flat tabular view of Tally vouchers for Excel export.
   */
  public async getTallyExcelRows(filter: TallyExportFilter): Promise<any[]> {
    const whereClause: any = {};
    if (filter.period) whereClause.accountingPeriod = filter.period;

    const entries = await prisma.journalEntry.findMany({
      where: whereClause,
      include: {
        lines: { include: { account: true } },
      },
      orderBy: { documentDate: 'asc' },
    });

    const rows: any[] = [];
    for (const e of entries) {
      for (const line of e.lines) {
        rows.push({
          'Voucher No': e.entryNumber,
          'Date': e.documentDate.toISOString().split('T')[0],
          'Voucher Type': e.voucherType,
          'Party Name': line.partyName || 'N/A',
          'Account Name': line.account.name,
          'Account Code': line.account.code,
          'State POS': line.statePos || 'N/A',
          'Debit (₹)': line.debit.toNumber(),
          'Credit (₹)': line.credit.toNumber(),
          'Narration': line.narration || e.narration,
        });
      }
    }
    return rows;
  }
}

export const tallyIntegrationService = new TallyIntegrationService();
