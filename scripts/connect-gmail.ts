/**
 * Gmail OAuth2 Connection Helper for Youthnic OMS
 *
 * Usage:
 *   npx tsx scripts/connect-gmail.ts
 *   or:
 *   npm run gmail:connect
 *
 * This script starts a local server, opens Google's OAuth consent screen,
 * captures your permanent refresh token, tests the connection against Gmail,
 * verifies your Easebuzz settlement emails/labels, and saves the credentials into .env.
 */

import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

function updateEnvFile(updates: Record<string, string>): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }

  fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
  console.log('âœ… Updated .env file with Gmail API credentials.');
}

async function main() {
  console.log('====================================================');
  console.log('  Youthnic OMS - Gmail Settlement Automated Connect');
  console.log('====================================================\n');

  let clientId = process.env.GMAIL_CLIENT_ID || '';
  let clientSecret = process.env.GMAIL_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    console.log('Google Cloud OAuth Client credentials not found in .env.');
    console.log('Please enter your Google OAuth 2.0 credentials from Google Cloud Console:');
    console.log('(To create: https://console.cloud.google.com/apis/credentials -> Create Credentials -> OAuth client ID -> Web application)');
    console.log(`Add Authorized Redirect URI: ${REDIRECT_URI}\n`);

    if (!clientId) {
      clientId = await askQuestion('Enter Google Client ID: ');
    }
    if (!clientSecret) {
      clientSecret = await askQuestion('Enter Google Client Secret: ');
    }
  }

  if (!clientId || !clientSecret) {
    console.error('âŒ Client ID and Client Secret are required. Aborting.');
    process.exit(1);
  }

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(SCOPES)}&` +
    `access_type=offline&` +
    `prompt=consent`;

  console.log('\n----------------------------------------------------');
  console.log('Please open this URL in your browser to sign in:');
  console.log('----------------------------------------------------');
  console.log(authUrl);
  console.log('----------------------------------------------------\n');
  console.log(`Waiting for Google OAuth callback on http://localhost:${PORT}/oauth2callback ...\n`);

  const server = http.createServer(async (req, res) => {
    const reqUrl = url.parse(req.url || '', true);

    if (reqUrl.pathname === '/oauth2callback') {
      const code = reqUrl.query.code as string;
      const error = reqUrl.query.error as string;

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authentication Failed</h2><p>${error}</p>`);
        console.error('âŒ Google Auth Error:', error);
        server.close();
        process.exit(1);
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>No code received</h2>');
        return;
      }

      try {
        console.log('â³ Exchanging authorization code for tokens...');
        const tokenResponse = await axios.post(
          'https://oauth2.googleapis.com/token',
          new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token, refresh_token } = tokenResponse.data;

        if (!refresh_token) {
          console.warn('âš ï¸ Warning: Google did not return a refresh_token.');
          console.warn('Make sure prompt=consent is used so Google provides an offline refresh token.');
        }

        // Test Gmail API
        console.log('â³ Verifying connection with Gmail API...');
        const profileRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const userEmail = profileRes.data.emailAddress;
        console.log(`âœ… Connected as: ${userEmail}`);

        // Check for Easebuzz label & settlement emails
        const labelQuery = 'from:info@easebuzz.com "Settlement Report" has:attachment';
        const searchRes = await axios.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(labelQuery)}&maxResults=10`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const count = searchRes.data.resultSizeEstimate || (searchRes.data.messages || []).length;
        console.log(`âœ… Found ~${count} Easebuzz Settlement Reports ready for automatic sync!`);

        // Save to .env
        updateEnvFile({
          GMAIL_CLIENT_ID: clientId,
          GMAIL_CLIENT_SECRET: clientSecret,
          GMAIL_REFRESH_TOKEN: refresh_token || process.env.GMAIL_REFRESH_TOKEN || '',
          GMAIL_USER_EMAIL: userEmail,
          GMAIL_SETTLEMENT_QUERY: 'from:info@easebuzz.com "Settlement Report" has:attachment',
          GMAIL_SETTLEMENT_ENABLED: 'true',
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
            <h1 style="color: #10b981;">âœ… Gmail Connected Successfully!</h1>
            <p>Signed in as: <strong>${userEmail}</strong></p>
            <p>Youthnic OMS has verified your connection and found <strong>${count}+</strong> Easebuzz settlement reports.</p>
            <p>Your <code>.env</code> file has been updated automatically.</p>
            <p style="color: #6b7280;">You can close this browser window and return to your terminal.</p>
          </div>
        `);

        console.log('\n====================================================');
        console.log('âœ… GMAIL SETUP COMPLETE! You can now run:');
        console.log('   npm run gmail:sync');
        console.log('====================================================\n');

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1500);
      } catch (err: any) {
        const errorMsg = err.response?.data?.error_description || err.response?.data?.error || err.message;
        console.error('âŒ Token exchange failed:', errorMsg);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error connecting Gmail</h2><p>${errorMsg}</p>`);
        server.close();
        process.exit(1);
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`OAuth listener running on port ${PORT}...`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
