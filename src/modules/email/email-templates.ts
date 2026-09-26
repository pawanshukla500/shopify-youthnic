/**
 * 21st.dev Inspired Logistics & Brand Email Templates for Youthnic
 * High-polish, mobile-responsive HTML templates compatible with all major email clients.
 * Official Youthnic Black Logo embedded directly.
 */

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
const BRAND_TAGLINE = 'Ethnic Elegance · Surat Fulfillment Center';
const SUPPORT_PHONE = '+91 88661 54721';
const CONTACT_EMAIL = 'contact@youthnic.com';
const RETURN_EMAIL = 'return@youthnic.com';
const REFUND_EMAIL = 'refund@youthnic.com';
const DELIVERY_EMAIL = 'delivery@youthnic.com';

// Official Youthnic Logo - Black for Light Mode & Pure White for Dark Mode (Base64 data URIs)
const YOUTHNIC_LOGO_BLACK_BASE64 = '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';
const YOUTHNIC_LOGO_WHITE_BASE64 = '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';
const YOUTHNIC_LOGO_BASE64 = YOUTHNIC_LOGO_BLACK_BASE64;


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
                      <!-- Light Mode: Full Black Wordmark Logo -->
                      <img class="light-logo" src="data:image/png;base64,${YOUTHNIC_LOGO_BLACK_BASE64}" alt="Youthnic" style="max-width: 175px; width: 100%; height: auto; display: block; border: 0;" />
                      <!-- Dark Mode: Full Pure White Wordmark Logo -->
                      <!--[if !mso]><!-->
                      <div class="dark-logo-wrap" style="display: none; mso-hide: all;">
                        <img class="dark-logo" src="data:image/png;base64,${YOUTHNIC_LOGO_WHITE_BASE64}" alt="Youthnic" style="max-width: 175px; width: 100%; height: auto; display: block; border: 0;" />
                      </div>
                      <!--<![endif]-->
                      <div class="brand-tagline" style="font-size: 11px; color: #64748b; margin-top: 6px; letter-spacing: 0.3px; font-weight: 500;">
                        ${BRAND_TAGLINE}
                      </div>
                    </div>
                  </td>
                  <td align="right" valign="top">
                    <!-- Right-aligned sender desk pill badge -->
                    <span style="display: inline-block; padding: 6px 14px; background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; border-radius: 9999px; font-size: 11px; font-weight: 750; color: ${badgeColor}; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
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
      <div style="margin-bottom: 8px; font-size: 13px; color: #1e293b;">
        <strong>AWB:</strong> <span style="font-family: monospace; font-size: 12.5px;">${data.waybillNumber || 'PROP0000031386'}</span>
      </div>
      <div style="margin-bottom: 8px; font-size: 13px; color: #1e293b;">
        <strong>Current Hub:</strong> <span>${data.currentLocation || 'Bhiwandi Sorting Center Hub'}</span>
      </div>
      <div style="font-size: 13px; color: #1e293b;">
        <strong>Revised Expected Delivery:</strong> <span>${data.newEstimatedDelivery || 'Saturday, 28-Sep-2026'}</span>
      </div>
    </div>

    <!-- Centered Blue CTA Button matching media_1790339742746.png -->
    <div style="text-align: center; margin: 24px 0 12px 0;">
      <a href="${data.trackingUrl || 'https://www.delhivery.com/track/package/' + (data.waybillNumber || '')}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 13.5px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.25);">
        Track Live Delivery →
      </a>
    </div>

    ${renderItemsSummary(data.items, data.totalAmount)}
  `;

  return {
    subject,
    html: baseEmailLayout(content, preheader, {
      badgeText: 'DELIVERY@YOUTHNIC.COM',
      badgeBg: '#eef2f6',
      badgeColor: '#334155',
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
      badgeText: 'RETURN@YOUTHNIC.COM',
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
      badgeText: 'REFUND@YOUTHNIC.COM',
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
      badgeText: 'CONTACT@YOUTHNIC.COM',
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
      badgeText: 'RETURN@YOUTHNIC.COM',
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
      badgeText: 'DELIVERY@YOUTHNIC.COM',
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
      badgeText: 'DELIVERY@YOUTHNIC.COM',
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
      badgeText: 'DELIVERY@YOUTHNIC.COM',
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
      badgeText: 'DELIVERY@YOUTHNIC.COM',
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
      badgeText: 'DELIVERY@YOUTHNIC.COM',
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
      badgeText: 'CONTACT@YOUTHNIC.COM',
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
