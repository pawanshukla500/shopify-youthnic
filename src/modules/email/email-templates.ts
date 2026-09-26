/**
 * 21st.dev Inspired Logistics & Brand Email Templates for Youthnic
 * High-polish, mobile-responsive HTML templates compatible with all major email clients.
 * Official Youthnic Black Logo hosted on Firebase Storage (see config.brand.logoUrl).
 */

import { config } from '../../config';

export interface EmailTemplateData {
  orderName: string;
  customerName: string;
  recipientEmail?: string;
  waybillNumber?: string;
  courier?: string;
  currentLocation?: string;
  delayReason?: string;
  newEstimatedDelivery?: string;
  originalEstimatedDelivery?: string;
  daysInTransit?: number;
  trackingUrl?: string;
  items?: Array<{
    title: string;
    variantTitle?: string | null;
    quantity: number;
    price: number;
    imageUrl?: string | null;
  }>;
  totalAmount?: number;
  paymentMethod?: string;
  customerAddress?: string;
  customMessage?: string;
  actionUrl?: string;
  // Specific return & refund fields
  refundId?: string;
  refundAmount?: number;
  settlementGateway?: string;
  settlementTimeline?: string;
  returnReason?: string;
  qcStatus?: string;
  qcRemark?: string;
  ticketId?: number;
  ticketCategory?: string;
  ticketUrgency?: string;
  badgeText?: string;
}

const BRAND_NAME = 'Youthnic';
const BRAND_TAGLINE = config.brand.tagline;
const SUPPORT_PHONE = '+91 88661 54721';
const CONTACT_EMAIL = 'contact@youthnic.com';
const RETURN_EMAIL = 'return@youthnic.com';
const REFUND_EMAIL = 'refund@youthnic.com';
const DELIVERY_EMAIL = 'delivery@youthnic.com';

// Public HTTPS URL to the Youthnic wordmark logo hosted on Firebase Storage.
// Many email clients (Outlook desktop, older Outlook for Mac) silently refuse to
// render base64 inline images, so the logo MUST live on a public URL.
const YOUTHNIC_LOGO_BLACK_URL = config.brand.logoUrl;
// For dark-mode clients (Apple Mail, iOS Mail) we apply CSS filter on the same
// hosted PNG. This avoids shipping a second PNG asset.
const DARK_LOGO_FILTER = 'filter: invert(1) hue-rotate(180deg) saturate(0.6) brightness(1.05);';



interface BaseLayoutOptions {
  badgeText?: string;
  badgeBg?: string;
  badgeColor?: string;
  badgeBorder?: string;
}

function baseEmailLayout(content: string, preheader: string = '', options: BaseLayoutOptions = {}): string {
  const badgeText = options.badgeText || 'Official Logistics Update';
  const badgeBg = options.badgeBg || '#f8fafc';
  const badgeColor = options.badgeColor || '#334155';
  const badgeBorder = options.badgeBorder || '#e2e8f0';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${BRAND_NAME} Logistics Notification</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, sans-serif !important; }
  </style>
  <![endif]-->
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; padding: 12px !important; }
      .mobile-stack { display: block !important; width: 100% !important; }
      .mobile-center { text-align: center !important; }
      .hero-title { font-size: 20px !important; }
      .brand-header-td { padding: 18px 20px !important; }
      .body-td { padding: 20px 18px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .light-logo { display: none !important; }
      .dark-logo-wrap { display: block !important; }
      .brand-header-td { background-color: #0f172a !important; border-bottom: 1px solid #1e293b !important; }
      .container { background-color: #0f172a !important; border-color: #334155 !important; }
      .brand-tagline { color: #94a3b8 !important; }
      .footer-td { background-color: #1e293b !important; border-top: 1px solid #334155 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1e293b;">
  <span style="display: none !important; visibility: hidden; mso-hide: all; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden;">
    ${preheader}
  </span>
  
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; padding: 28px 0;">
    <tr>
      <td align="center">
        <!-- Main Card (21st.dev Modern Container) -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="620" class="container" style="max-width: 620px; width: 100%; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 25px rgba(0, 0, 0, 0.05);">
          
          <!-- Brand Header Card with Full Youthnic Logo & Sender Desk Pill (Auto-adjusting responsive wordmark) -->
          <tr>
            <td class="brand-header-td" style="background-color: #ffffff; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; text-align: left;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td valign="middle">
                    <div style="line-height: 1;">
                      <!-- Light Mode: Youthnic wordmark logo. Hosted URL so it
                           renders in Outlook desktop / Mac (base64 inline
                           images are silently dropped by many email clients). -->
                      <img class="light-logo" src="${YOUTHNIC_LOGO_BLACK_URL}" alt="Youthnic" width="210" height="42" style="max-width: 210px; width: 100%; height: auto; display: block; border: 0; outline: none; text-decoration: none;" />
                      <!-- Dark Mode: same hosted URL but apply CSS filter so it
                           inverts to white on dark backgrounds. We ship one
                           asset and filter it instead of maintaining two. -->
                      <!--[if !mso]><!-->
                      <div class="dark-logo-wrap" style="display: none; mso-hide: all;">
                        <img class="dark-logo" src="${YOUTHNIC_LOGO_BLACK_URL}" alt="Youthnic" width="210" height="42" style="max-width: 210px; width: 100%; height: auto; display: block; border: 0; outline: none; text-decoration: none; ${DARK_LOGO_FILTER}" />
                      </div>
                      <!--<![endif]-->
                      <div class="brand-tagline" style="font-size: 11px; color: #64748b; margin-top: 6px; letter-spacing: 0.3px; font-weight: 500;">
                        ${BRAND_TAGLINE}
                      </div>
                    </div>
                  </td>
                  <td align="right" valign="top">
                    <!-- Right-aligned sender desk pill badge (lowercase, small) -->
                    <span style="display: inline-block; padding: 4px 10px; background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; border-radius: 6px; font-size: 10.5px; font-weight: 500; color: ${badgeColor}; letter-spacing: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; mso-line-height-rule: exactly; line-height: 14px;">
                      ${badgeText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Dynamic Body Content -->
          <tr>
            <td class="body-td" style="padding: 32px;">
              ${content}
            </td>
          </tr>

          <!-- 21st.dev Support & Fulfillment Center Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; line-height: 1.6;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 6px;">Youthnic Customer Care & Logistics Center</div>
                    <div style="font-size: 12px; color: #475569; margin-bottom: 6px; line-height: 1.7;">
                      • Official Website: <a href="https://youthnic.com" style="color: #2563eb; text-decoration: none; font-weight: 600;">youthnic.com</a><br>
                      • General Support: <a href="mailto:${CONTACT_EMAIL}" style="color: #2563eb; text-decoration: none; font-weight: 600;">${CONTACT_EMAIL}</a><br>
                      • Returns Desk: <a href="mailto:${RETURN_EMAIL}" style="color: #7c3aed; text-decoration: none; font-weight: 600;">${RETURN_EMAIL}</a><br>
                      • Refunds Desk: <a href="mailto:${REFUND_EMAIL}" style="color: #059669; text-decoration: none; font-weight: 600;">${REFUND_EMAIL}</a><br>
                      • Dispatch Desk: <a href="mailto:${DELIVERY_EMAIL}" style="color: #d97706; text-decoration: none; font-weight: 600;">${DELIVERY_EMAIL}</a><br>
                      • WhatsApp Helpline: <a href="https://wa.me/918866154721" style="color: #059669; text-decoration: none; font-weight: 700;">${SUPPORT_PHONE}</a> (Mon-Sat, 10 AM - 7 PM IST)
                    </div>
                    <div style="margin-top: 8px; font-size: 11px; color: #94a3b8; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
                      Surat Fulfillment Center: 7004, Hi-tech Textile Centre, Anjana Farm, Near Raghukul Market, Surat, Gujarat 395002
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        
        <!-- Legal & Signature Remark Note -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="620" class="container" style="max-width: 620px; width: 100%; margin-top: 16px;">
          <tr>
            <td align="center" style="font-size: 11px; color: #94a3b8; line-height: 1.5;">
              You received this official notification regarding your order on <a href="https://youthnic.com" style="color: #64748b; text-decoration: underline;">youthnic.com</a>.<br>
              © ${new Date().getFullYear()} <a href="https://youthnic.com" style="color: #64748b; text-decoration: none; font-weight: 600;">youthnic.com</a> · All rights reserved. Surat Fulfillment Center, Gujarat, India.
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * 1. IN-TRANSIT DELAY EMAIL TEMPLATE (From: delivery@youthnic.com)
 * Sent when a dispatched order is delayed in transit or has crossed expected delivery date.
 */
export function renderTransitDelayEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Logistics Notice: Delivery Delay Update for Order ${data.orderName}`;
  const preheader = `Your Youthnic package ${data.orderName} is in safe transit with Delhivery Express. Here is your revised expected delivery.`;

  const content = `
    <!-- Amber Alert Notice matching media_1790339742746.png -->
    <div style="background-color: #fefce8; border: 1.5px solid #fef08a; border-radius: 10px; padding: 14px 18px; margin-bottom: 22px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td width="28" valign="top" style="font-size: 20px; line-height: 1.2;">⚠️</td>
          <td style="padding-left: 8px;">
            <div style="font-size: 14.5px; font-weight: 800; color: #92400e; line-height: 1.3;">Logistics Routing Notice: In-Transit Delivery Delay</div>
            <div style="font-size: 12px; color: #92400e; margin-top: 3px; line-height: 1.45;">
              Package in safe transit with Delhivery Express but delayed due to hub rescheduling.
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Salutation & Dispatch Notice matching media_1790339742746.png -->
    <p style="margin: 0 0 12px 0; font-size: 15px; font-weight: 700; color: #111827;">
      Dear ${data.customerName || 'Valued Customer'},
    </p>
    <p style="margin: 0 0 20px 0; font-size: 13.5px; line-height: 1.6; color: #374151;">
      Your order <strong>${data.orderName}</strong> is actively monitored. Our Surat dispatch team has escalated routing with Delhivery.
    </p>

    <!-- Telemetry Details Box matching media_1790339742746.png -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px;">
      ${data.waybillNumber ? `
      <div style="margin-bottom: 8px; font-size: 13px; color: #1e293b;">
        <strong>AWB:</strong> <span style="font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace; font-size: 12.5px;">${data.waybillNumber}</span>
      </div>` : ''}
      <div style="margin-bottom: 8px; font-size: 13px; color: #1e293b;">
        <strong>Current Hub:</strong> <span>${data.currentLocation || 'Bhiwandi Sorting Center Hub'}</span>
      </div>
      <div style="font-size: 13px; color: #1e293b;">
        <strong>Revised Expected Delivery:</strong> <span>${data.newEstimatedDelivery || 'Saturday, 28-Sep-2026'}</span>
      </div>
    </div>

    <!-- Centered Blue CTA Button matching media_1790339742746.png -->
    <div style="text-align: center; margin: 24px 0 8px 0;">
      <a href="${data.trackingUrl || 'https://www.delhivery.com/track/package/' + (data.waybillNumber || '')}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 13.5px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.25); font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        Track on Delhivery →
      </a>
      <div style="font-size: 11px; color: #64748b; margin-top: 8px;">
        Live tracking powered by Delhivery Express
      </div>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#f1f5f9',
      badgeColor: '#475569',
      badgeBorder: '#e2e8f0',
    }),
  };
}

/**
 * 2. RETURN INITIATED EMAIL TEMPLATE (From: return@youthnic.com)
 * Sent ONLY when a return is created by our side.
 */
export function renderReturnInitiatedEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Return Pickup Scheduled for Order ${data.orderName} · Youthnic`;
  const preheader = `Your return request for order ${data.orderName} has been approved. Reverse pickup is scheduled with Delhivery.`;

  const content = `
    <!-- Purple Header Banner -->
    <div style="background-color: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td width="36" valign="middle" style="font-size: 24px;">🔄</td>
          <td>
            <div style="font-size: 14px; font-weight: 800; color: #5b21b6;">Return Approved & Reverse Pickup Scheduled</div>
            <div style="font-size: 12px; color: #7c3aed; margin-top: 2px;">
              Delhivery Surface Reverse logistics pickup is booked for your doorstep.
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Salutation -->
    <h2 class="hero-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
      Dear ${data.customerName || 'Valued Customer'},
    </h2>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
      We have approved and initiated your return request for order <strong>${data.orderName}</strong>. Our reverse logistics partner <strong>Delhivery Surface Reverse</strong> has been scheduled to collect the return parcel from your address within <strong>24-48 business hours</strong>.
    </p>

    <!-- Return Details Card -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 22px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
      <div style="font-size: 11.5px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px;">
        Reverse Logistics Details
      </div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 13px;">
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Return Waybill (AWB):</td>
          <td align="right" style="font-weight: 700; color: #0f172a; padding-bottom: 12px;">
            <code style="background: #e2e8f0; padding: 3px 8px; border-radius: 5px; font-size: 12.5px; font-family: monospace;">${data.waybillNumber || 'Will be assigned at pickup'}</code>
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Courier Partner:</td>
          <td align="right" style="font-weight: 700; color: #7c3aed; padding-bottom: 12px;">
            ${data.courier || 'Delhivery Surface Reverse'}
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Reason for Return:</td>
          <td align="right" style="font-weight: 600; color: #334155; padding-bottom: 12px;">
            ${data.returnReason || 'Customer Exchange / Return Request'}
          </td>
        </tr>
        <tr style="border-top: 1px dashed #cbd5e1;">
          <td style="color: #0f172a; font-weight: 750; padding-top: 12px;">Pickup Address:</td>
          <td align="right" style="font-weight: 600; color: #334155; padding-top: 12px; font-size: 12.5px; line-height: 1.4;">
            ${data.customerAddress || 'Your registered delivery address'}
          </td>
        </tr>
      </table>
    </div>

    <!-- 21st.dev Style Reverse Pickup Guidelines Checklist -->
    <div style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
      <div style="font-size: 13px; font-weight: 800; color: #6b21a8; margin-bottom: 10px;">
        Reverse Pickup Checklist for Handover:
      </div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 12.5px; color: #4c1d95; line-height: 1.6;">
        <tr>
          <td width="24" valign="top" style="font-weight: 700;">1.</td>
          <td style="padding-bottom: 8px;"><strong>Original Packing:</strong> Keep the garment folded neatly in its original polybag with all brand tags and labels intact.</td>
        </tr>
        <tr>
          <td width="24" valign="top" style="font-weight: 700;">2.</td>
          <td style="padding-bottom: 8px;"><strong>Executive Verification:</strong> The Delhivery pickup executive will verify the item and handover a physical or digital receipt.</td>
        </tr>
        <tr>
          <td width="24" valign="top" style="font-weight: 700;">3.</td>
          <td style="padding-bottom: 8px;"><strong>Direct Refund:</strong> Once the parcel reaches our Surat warehouse and clears inspection, your 100% refund is initiated immediately via <strong>refund@youthnic.com</strong>.</td>
        </tr>
      </table>
    </div>

    ${
      data.trackingUrl
        ? `
    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${data.trackingUrl}" target="_blank" style="display: inline-block; background-color: #7c3aed; color: #ffffff; font-size: 14px; font-weight: 750; text-decoration: none; padding: 14px 30px; border-radius: 8px; box-shadow: 0 4px 14px rgba(124, 58, 237, 0.25);">
        Track Reverse Pickup Progress →
      </a>
    </div>
    `
        : ''
    }

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'returns@youthnic.com',
      badgeBg: '#f5f3ff',
      badgeColor: '#6d28d9',
      badgeBorder: '#ddd6fe',
    }),
  };
}

/**
 * 3. RETURN REFUND EMAIL TEMPLATE (From: refund@youthnic.com)
 * Sent AFTER the return is received, quality check passes with no issue, and refund is completed.
 */
export function renderReturnRefundEmail(data: EmailTemplateData): { subject: string; html: string } {
  const refundFormatted = (data.refundAmount || data.totalAmount || 0).toLocaleString('en-IN');
  const subject = `Refund Processed: ₹${refundFormatted} for Order ${data.orderName} · Youthnic`;
  const preheader = `Your refund of ₹${refundFormatted} for order ${data.orderName} has been processed successfully. Refund ID: ${data.refundId || 'RF-' + data.orderName}.`;

  const content = `
    <!-- Emerald Success Banner -->
    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td width="36" valign="middle" style="font-size: 26px;">💸</td>
          <td>
            <div style="font-size: 14.5px; font-weight: 800; color: #065f46;">Full Refund Completed & Verified</div>
            <div style="font-size: 12px; color: #047857; margin-top: 2px;">
              Returned item passed inspection at Surat hub. 100% funds released to your account.
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Salutation -->
    <h2 class="hero-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
      Dear ${data.customerName || 'Valued Customer'},
    </h2>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
      Great news! Your returned package for order <strong>${data.orderName}</strong> has safely arrived at our Surat fulfillment center and successfully passed quality inspection. We have processed a full refund of <strong>₹${refundFormatted}</strong> to your original payment method.
    </p>

    <!-- 21st.dev Inspired Digital Receipt Card -->
    <div style="background-color: #ffffff; border: 2px solid #a7f3d0; border-radius: 14px; padding: 22px; margin-bottom: 24px; box-shadow: 0 4px 15px rgba(5, 150, 105, 0.06);">
      <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #cbd5e1; padding-bottom: 14px; margin-bottom: 16px;">
        <span style="font-size: 12px; font-weight: 800; color: #059669; text-transform: uppercase; letter-spacing: 0.5px;">Official Settlement Receipt</span>
        <span style="font-size: 12px; color: #64748b;">${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>

      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 13px;">
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Official Refund ID:</td>
          <td align="right" style="padding-bottom: 12px;">
            <code style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 4px 10px; border-radius: 6px; font-weight: 800; color: #065f46; font-size: 13px; font-family: monospace;">
              ${data.refundId || 'RF-' + data.orderName}
            </code>
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Refunded Amount:</td>
          <td align="right" style="font-weight: 900; color: #059669; font-size: 18px; padding-bottom: 12px;">
            ₹${refundFormatted}
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Quality Control (QC):</td>
          <td align="right" style="font-weight: 700; color: #065f46; padding-bottom: 12px;">
            Passed 100% (No Defects / Approved)
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Settlement Method:</td>
          <td align="right" style="font-weight: 600; color: #0f172a; padding-bottom: 12px;">
            Original Payment Method (UPI / Bank Account)
          </td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 12px;">Payment Gateway Rail:</td>
          <td align="right" style="font-weight: 600; color: #2563eb; padding-bottom: 12px;">
            ${data.settlementGateway || data.paymentMethod || 'Easebuzz / PhonePe UPI'}
          </td>
        </tr>
        <tr style="border-top: 1px dashed #cbd5e1;">
          <td style="color: #0f172a; font-weight: 750; padding-top: 12px;">Credit Timeline:</td>
          <td align="right" style="font-weight: 700; color: #047857; padding-top: 12px; font-size: 12.5px;">
            UPI: Instant to 2 hrs · Cards/NetBanking: 2-4 days
          </td>
        </tr>
      </table>
    </div>

    <!-- Assurance Callout -->
    <div style="background: #f0fdf4; border-left: 4px solid #059669; border-radius: 6px; padding: 14px 18px; margin-bottom: 24px; font-size: 12.5px; color: #166534; line-height: 1.6;">
      <strong>Settlement Note:</strong> Depending on your banking institution, credits usually appear immediately for UPI or within 2 to 4 business days for credit/debit card statements. If you do not see the credit after 4 business days, please reply directly to this email at <strong>refund@youthnic.com</strong> quoting your <strong>Refund ID: ${data.refundId || 'RF-' + data.orderName}</strong>.
    </div>

    <p style="margin: 0 0 20px 0; font-size: 13.5px; color: #64748b; line-height: 1.6;">
      We truly appreciate your patronage and hope to welcome you back soon on Youthnic!
    </p>

    ${renderItemsSummary(data.items, data.refundAmount || data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'refunds@youthnic.com',
      badgeBg: '#ecfdf5',
      badgeColor: '#059669',
      badgeBorder: '#a7f3d0',
    }),
  };
}

/**
 * 4. CUSTOMER SUPPORT REPLY TEMPLATE (From: contact@youthnic.com)
 * Sent for support inquiries, customer care responses, and general helpdesk tickets.
 */
export function renderSupportReplyEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = data.customMessage?.split('\n')[0]?.substring(0, 80) || `Regarding Order ${data.orderName} — Youthnic Customer Care`;
  const preheader = `Official response from Youthnic Customer Care regarding order ${data.orderName}.`;

  const content = `
    <!-- Support Badge Banner -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td width="36" valign="middle" style="font-size: 24px;">💬</td>
          <td>
            <div style="font-size: 14px; font-weight: 800; color: #0f172a;">Official Message from Youthnic Customer Support</div>
            <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
              Regarding order ${data.orderName} · Surat Customer Care Desk
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Salutation -->
    <h2 class="hero-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
      Dear ${data.customerName || 'Valued Customer'},
    </h2>

    <!-- Agent Response Message Box -->
    <div style="background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 12px; padding: 22px; margin-bottom: 24px; font-size: 14px; color: #1e293b; line-height: 1.7; white-space: pre-wrap; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
${data.customMessage || 'Thank you for contacting Youthnic. Our customer care desk has reviewed your inquiry and is happy to assist you.'}
    </div>

    ${
      data.waybillNumber
        ? `
    <!-- Tracking Quick Reference -->
    <div style="background: #f1f5f9; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; color: #475569;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td>
            <strong>Shipment Tracking:</strong> Delhivery AWB <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-family: monospace;">${data.waybillNumber}</code>
          </td>
          <td align="right">
            <a href="${data.trackingUrl || 'https://www.delhivery.com/track/package/' + data.waybillNumber}" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: 750;">
              Track Live ↗
            </a>
          </td>
        </tr>
      </table>
    </div>
    `
        : ''
    }

    <!-- Reply Guidance Callout -->
    <div style="background: #eff6ff; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px; font-size: 12.5px; color: #1e40af; line-height: 1.6;">
      <strong>Need more assistance?</strong> Simply reply directly to this email at <strong>${CONTACT_EMAIL}</strong> or message our dedicated WhatsApp desk at <strong>${SUPPORT_PHONE}</strong>.
    </div>

    ${data.items && data.items.length > 0 ? renderItemsSummary(data.items, data.totalAmount) : ''}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'support@youthnic.com',
      badgeBg: '#eff6ff',
      badgeColor: '#1d4ed8',
      badgeBorder: '#bfdbfe',
    }),
  };
}

/**
 * 5. RETURN RECEIVED EMAIL TEMPLATE (From: return@youthnic.com)
 */
export function renderReturnReceivedEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Return Package Received at Surat Hub: Order ${data.orderName}`;
  const preheader = `Your returned parcel for order ${data.orderName} has arrived safely at our Surat hub and is undergoing inspection.`;

  const content = `
    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td width="36" valign="middle" style="font-size: 24px;">📦</td>
          <td>
            <div style="font-size: 14px; font-weight: 800; color: #065f46;">Return Item Safely Received at Surat Hub</div>
            <div style="font-size: 12px; color: #047857; margin-top: 2px;">
              Our warehouse quality control team has checked in your package.
            </div>
          </td>
        </tr>
      </table>
    </div>

    <h2 class="hero-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
      Dear ${data.customerName || 'Valued Customer'},
    </h2>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
      We have safely received your returned package for order <strong>${data.orderName}</strong> at our Surat Fulfillment Center.
    </p>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 20px; font-size: 13px; color: #334155; line-height: 1.6;">
      Our quality control team will inspect the item within the next 24 hours. Once verified free of issues, your 100% refund will be disbursed immediately to your original payment mode via <strong>refund@youthnic.com</strong>.
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'returns@youthnic.com',
      badgeBg: '#ecfdf5',
      badgeColor: '#065f46',
      badgeBorder: '#a7f3d0',
    }),
  };
}

/**
 * 6. DISPATCH SLA DELAY TEMPLATE
 */
export function renderDispatchDelayEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Order ${data.orderName}: Handcrafted Quality Inspection & Dispatch Update`;
  const preheader = `Your Youthnic order is currently undergoing final quality inspection before express dispatch.`;

  const content = `
    <div style="background-color: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
      <div style="font-size: 13.5px; font-weight: 750; color: #6d28d9;">Quality Inspection & Dispatch Schedule</div>
      <div style="font-size: 12px; color: #7c3aed; margin-top: 2px;">
        Every garment undergoes detailed hand-inspection at our Surat center before dispatch.
      </div>
    </div>

    <h2 class="hero-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
      Dear ${data.customerName || 'Customer'},
    </h2>
    <p style="margin: 0 0 18px 0; font-size: 14px; line-height: 1.6; color: #475569;">
      Thank you for your order <strong>${data.orderName}</strong>. Our artisans and quality specialists in Surat are completing the final finishing and sizing inspection for your garments.
    </p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 24px; font-size: 13px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #64748b; padding-bottom: 8px;">Current Stage:</td>
          <td align="right" style="font-weight: 700; color: #6d28d9; padding-bottom: 8px;">Final Quality Check & Packaging</td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 8px;">Origin Center:</td>
          <td align="right" style="font-weight: 600; color: #0f172a; padding-bottom: 8px;">Surat Hub, Gujarat</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Expected Dispatch Date:</td>
          <td align="right" style="font-weight: 800; color: #059669;">${data.newEstimatedDelivery || 'Within 24-36 Hours'}</td>
        </tr>
      </table>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#f5f3ff',
      badgeColor: '#6d28d9',
      badgeBorder: '#ddd6fe',
    }),
  };
}

/**
 * 7. IN-TRANSIT REGULAR UPDATE
 */
export function renderInTransitEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Your Youthnic Order ${data.orderName} is on Its Way!`;
  const preheader = `Live tracking update: Order ${data.orderName} is in transit with ${data.courier || 'Delhivery'}.`;

  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <span style="display: inline-block; background-color: #eff6ff; color: #2563eb; font-weight: 700; font-size: 12px; padding: 4px 12px; border-radius: 20px; margin-bottom: 8px;">
        IN TRANSIT
      </span>
      <h2 style="margin: 0; font-size: 22px; font-weight: 800; color: #0f172a;">
        Your Package is on the Move!
      </h2>
      <p style="margin: 6px 0 0 0; font-size: 14px; color: #64748b;">
        Order <strong>${data.orderName}</strong> has departed our Surat center and is en route.
      </p>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px; font-size: 13px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #64748b; padding-bottom: 8px;">AWB Tracking:</td>
          <td align="right" style="font-weight: 700; color: #0f172a; padding-bottom: 8px;">${data.waybillNumber || '—'}</td>
        </tr>
        <tr>
          <td style="color: #64748b; padding-bottom: 8px;">Courier:</td>
          <td align="right" style="font-weight: 600; color: #0f172a; padding-bottom: 8px;">${data.courier || 'Delhivery Express'}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Latest Hub Location:</td>
          <td align="right" style="font-weight: 600; color: #2563eb;">${data.currentLocation || 'In Transit'}</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${data.trackingUrl || 'https://www.delhivery.com/track/package/' + data.waybillNumber}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 14px 28px; border-radius: 8px;">
        Track Shipment Live →
      </a>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#eff6ff',
      badgeColor: '#2563eb',
      badgeBorder: '#bfdbfe',
    }),
  };
}

/**
 * 8. OUT FOR DELIVERY
 */
export function renderOutForDeliveryEmail(data: EmailTemplateData): { subject: string; html: string } {
  const isCod = data.paymentMethod?.toLowerCase().includes('cod');
  const subject = `🚚 Out for Delivery Today: Order ${data.orderName}`;
  const preheader = `Your order is out for delivery today with Delhivery Express!`;

  const content = `
    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px; text-align: center;">
      <div style="font-size: 12px; font-weight: 800; color: #059669; letter-spacing: 1px; text-transform: uppercase;">
        ARRIVING TODAY
      </div>
      <h2 style="margin: 4px 0 0 0; font-size: 22px; font-weight: 800; color: #065f46;">
        Your Package is Out for Delivery!
      </h2>
      <div style="font-size: 13.5px; color: #047857; margin-top: 4px;">
        The Delhivery delivery executive will arrive at your address today.
      </div>
    </div>

    ${
      isCod
        ? `
    <div style="background-color: #fef3c7; border: 2px dashed #f59e0b; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; text-align: center;">
      <div style="font-size: 11.5px; font-weight: 800; color: #b45309; text-transform: uppercase;">Cash on Delivery Notice</div>
      <div style="font-size: 24px; font-weight: 900; color: #92400e; margin: 4px 0;">
        ₹${data.totalAmount || 0}
      </div>
      <div style="font-size: 12.5px; color: #78350f;">
        Please keep cash or your UPI app ready for the courier agent upon arrival.
      </div>
    </div>`
        : ''
    }

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; font-size: 13px;">
      <div style="color: #64748b; margin-bottom: 4px;">Delivery Address:</div>
      <div style="font-weight: 600; color: #0f172a; line-height: 1.4;">${data.customerAddress || 'Customer Address on Record'}</div>
    </div>

    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${data.trackingUrl || 'https://www.delhivery.com/track/package/' + data.waybillNumber}" target="_blank" style="display: inline-block; background-color: #059669; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 14px 28px; border-radius: 8px;">
        View Delivery Agent Status →
      </a>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#ecfdf5',
      badgeColor: '#059669',
      badgeBorder: '#a7f3d0',
    }),
  };
}

/**
 * 9. NDR / RESCHEDULE
 */
export function renderNdrEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `⚠️ Delivery Attempt Unsuccessful: Order ${data.orderName}`;
  const preheader = `Delhivery could not complete delivery today. Confirm your address to reschedule.`;

  const content = `
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
      <div style="font-size: 12px; font-weight: 800; color: #dc2626; text-transform: uppercase;">Action Requested</div>
      <h2 style="margin: 4px 0 0 0; font-size: 20px; font-weight: 800; color: #991b1b;">
        Delivery Attempt Unsuccessful
      </h2>
      <div style="font-size: 13px; color: #b91c1c; margin-top: 4px;">
        Reason: ${data.delayReason || 'Customer unavailable or contact number unanswered'}.
      </div>
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 20px;">
      Hi ${data.customerName || 'Customer'}, Delhivery attempted to deliver your order <strong>${data.orderName}</strong> today but was unable to complete the handover.
      To prevent this order from being returned to our Surat warehouse, please verify your details or request a re-attempt.
    </p>

    <div style="text-align: center; margin-bottom: 24px;">
      <a href="${data.actionUrl || data.trackingUrl || 'https://www.delhivery.com/track/package/' + data.waybillNumber}" target="_blank" style="display: inline-block; background-color: #dc2626; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 14px 28px; border-radius: 8px;">
        Confirm Address & Request Re-Attempt →
      </a>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; font-size: 12.5px; color: #64748b;">
      Need immediate help? Reply to this email or message our WhatsApp desk at <strong>${SUPPORT_PHONE}</strong> with your preferred delivery time.
    </div>
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#fef2f2',
      badgeColor: '#dc2626',
      badgeBorder: '#fecaca',
    }),
  };
}

/**
 * 10. DELIVERED
 */
export function renderDeliveredEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `🎉 Order Delivered: Enjoy Your Youthnic Wear! (${data.orderName})`;
  const preheader = `Your order ${data.orderName} has been delivered. Easy 7-day size exchange available.`;

  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="font-size: 40px; margin-bottom: 8px;">🌸</div>
      <h2 style="margin: 0; font-size: 22px; font-weight: 800; color: #0f172a;">
        Your Package Has Arrived!
      </h2>
      <p style="margin: 8px 0 0 0; font-size: 14px; color: #64748b;">
        Your order <strong>${data.orderName}</strong> was successfully delivered by Delhivery.
      </p>
    </div>

    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px; text-align: center;">
      <div style="font-size: 13.5px; font-weight: 750; color: #065f46;">Hassle-Free 7-Day Size Exchange</div>
      <div style="font-size: 12px; color: #047857; margin-top: 4px;">
        Garment too loose or tight? Our Surat team offers instant size swaps.
      </div>
      <div style="margin-top: 12px;">
        <a href="https://wa.me/918866154721?text=Hi%20Youthnic,%20I%20would%20like%20to%20request%20a%20size%20exchange%20for%20order%20${data.orderName}" target="_blank" style="display: inline-block; background-color: #059669; color: #ffffff; font-size: 12px; font-weight: 700; text-decoration: none; padding: 8px 18px; border-radius: 6px;">
          Request Exchange on WhatsApp →
        </a>
      </div>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'delivery@youthnic.com',
      badgeBg: '#ecfdf5',
      badgeColor: '#059669',
      badgeBorder: '#a7f3d0',
    }),
  };
}

/**
 * 11. ORDER CONFIRMED
 */
export function renderOrderConfirmedEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = `Order Confirmed: ${data.orderName} — Thank You for Choosing Youthnic`;
  const preheader = `We have received your order ${data.orderName}. Our Surat team is preparing your package.`;

  const content = `
    <h2 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; color: #0f172a;">
      Thank You for Your Order, ${data.customerName || 'Customer'}!
    </h2>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
      We have confirmed your order <strong>${data.orderName}</strong>. Our Surat fulfillment center will carefully pack and dispatch your garments shortly.
    </p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 24px; font-size: 13px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #64748b; padding-bottom: 8px;">Payment Mode:</td>
          <td align="right" style="font-weight: 600; color: #0f172a; padding-bottom: 8px;">${data.paymentMethod || 'Prepaid'}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Shipping Destination:</td>
          <td align="right" style="font-weight: 600; color: #0f172a;">${data.customerAddress || 'India'}</td>
        </tr>
      </table>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'support@youthnic.com',
      badgeBg: '#f8fafc',
      badgeColor: '#0f172a',
      badgeBorder: '#e2e8f0',
    }),
  };
}

/**
 * 12. CUSTOM EMAIL
 */
export function renderCustomEmail(data: EmailTemplateData): { subject: string; html: string } {
  const subject = data.orderName ? `Important Update regarding Order ${data.orderName}` : `A Message from ${BRAND_NAME}`;
  const preheader = data.customMessage?.slice(0, 100) || `Updates from ${BRAND_NAME} Customer Desk`;

  const content = `
    <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 800; color: #0f172a;">
      Dear ${data.customerName || 'Customer'},
    </h2>
    <div style="font-size: 14px; line-height: 1.7; color: #334155; margin-bottom: 24px; white-space: pre-line;">
      ${data.customMessage || 'We hope you are enjoying your experience with Youthnic.'}
    </div>

    ${
      data.actionUrl
        ? `
    <div style="text-align: center; margin-bottom: 28px;">
      <a href="${data.actionUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 14px 28px; border-radius: 8px;">
        View Details →
      </a>
    </div>`
        : ''
    }

    ${data.items && data.items.length > 0 ? renderItemsSummary(data.items, data.totalAmount) : ''}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: data.badgeText || 'Customer Notification',
    }),
  };
}

// ─── Itemized Summary Helper ─────────────────────────────
function renderItemsSummary(items?: EmailTemplateData['items'], totalAmount?: number): string {
  if (!items || items.length === 0) return '';

  const rows = items
    .map(
      (item) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #f1f5f9;">
        <strong style="color: #0f172a; font-size: 12.5px; display: block;">${item.title}</strong>
        ${item.variantTitle ? `<span style="font-size: 11px; color: #64748b;">Variant: ${item.variantTitle}</span>` : ''}
      </td>
      <td align="center" style="padding: 10px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; font-size: 12.5px;">
        × ${item.quantity}
      </td>
      <td align="right" style="padding: 10px 0; border-bottom: 1px solid #f1f5f9; font-weight: 700; color: #0f172a; font-size: 12.5px;">
        ₹${(item.price * item.quantity).toLocaleString('en-IN')}
      </td>
    </tr>`
    )
    .join('');

  return `
    <div style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 18px;">
      <div style="font-size: 12px; font-weight: 750; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Order Items Summary
      </div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        ${rows}
        ${
          totalAmount !== undefined
            ? `
        <tr>
          <td colspan="2" style="padding-top: 12px; font-size: 13.5px; font-weight: 750; color: #0f172a;">
            Total Order Value
          </td>
          <td align="right" style="padding-top: 12px; font-size: 15px; font-weight: 900; color: #0f172a;">
            ₹${totalAmount.toLocaleString('en-IN')}
          </td>
        </tr>`
            : ''
        }
      </table>
    </div>
  `;
}
