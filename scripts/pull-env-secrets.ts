/**
 * Fill the empty secret keys in the local .env from the deployed server.
 *
 * GitHub repository secrets are write-only, so their values cannot be read back
 * from GitHub. The deploy workflow writes them into /opt/shopify/Shopify/.env on
 * the Hostinger VPS, so this script reads that file over SSH with your own key
 * and copies only the secret keys that are still empty locally. Keys that
 * already have a local value are left alone. Values are never printed; the
 * summary lists key names only.
 *
 * Run with: npm run env:pull
 * Override the server with HOSTINGER_HOST / HOSTINGER_USER / HOSTINGER_SSH_PORT.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// The app secrets held in GitHub repository secrets (deploy.yml). The
// HOSTINGER_* deploy secrets are not needed by the app and are not copied.
const SECRET_KEYS = [
  'DATABASE_URL',
  'SHOPIFY_CLIENT_SECRET',
  'DELHIVERY_API_TOKEN',
  'KWIKENGAGE_API_KEY',
  'RESEND_API_KEY',
  'META_API_KEY',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  // Optional gateway settlement API keys (Payments & Accounts)
  'PHONEPE_CLIENT_SECRET',
  'EASEBUZZ_SALT',
];

const REMOTE_ENV_PATH = '/opt/shopify/Shopify/.env';
const LOCAL_ENV_PATH = path.resolve(process.cwd(), '.env');

function main(): void {
  if (!fs.existsSync(LOCAL_ENV_PATH)) {
    fail(`${LOCAL_ENV_PATH} does not exist. Copy .env.example to .env first.`);
  }

  const host = process.env.HOSTINGER_HOST || '200.141.1.119';
  const user = process.env.HOSTINGER_USER || 'root';
  const port = process.env.HOSTINGER_SSH_PORT || '22';

  const localLines = fs.readFileSync(LOCAL_ENV_PATH, 'utf8').split(/\r?\n/);
  const wanted = SECRET_KEYS.filter((key) => {
    const line = localLines.find((l) => l.startsWith(`${key}=`));
    return !line || line.slice(key.length + 1).trim() === '';
  });

  if (wanted.length === 0) {
    console.log('Every secret key in .env already has a value. Nothing to do.');
    return;
  }

  console.log(`Reading ${REMOTE_ENV_PATH} from ${user}@${host}:${port} over SSH ...`);
  let remote = '';
  try {
    remote = execFileSync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        '-p', port,
        `${user}@${host}`,
        `cat ${REMOTE_ENV_PATH}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error: any) {
    const reason = String(error.stderr || error.message).trim();
    fail(
      `SSH read failed: ${reason}\n` +
        'Check that your SSH key is authorized on the server (ssh ' +
        `${user}@${host} should log in without a password), or paste the ` +
        'values into .env by hand.'
    );
  }

  // Copy the remainder of each line verbatim, exactly as the deploy wrote it.
  const remoteValues = new Map<string, string>();
  for (const line of remote.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    remoteValues.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }

  const filled: string[] = [];
  const missing: string[] = [];
  for (const key of wanted) {
    const value = remoteValues.get(key);
    if (!value || value.trim() === '') {
      missing.push(key);
      continue;
    }
    const index = localLines.findIndex((l) => l.startsWith(`${key}=`));
    if (index >= 0) {
      localLines[index] = `${key}=${value}`;
    } else {
      localLines.push(`${key}=${value}`);
    }
    filled.push(key);
  }

  fs.writeFileSync(LOCAL_ENV_PATH, localLines.join('\n'), { encoding: 'utf8', mode: 0o600 });

  console.log(`\nFilled ${filled.length} key(s): ${filled.join(', ') || '(none)'}`);
  if (missing.length > 0) {
    console.log(`Not set on the server either: ${missing.join(', ')}`);
  }
  console.log('\n.env holds PRODUCTION credentials. Keep CRON_ENABLED=false locally.');
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

main();
