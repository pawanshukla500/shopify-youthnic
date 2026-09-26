/**
 * One-shot script: upload Logo-black.png to Firebase Storage at
 *   public/youthnic-logo.png
 * Make it world-readable so it can be referenced from email-templates.ts
 * via a public CDN URL.
 *
 * Usage: npx tsx scripts/upload-email-logo.ts <path-to-png>
 *
 * Run once. Idempotent — re-running overwrites with the same content.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { config } from '../src/config';
import { cert, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

async function main() {
  const localPath = process.argv[2];
  if (!localPath) {
    console.error('Usage: npx tsx scripts/upload-email-logo.ts <path-to-logo.png>');
    process.exit(1);
  }
  const absolute = path.resolve(localPath);
  if (!fs.existsSync(absolute)) {
    console.error(`Logo not found at ${absolute}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(absolute);

  // Initialise Firebase Admin SDK with the same credentials the rest of the
  // app uses (FIREBASE_SERVICE_ACCOUNT_PATH env var or firebase-service-account.json).
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'firebase-service-account.json';
  if (!fs.existsSync(saPath)) {
    console.error(`Firebase service account file not found at ${saPath}`);
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  const app = initializeApp(
    { credential: cert(sa), storageBucket: config.firebase.storageBucket },
    'logo-upload'
  );
  const bucket = getStorage(app).bucket();
  const remotePath = 'public/youthnic-logo.png';
  const file = bucket.file(remotePath);

  await file.save(buffer, {
    metadata: { contentType: 'image/png', cacheControl: 'public, max-age=86400' },
    public: true,
    resumable: false,
  });

  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${remotePath}`;
  console.log(`Uploaded logo. Public URL:`);
  console.log(`  ${publicUrl}`);
  console.log('\nNext: set this as the BRAND_LOGO_URL in src/config/index.ts so email-templates.ts uses it.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});