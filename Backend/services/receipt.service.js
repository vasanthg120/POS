'use strict';

const nodemailer = require('nodemailer');

// ── Singleton transporter (Gmail — same config as email.js) ──────────────────
let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    global.logger?.error(
      '[Receipt] Missing SMTP_USER or SMTP_PASS environment variables. ' +
      'Set these in your .env file. SMTP_PASS must be a Gmail App Password (16 chars, no spaces).'
    );
    throw new Error('[Receipt] SMTP_USER and SMTP_PASS must be set in environment variables');
  }

  _transporter = nodemailer.createTransport({
    host  : 'smtp.gmail.com',
    port  : 465,
    secure: true,
    auth  : { user: smtpUser, pass: smtpPass },
    pool:           true,
    maxConnections: 5,
    maxMessages:    100,
    rateDelta:      1000,
    rateLimit:      5,
  });

  _transporter.verify((err) => {
    if (err) global.logger?.error('[Receipt] SMTP connection failed:', err.message);
    else     global.logger?.info('[Receipt] SMTP connection verified successfully');
  });

  return _transporter;
};

// ─── Currency formatter ───────────────────────────────────────────────────────
const fmt = (amount, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
};

// ─── Date formatter ───────────────────────────────────────────────────────────
const fmtDate = (d) =>
  new Date(d).toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

// ─── Gateway helpers ──────────────────────────────────────────────────────────
const gwColour = (gw) => (gw === 'razorpay' ? '#072654' : '#635BFF');
const gwLabel  = (gw) => (gw === 'razorpay' ? 'Razorpay' : 'Stripe');

// ─── HTML escape ──────────────────────────────────────────────────────────────
const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── Receipt number generator ─────────────────────────────────────────────────
const generateReceiptNumber = () => {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand     = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FPI-QT-${datePart}-${rand}`;
};

// ─── Resolve quotation number ─────────────────────────────────────────────────
const resolveQuotationNo = (order) =>
  order.quotationNo || order.items?.[0]?.name || order.orderNumber || '—';

// ─── HTML receipt template ────────────────────────────────────────────────────
const buildReceiptHtml = ({ order, payment, receiptNumber, downloadUrl }) => {
  const quotationNo = resolveQuotationNo(order);

  const items = (order.items || []).map((item) => `
    <tr>
      <td style="padding:14px 20px;border-bottom:1px solid #e8f0f8;font-size:14px;color:#1a2940;">
        Payment
        <div style="font-size:12px;color:#6b8fb5;margin-top:3px;">
          Quotation No: ${escHtml(item.name)}
        </div>
      </td>
      <td style="padding:14px 20px;border-bottom:1px solid #e8f0f8;font-size:14px;color:#4a6a8a;text-align:center;">
        ${item.quantity}
      </td>
      <td style="padding:14px 20px;border-bottom:1px solid #e8f0f8;font-size:14px;color:#4a6a8a;text-align:right;">
        ${fmt(item.unitPrice, order.currency)}
      </td>
      <td style="padding:14px 20px;border-bottom:1px solid #e8f0f8;font-size:14px;font-weight:600;color:#1a2940;text-align:right;">
        ${fmt(item.totalPrice || item.unitPrice * item.quantity, order.currency)}
      </td>
    </tr>`).join('');

  const subtotal = order.subtotal || order.total;
  const discount = order.discount || 0;
  const shipping = order.shipping || 0;
  const total    = order.total;
  const currency = order.currency || 'USD';
  const gateway  = payment?.gateway || 'stripe';
  const pmMethod = payment?.paymentMethod?.type || 'card';
  const last4    = payment?.paymentMethod?.last4;
  const txId     = payment?.gatewayPaymentId || '—';
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER || 'team@pantheras.io';

  const downloadBlock = downloadUrl ? `
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-top:1px solid #e8f0f8;padding:24px 40px 0;margin-top:4px;">
      <tr>
        <td style="text-align:center;padding-bottom:8px;">
          <div style="font-size:13px;color:#4a6a8a;margin-bottom:14px;">
            You can also download your quotation as a PDF:
          </div>
          <a href="${escHtml(downloadUrl)}"
             style="display:inline-block;background:#0e64a3;color:#fff;
                    text-decoration:none;font-size:14px;font-weight:700;
                    padding:13px 28px;border-radius:10px;">
            &#x2193;&nbsp; Download Quotation (PDF)
          </a>
          <div style="font-size:11px;color:#8aaece;margin-top:10px;">Link valid for 30 days</div>
        </td>
      </tr>
    </table>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Quotation – ${escHtml(quotationNo)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#edf2fb;font-family:'DM Sans',Arial,sans-serif;-webkit-font-smoothing:antialiased;}
  a{color:#0e64a3;text-decoration:none;}
</style>
</head>
<body style="background:#edf2fb;padding:32px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;">

  <!-- HEADER -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:linear-gradient(135deg,#0a3d6b 0%,#0e64a3 60%,#1a80cc 100%);
                  border-radius:16px 16px 0 0;padding:36px 40px;">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;color:rgba(255,255,255,0.55);text-transform:uppercase;margin-bottom:6px;">Quotation</div>
          <div style="font-size:28px;font-weight:700;color:#fff;letter-spacing:-0.02em;line-height:1.1;">Fully Promoted India</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.65);margin-top:4px;">${escHtml(adminEmail)}</div>
        </td>
        <td style="text-align:right;vertical-align:top;">
          <div style="display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);border-radius:10px;padding:10px 16px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;color:rgba(255,255,255,0.6);text-transform:uppercase;">Quotation No.</div>
            <div style="font-size:15px;font-weight:700;color:#fff;margin-top:2px;letter-spacing:0.04em;">${escHtml(quotationNo)}</div>
          </div>
        </td>
      </tr>
      <tr><td colspan="2" style="padding-top:28px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:rgba(255,255,255,0.15);border-radius:8px;padding:10px 16px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:22px;height:22px;background:#22c55e;border-radius:50%;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:13px;line-height:22px;">&#10003;</span>
                  </td>
                  <td style="padding-left:10px;font-size:14px;font-weight:600;color:#fff;">Payment Confirmed</td>
                  <td style="padding-left:20px;font-size:12px;color:rgba(255,255,255,0.65);">${fmtDate(payment?.createdAt || new Date())}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#fff;padding:0 40px;">

    <!-- Amount hero -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e8f0f8;padding:32px 0;">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;color:#6b8fb5;text-transform:uppercase;margin-bottom:6px;">Amount Paid</div>
          <div style="font-size:40px;font-weight:700;color:#0a1929;letter-spacing:-0.02em;line-height:1;">${fmt(total, currency)}</div>
          <div style="margin-top:10px;">
            <table cellpadding="0" cellspacing="0" style="display:inline-table;">
              <tr>
                <td style="background:${gwColour(gateway)}18;border:1px solid ${gwColour(gateway)}33;color:${gwColour(gateway)};border-radius:20px;padding:4px 12px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;white-space:nowrap;">via ${gwLabel(gateway)}</td>
                <td style="width:8px;"></td>
                <td style="background:#f0f6ff;border:1px solid #c8dced;color:#4a6a8a;border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600;text-transform:capitalize;white-space:nowrap;">${pmMethod}${last4 ? ' &bull;&bull;&bull;&bull; ' + last4 : ''}</td>
              </tr>
            </table>
          </div>
        </td>
        <td style="text-align:right;vertical-align:top;">
          <table cellpadding="0" cellspacing="0" style="margin-left:auto;">
            <tr>
              <td style="font-size:12px;color:#6b8fb5;padding-right:12px;">Quotation No.</td>
              <td style="font-size:12px;font-weight:600;color:#1a2940;">${escHtml(quotationNo)}</td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#6b8fb5;padding-right:12px;padding-top:6px;">Currency</td>
              <td style="font-size:12px;font-weight:600;color:#1a2940;padding-top:6px;">${currency}</td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#6b8fb5;padding-right:12px;padding-top:6px;">Transaction ID</td>
              <td style="font-size:12px;font-weight:600;color:#1a2940;padding-top:6px;word-break:break-all;max-width:200px;">${escHtml(txId)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Billed to -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e8f0f8;padding:24px 0;">
      <tr>
        <td style="width:50%;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:#6b8fb5;text-transform:uppercase;margin-bottom:10px;">Billed To</div>
          <div style="font-size:15px;font-weight:600;color:#1a2940;">${escHtml(order.customerInfo?.name || '—')}</div>
          <div style="font-size:13px;color:#4a6a8a;margin-top:3px;">${escHtml(order.customerInfo?.email || '—')}</div>
          ${order.customerInfo?.phone ? `<div style="font-size:13px;color:#4a6a8a;margin-top:2px;">${escHtml(order.customerInfo.phone)}</div>` : ''}
        </td>
        <td style="width:50%;vertical-align:top;text-align:right;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:#6b8fb5;text-transform:uppercase;margin-bottom:10px;">From</div>
          <div style="font-size:15px;font-weight:600;color:#1a2940;">Fully Promoted India</div>
          <div style="font-size:13px;color:#4a6a8a;margin-top:3px;">${escHtml(adminEmail)}</div>
        </td>
      </tr>
    </table>

    <!-- Items -->
    <div style="padding:24px 0 0;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:#6b8fb5;text-transform:uppercase;margin-bottom:14px;">Order Items</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8f0f8;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f8fd;">
            <th style="padding:11px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#6b8fb5;text-transform:uppercase;text-align:left;">Description</th>
            <th style="padding:11px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#6b8fb5;text-transform:uppercase;text-align:center;">Qty</th>
            <th style="padding:11px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#6b8fb5;text-transform:uppercase;text-align:right;">Unit Price</th>
            <th style="padding:11px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#6b8fb5;text-transform:uppercase;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>
    </div>

    <!-- Totals -->
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 0 28px;">
      <tr>
        <td width="60%"></td>
        <td width="40%">
          ${subtotal !== total ? `
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:#6b8fb5;padding-bottom:6px;">Subtotal</td>
              <td style="font-size:13px;color:#4a6a8a;text-align:right;padding-bottom:6px;">${fmt(subtotal, currency)}</td>
            </tr>
            ${discount > 0 ? `<tr><td style="font-size:13px;color:#22c55e;padding-bottom:6px;">Discount</td><td style="font-size:13px;color:#22c55e;text-align:right;padding-bottom:6px;">&minus;${fmt(discount, currency)}</td></tr>` : ''}
            ${shipping > 0 ? `<tr><td style="font-size:13px;color:#6b8fb5;padding-bottom:6px;">Shipping</td><td style="font-size:13px;color:#4a6a8a;text-align:right;padding-bottom:6px;">${fmt(shipping, currency)}</td></tr>` : ''}
            <tr><td colspan="2" style="padding:8px 0;"><div style="height:1px;background:#e8f0f8;"></div></td></tr>
          </table>` : ''}
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="background:linear-gradient(135deg,#f0f7ff,#e8f2fc);border:1px solid #c8dced;border-radius:10px;padding:14px 18px;">
            <tr>
              <td style="font-size:16px;font-weight:700;color:#0a1929;">Total Paid</td>
              <td style="font-size:20px;font-weight:700;color:#0e64a3;text-align:right;letter-spacing:-0.01em;">${fmt(total, currency)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${downloadBlock}

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f4f8fd;border-top:1px solid #e8f0f8;border-radius:0 0 16px 16px;padding:24px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:12px;color:#6b8fb5;line-height:1.6;">
          <strong style="color:#1a2940;">Fully Promoted India</strong><br/>
          This is a computer-generated quotation and does not require a signature.<br/>
          For queries, contact <a href="mailto:${escHtml(adminEmail)}">${escHtml(adminEmail)}</a>
        </td>
        <td style="text-align:right;vertical-align:top;">
          <table cellpadding="0" cellspacing="4">
            <tr>
              <td style="font-size:10px;font-weight:700;letter-spacing:0.06em;background:#e8f2fc;border:1px solid #c8dced;color:#4a6a8a;border-radius:4px;padding:3px 8px;text-transform:uppercase;">PCI DSS</td>
              <td style="font-size:10px;font-weight:700;letter-spacing:0.06em;background:#e8f2fc;border:1px solid #c8dced;color:#4a6a8a;border-radius:4px;padding:3px 8px;text-transform:uppercase;">256-bit SSL</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
<div style="text-align:center;padding:20px 0;font-size:11px;color:#8aaece;">
  &copy; ${new Date().getFullYear()} Fully Promoted India &middot; All rights reserved
</div>
</body>
</html>`;
};

// ─── Plain-text fallback ──────────────────────────────────────────────────────
const buildReceiptText = ({ order, payment, receiptNumber, downloadUrl }) => {
  const quotationNo = resolveQuotationNo(order);
  const total       = order.total;
  const currency    = order.currency || 'USD';
  const gateway     = payment?.gateway || 'stripe';
  const txId        = payment?.gatewayPaymentId || '—';

  return [
    '====================================================',
    '  FULLY PROMOTED INDIA — QUOTATION',
    '====================================================',
    `  Quotation No. : ${quotationNo}`,
    `  Receipt Ref.  : ${receiptNumber}`,
    `  Date          : ${fmtDate(payment?.createdAt || new Date())}`,
    `  Order No.     : ${order.orderNumber || '—'}`,
    `  Transaction   : ${txId}`,
    '----------------------------------------------------',
    `  Billed To   : ${order.customerInfo?.name  || '—'}`,
    `  Email       : ${order.customerInfo?.email || '—'}`,
    `  Phone       : ${order.customerInfo?.phone || '—'}`,
    '----------------------------------------------------',
    '  ITEMS',
    ...(order.items || []).map(
      (i) => `  · Payment (Quotation No: ${i.name}) × ${i.quantity}  —  ${fmt(i.totalPrice || i.unitPrice * i.quantity, currency)}`
    ),
    '----------------------------------------------------',
    `  TOTAL PAID  : ${fmt(total, currency)}  via ${gwLabel(gateway)}`,
    '====================================================',
    ...(downloadUrl ? ['', `  Download PDF: ${downloadUrl}`, ''] : []),
    `  Fully Promoted India · ${process.env.ADMIN_EMAIL || process.env.SMTP_USER || 'team@pantheras.io'}`,
    '====================================================',
  ].join('\n');
};

// ─── Admin notification HTML ──────────────────────────────────────────────────
const buildAdminHtml = ({ order, payment, receiptNumber }) => {
  const quotationNo = resolveQuotationNo(order);
  const total       = order.total;
  const currency    = order.currency || 'USD';
  const gateway     = payment?.gateway || 'stripe';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>New Payment Alert</title></head>
<body style="background:#f4f8fd;font-family:Arial,sans-serif;padding:24px;">
<table style="max-width:540px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #c8dced;overflow:hidden;" cellpadding="0" cellspacing="0">
  <tr>
    <td style="background:#0a3d6b;padding:24px 32px;">
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);letter-spacing:0.1em;text-transform:uppercase;">Admin Alert</div>
      <div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">New Payment Received</div>
    </td>
  </tr>
  <tr>
    <td style="padding:28px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:32px;font-weight:700;color:#0e64a3;padding-bottom:20px;">${fmt(total, currency)}</td></tr>
        ${[
          ['Quotation No.', quotationNo],
          ['Receipt Ref.',  receiptNumber],
          ['Customer',      order.customerInfo?.name],
          ['Email',         order.customerInfo?.email],
          ['Phone',         order.customerInfo?.phone || '—'],
          ['Notes',         order.notes || '—'],
          ['Order No.',     order.orderNumber],
          ['Currency',      currency],
          ['Gateway',       gwLabel(gateway)],
          ['Txn ID',        payment?.gatewayPaymentId || '—'],
          ['Status',        'Paid'],
        ].map(([k, v]) => `
        <tr>
          <td style="font-size:12px;color:#6b8fb5;padding:5px 0;width:120px;">${escHtml(k)}</td>
          <td style="font-size:13px;font-weight:600;color:#1a2940;padding:5px 0;">${escHtml(String(v ?? '—'))}</td>
        </tr>`).join('')}
      </table>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e8f0f8;font-size:12px;color:#8aaece;text-align:center;">
        Fully Promoted India Admin System &middot; ${new Date().toISOString()}
      </div>
    </td>
  </tr>
</table>
</body></html>`;
};

// ─── Main send function ───────────────────────────────────────────────────────
const sendPaymentReceipt = async ({ order, payment, downloadUrl }) => {
  const transporter   = getTransporter();
  const receiptNumber = generateReceiptNumber();
  const customerEmail = order.customerInfo?.email;
  const quotationNo   = resolveQuotationNo(order);

  if (!customerEmail) {
    throw new Error('[Receipt] order.customerInfo.email is missing — cannot send quotation');
  }

  const adminEmail  = process.env.ADMIN_EMAIL || process.env.SMTP_USER || 'team@pantheras.io';
  const fromAddress = `"Fully Promoted India" <${process.env.SMTP_USER}>`;
  const subject     = `Quotation ${quotationNo} — ${fmt(order.total, order.currency)}`;
  const context     = { order, payment, receiptNumber, downloadUrl };

  const [customerResult, adminResult] = await Promise.allSettled([
    transporter.sendMail({
      from: fromAddress, to: customerEmail, subject,
      text: buildReceiptText(context), html: buildReceiptHtml(context),
      headers: {
        'X-Quotation-Number': quotationNo,
        'X-Receipt-Ref':      receiptNumber,
        'X-Order-ID':         String(order._id),
      },
    }),
    transporter.sendMail({
      from: fromAddress, to: adminEmail,
      subject: `[Admin] New Payment ${quotationNo} — ${order.customerInfo?.name}`,
      text: buildReceiptText(context), html: buildAdminHtml(context),
      headers: {
        'X-Quotation-Number': quotationNo,
        'X-Receipt-Ref':      receiptNumber,
        'X-Order-ID':         String(order._id),
      },
    }),
  ]);

  if (customerResult.status === 'rejected') throw customerResult.reason;

  if (adminResult.status === 'rejected') {
    global.logger?.warn('[Receipt] Admin notification failed (non-fatal):', adminResult.reason);
  }

  global.logger?.info(
    `[Receipt] Sent ${quotationNo} (ref: ${receiptNumber}) → customer: ${customerEmail}, admin: ${adminEmail}`
  );

  return {
    receiptNumber,
    customerResult: customerResult.value,
    adminResult:    adminResult.status === 'fulfilled' ? adminResult.value : null,
  };
};

module.exports = { sendPaymentReceipt, generateReceiptNumber, buildReceiptHtml };