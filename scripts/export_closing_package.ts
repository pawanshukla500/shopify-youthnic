import fs from 'fs';
import path from 'path';
import { generateMonthlyReport, previousMonth } from '../src/modules/accounts/accounts-report.service';
import { tallyIntegrationService } from '../src/modules/accounts/tally-integration.service';
import logger from '../src/utils/logger';

async function main() {
  const period = previousMonth();
  console.log(`Generating closing package for period: ${period}...`);

  // Target directories
  const workspaceExportDir = path.resolve('./exports');
  const artifactDir = path.resolve('C:/Users/Pawan Shukla/.gemini/antigravity/brain/f7454179-91f3-4d10-8c2f-e6c843cfeb1b');

  if (!fs.existsSync(workspaceExportDir)) {
    fs.mkdirSync(workspaceExportDir, { recursive: true });
  }

  // 1. Generate 8-Sheet Monthly Excel Workbook
  console.log('1. Generating 8-sheet Excel accounting workbook...');
  const { buffer: excelBuffer, fileName: excelFileName, data: reportData } = await generateMonthlyReport(period);
  
  const excelWorkspacePath = path.join(workspaceExportDir, excelFileName);
  const excelArtifactPath = path.join(artifactDir, excelFileName);

  fs.writeFileSync(excelWorkspacePath, excelBuffer);
  fs.writeFileSync(excelArtifactPath, excelBuffer);
  console.log(`✓ Excel report generated: ${excelWorkspacePath} (${excelBuffer.length} bytes)`);

  // 2. Generate TallyPrime XML Export (with Masters)
  console.log('2. Generating TallyPrime Vouchers XML...');
  const tallyXml = await tallyIntegrationService.generateTallyXml({ period, includeMasters: true });
  const tallyXmlFileName = `Youthnic-Tally-${period}.xml`;
  const tallyWorkspacePath = path.join(workspaceExportDir, tallyXmlFileName);
  const tallyArtifactPath = path.join(artifactDir, tallyXmlFileName);

  fs.writeFileSync(tallyWorkspacePath, tallyXml, 'utf-8');
  fs.writeFileSync(tallyArtifactPath, tallyXml, 'utf-8');
  console.log(`✓ Tally XML generated: ${tallyWorkspacePath} (${tallyXml.length} chars)`);

  // 3. Generate Standalone Tally Masters XML
  console.log('3. Generating Standalone Tally Masters XML...');
  const mastersXml = tallyIntegrationService.generateTallyMastersXml();
  const mastersFileName = 'Youthnic-Tally-Masters.xml';
  const mastersWorkspacePath = path.join(workspaceExportDir, mastersFileName);
  const mastersArtifactPath = path.join(artifactDir, mastersFileName);

  fs.writeFileSync(mastersWorkspacePath, mastersXml, 'utf-8');
  fs.writeFileSync(mastersArtifactPath, mastersXml, 'utf-8');
  console.log(`✓ Tally Masters XML generated: ${mastersWorkspacePath} (${mastersXml.length} chars)`);

  console.log('\n--- Generation Complete ---');
  console.log('Summary KPIs:');
  console.log(`- Period: ${reportData.label}`);
  console.log(`- Gross Sales: ₹${reportData.stateTotals.grossSales.toFixed(2)}`);
  console.log(`- Returns Deducted: ₹${reportData.stateTotals.returnsDeducted.toFixed(2)}`);
  console.log(`- Net Period Sales: ₹${reportData.stateTotals.netSales.toFixed(2)}`);
  console.log(`- Bank Receipts: ₹${reportData.stateTotals.paymentReceived.toFixed(2)}`);
  console.log(`- Closing Balance: ₹${(reportData.stateTotals.closingBalance ?? reportData.stateTotals.outstanding).toFixed(2)}`);
}

main().catch((err) => {
  console.error('Failed generating closing package:', err);
  process.exit(1);
});
