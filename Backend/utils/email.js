'use strict';

const nodemailer = require('nodemailer');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const COMPANY_LOGO = () =>
  process.env.COMPANY_LOGO ||
  `${(process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/assets/images/fp.png`;

// ─────────────────────────────────────────────────────────────
// Singleton SMTP Transporter
// ─────────────────────────────────────────────────────────────
let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    throw new Error(
      '[Email] SMTP_USER and SMTP_PASS must be configured in environment variables'
    );
  }

  _transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
  });

  _transporter.verify((err) => {
    if (err) {
      logger.error('[Email] SMTP verification failed:', err.message);
    } else {
      logger.info('[Email] SMTP transporter verified successfully');
    }
  });

  return _transporter;
};

// ─────────────────────────────────────────────────────────────
// ENV HELPERS
// ─────────────────────────────────────────────────────────────
const FROM = () =>
  process.env.SMTP_FROM ||
  `"Fully Promoted India" <${process.env.SMTP_USER}>`;

const ADMIN_EMAIL = () =>
  process.env.ADMIN_EMAIL ||
  process.env.SMTP_USER ||
  'support@fullypromotedindia.com';

const FRONTEND_BASE = () =>
  (process.env.FRONTEND_URL || 'https://payment.pantheras.io').replace(/\/$/, '');

const COMPANY_NAME = process.env.COMPANY_NAME || 'Fully Promoted India';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const round2Ish = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────
// ENTERPRISE LIGHT THEME MAIL TEMPLATE
// ─────────────────────────────────────────────────────────────
const wrap = ({ title, subtitle = '', body }) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  *{ box-sizing:border-box; }
  body{ margin:0; padding:0; background:#f1f5f9; font-family:'DM Sans',Arial,sans-serif; color:#0f172a; }
  table{ border-collapse:collapse; }
  .mail-wrapper{ width:100%; padding:40px 18px; background:#f1f5f9; }
  .mail-container{ max-width:620px; margin:0 auto; background:#ffffff; border-radius:20px; overflow:hidden; border:1px solid #e2e8f0; box-shadow:0 4px 20px rgba(15,23,42,.06),0 2px 8px rgba(15,23,42,.04); }
  .mail-header{ background:linear-gradient(135deg,#ffffff 0%,#f8fafc 40%,#eef6ff 100%); padding:32px 36px; border-bottom:1px solid #e2e8f0; position:relative; }
  .mail-header::after{ content:''; position:absolute; bottom:0; left:0; width:100%; height:3px; background:linear-gradient(90deg,#0ea5e9,#1e40af,#4f46e5); }
  .logo{ height:54px; object-fit:contain; margin-bottom:22px; }
  .header-title{ margin:0; font-size:28px; line-height:1.2; font-weight:800; color:#0f172a; letter-spacing:-0.5px; }
  .header-subtitle{ margin-top:10px; color:#64748b; font-size:14px; line-height:1.7; max-width:460px; }
  .mail-body{ padding:38px 36px; }
  .mail-body p{ margin:0 0 18px; font-size:15px; line-height:1.8; color:#334155; }
  .mail-body strong{ color:#0f172a; }
  .btn{ display:inline-block; background:linear-gradient(135deg,#0ea5e9,#1e40af); color:#ffffff !important; text-decoration:none; padding:14px 28px; border-radius:12px; font-size:14px; font-weight:700; margin:14px 0 24px; box-shadow:0 4px 22px rgba(14,165,233,.22); }
  .btn:hover{ opacity:.95; }
  .info-box{ background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:18px; margin:22px 0; }
  .code-box{ background:#ffffff; border:1px solid #cbd5e1; border-radius:12px; padding:14px 16px; font-family:'DM Mono',monospace; font-size:13px; line-height:1.7; color:#334155; word-break:break-all; }
  .detail-table{ width:100%; margin:20px 0 24px; border:1px solid #e2e8f0; border-radius:14px; overflow:hidden; background:#ffffff; }
  .detail-table tr{ border-bottom:1px solid #e2e8f0; }
  .detail-table tr:last-child{ border-bottom:none; }
  .detail-table td{ padding:16px 18px; font-size:14px; }
  .detail-label{ color:#64748b; }
  .detail-value{ text-align:right; font-weight:700; color:#0f172a; }
  .mail-footer{ padding:24px 36px 32px; background:#f8fafc; border-top:1px solid #e2e8f0; }
  .footer-company{ font-size:13px; font-weight:700; color:#0f172a; margin-bottom:6px; }
  .footer-text{ font-size:12px; color:#64748b; line-height:1.7; }
  .footer-link{ color:#1e40af; text-decoration:none; font-weight:600; }
  @media only screen and (max-width:640px){
    .mail-wrapper{ padding:18px 10px; }
    .mail-header,.mail-body,.mail-footer{ padding-left:22px; padding-right:22px; }
    .header-title{ font-size:24px; }
    .btn{ width:100%; text-align:center; }
  }
</style>
</head>
<body>
<div class="mail-wrapper">
  <div class="mail-container">
    <div class="mail-header">
<img src="${COMPANY_LOGO()}" alt="${COMPANY_NAME}" class="logo" style="display:block;height:54px;width:auto;object-fit:contain;margin-bottom:22px;" />

      <h1 class="header-title">${title}</h1>
      ${subtitle ? `<div class="header-subtitle">${subtitle}</div>` : ''}
    </div>
    <div class="mail-body">${body}</div>
    <div class="mail-footer">
      <div class="footer-company">${COMPANY_NAME}</div>
      <div class="footer-text">
        This is an automated email from ${COMPANY_NAME}.<br />
        Need help? <a class="footer-link" href="mailto:${ADMIN_EMAIL()}">${ADMIN_EMAIL()}</a>
      </div>
    </div>
  </div>
</div>
</body>
</html>
`;

// ─────────────────────────────────────────────────────────────
// GENERIC SEND HELPER
// ─────────────────────────────────────────────────────────────
const send = async ({ to, subject, html, attachments }) => {
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({ from: FROM(), to, subject, html, attachments });
    logger.info(`[Email] "${subject}" sent successfully to ${to} | ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`[Email] Failed sending "${subject}" to ${to}: ${err.message}`);
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────
// 1. VERIFY EMAIL
// ─────────────────────────────────────────────────────────────
exports.sendVerificationEmail = async (tenant, token) => {
  const name = tenant.firstName || tenant.email;
  const url = `${FRONTEND_BASE()}/verify-email?token=${token}`;

  return send({
    to: tenant.email,
    subject: `Verify Your Email Address - ${COMPANY_NAME}`,
    html: wrap({
      title: 'Verify Your Email',
      subtitle: 'Secure your account and activate access to your platform dashboard.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          Thank you for registering with ${COMPANY_NAME}.
          Please verify your email address to activate your account.
        </p>
        <a href="${url}" class="btn">Verify Email Address</a>
        <div class="info-box">
          <p style="margin-bottom:10px;">If the button above does not work, copy and paste this link:</p>
          <div class="code-box">${url}</div>
        </div>
        <p>This verification link will expire in <strong>24 hours</strong>.</p>
        <p>If you did not create this account, you can safely ignore this email.</p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 2. PASSWORD RESET
// ─────────────────────────────────────────────────────────────
exports.sendPasswordResetEmail = async (tenant, token) => {
  const name = tenant.firstName || tenant.email;
  const url = `${FRONTEND_BASE()}/auth/reset-password?token=${token}`;

  return send({
    to: tenant.email,
    subject: `Reset Your Password - ${COMPANY_NAME}`,
    html: wrap({
      title: 'Password Reset Request',
      subtitle: 'A secure request was received to reset your account password.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          We received a request to reset your account password.
          Click the button below to create a new password.
        </p>
        <a href="${url}" class="btn">Reset Password</a>
        <div class="info-box">
          <p style="margin-bottom:10px;">If the button does not work, use this secure link:</p>
          <div class="code-box">${url}</div>
        </div>
        <p>This password reset link will expire in <strong>30 minutes</strong>.</p>
        <p>If you did not request this reset, no changes will be made to your account.</p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 3. PASSWORD CHANGED
// ─────────────────────────────────────────────────────────────
exports.sendPasswordChangedEmail = async (tenant) => {
  const name = tenant.firstName || tenant.email;

  return send({
    to: tenant.email,
    subject: `Password Updated Successfully - ${COMPANY_NAME}`,
    html: wrap({
      title: 'Password Updated',
      subtitle: 'Your account password has been changed successfully.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your account password was changed successfully.</p>
        <p>If you made this change, no further action is required.</p>
        <p>If you did not make this change, please contact support immediately:</p>
        <div class="code-box">${ADMIN_EMAIL()}</div>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 4. PAYMENT CONFIRMATION
// ─────────────────────────────────────────────────────────────
exports.sendPaymentConfirmation = async (toEmail, name, amount, currency, orderId) => {
  const formatted = `${currency} ${(amount / 100).toFixed(2)}`;

  return send({
    to: toEmail,
    subject: `Payment Confirmation - ${formatted}`,
    html: wrap({
      title: 'Payment Successful',
      subtitle: 'Your payment has been processed and confirmed successfully.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>We have successfully received your payment.</p>
        <table class="detail-table">
          <tr>
            <td class="detail-label">Payment Amount</td>
            <td class="detail-value">${formatted}</td>
          </tr>
          <tr>
            <td class="detail-label">Order ID</td>
            <td class="detail-value">${orderId}</td>
          </tr>
          <tr>
            <td class="detail-label">Payment Status</td>
            <td class="detail-value">Success</td>
          </tr>
        </table>
        <p>Thank you for choosing ${COMPANY_NAME}.</p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 5. SUB-USER INVITE  (temp password flow)
// ─────────────────────────────────────────────────────────────
exports.sendSubUserInviteEmail = async (member, tempPassword, roleName, inviter) => {
  const name = member.firstName || member.email;
  const inviterName = `${inviter.firstName ?? ''} ${inviter.lastName ?? ''}`.trim() || inviter.email;
  const loginUrl = `${FRONTEND_BASE()}/login`;

  return send({
    to: member.email,
    subject: `You've been added to ${COMPANY_NAME} — Your Login Details`,
    html: wrap({
      title: `Welcome to ${COMPANY_NAME}`,
      subtitle: `${inviterName} has added you to their team as <strong>${roleName}</strong>.`,
      body: `
        <p>Hi <strong>${name}</strong>,</p>

        <p>
          <strong>${inviterName}</strong> has added you to their team on the
          ${COMPANY_NAME} platform as <strong>${roleName}</strong>.
          Your account is ready — use the credentials below to log in.
        </p>

        <table class="detail-table">
          <tr>
            <td class="detail-label">Email</td>
            <td class="detail-value">${member.email}</td>
          </tr>
          <tr>
            <td class="detail-label">Temporary Password</td>
            <td class="detail-value">
              <span style="font-family:'DM Mono',monospace;font-size:15px;
                letter-spacing:1px;color:#1e40af;font-weight:700;">
                ${tempPassword}
              </span>
            </td>
          </tr>
          <tr>
            <td class="detail-label">Role</td>
            <td class="detail-value">${roleName}</td>
          </tr>
        </table>

        <a href="${loginUrl}" class="btn">Log In to Your Account</a>

        <div class="info-box">
          <p style="margin:0;font-size:14px;color:#0f172a;font-weight:600;">
            🔒 Important: Change your password after first login
          </p>
          <p style="margin:8px 0 0;font-size:13px;color:#64748b;">
            This is a temporary password. Once logged in, go to
            <strong>Settings → Change Password</strong> to set your own secure password.
            Temporary passwords should not be reused or shared.
          </p>
        </div>

        <p style="font-size:13px;color:#94a3b8;">
          If you did not expect this invitation, you can safely ignore this email
          or contact <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 6. EXISTING USER ASSIGNED TO TEAM
// ─────────────────────────────────────────────────────────────
exports.sendMemberAssignedEmail = async (existingTenant, roleName, assignedBy) => {
  const name = existingTenant.firstName || existingTenant.email;
  const assignerName = `${assignedBy.firstName ?? ''} ${assignedBy.lastName ?? ''}`.trim() || assignedBy.email;
  const loginUrl = `${FRONTEND_BASE()}/login`;

  return send({
    to: existingTenant.email,
    subject: `You've been added to a team on ${COMPANY_NAME}`,
    html: wrap({
      title: "You've been added to a team",
      subtitle: `${assignerName} has added you to their team as <strong>${roleName}</strong>.`,
      body: `
        <p>Hi <strong>${name}</strong>,</p>

        <p>
          <strong>${assignerName}</strong> has added you to their team on ${COMPANY_NAME}
          as <strong>${roleName}</strong>. Log in with your existing credentials.
        </p>

        <a href="${loginUrl}" class="btn">Log In to Your Account</a>

        <table class="detail-table">
          <tr>
            <td class="detail-label">Role</td>
            <td class="detail-value">${roleName}</td>
          </tr>
          <tr>
            <td class="detail-label">Added By</td>
            <td class="detail-value">${assignerName}</td>
          </tr>
        </table>

        <p style="font-size:13px;color:#94a3b8;">
          Questions? Contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 7. BILLING — REMINDER (7/3/1 days before due, or due-today)
// ─────────────────────────────────────────────────────────────
exports.sendBillingReminderEmail = async (tenant, invoice, daysUntilDue = null) => {
  const name = tenant.firstName || tenant.email;
  const formatted = `₹${invoice.totalAmount.toLocaleString('en-IN')}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const when = daysUntilDue === 0 ? 'today' : daysUntilDue === 1 ? 'tomorrow' : `in ${daysUntilDue} days`;

  return send({
    to: tenant.email,
    subject: daysUntilDue === 0
      ? `Payment Due Today — ${formatted} (${invoice.invoiceNumber})`
      : `Upcoming Subscription Payment — ${formatted} due ${dueDate}`,
    html: wrap({
      title: daysUntilDue === 0 ? 'Payment Due Today' : 'Upcoming Payment Reminder',
      subtitle: 'Your monthly platform subscription invoice is due soon.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>This is a reminder that your monthly subscription payment is due ${when}.</p>
        <table class="detail-table">
          <tr><td class="detail-label">Invoice</td><td class="detail-value">${invoice.invoiceNumber}</td></tr>
          <tr><td class="detail-label">Amount Due</td><td class="detail-value">${formatted}</td></tr>
          <tr><td class="detail-label">Due Date</td><td class="detail-value">${dueDate}</td></tr>
        </table>
        <p>Please arrange payment before the due date to avoid any interruption to your account access.</p>
        <p style="font-size:13px;color:#94a3b8;">
          Questions about billing? Contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 8. BILLING — OVERDUE (the day the invoice passes its due date, and
//    again at each overdue-day reminder point)
// ─────────────────────────────────────────────────────────────
exports.sendBillingOverdueEmail = async (tenant, invoice, graceDaysRemaining) => {
  const name = tenant.firstName || tenant.email;
  const outstanding = round2Ish(invoice.totalAmount - (invoice.paidAmount || 0));
  const formatted = `₹${outstanding.toLocaleString('en-IN')}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  return send({
    to: tenant.email,
    subject: `Payment Overdue — ${formatted} (${invoice.invoiceNumber})`,
    html: wrap({
      title: 'Payment Overdue',
      subtitle: 'Your subscription payment is now past its due date.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your monthly subscription payment was due on <strong>${dueDate}</strong> and has not yet been received in full.</p>
        <table class="detail-table">
          <tr><td class="detail-label">Invoice</td><td class="detail-value">${invoice.invoiceNumber}</td></tr>
          <tr><td class="detail-label">Outstanding Balance</td><td class="detail-value">${formatted}</td></tr>
          <tr><td class="detail-label">Due Date</td><td class="detail-value">${dueDate}</td></tr>
        </table>
        <p>
          To avoid your account being suspended, please arrange payment within the next
          <strong>${graceDaysRemaining} day${graceDaysRemaining === 1 ? '' : 's'}</strong>.
        </p>
        <p style="font-size:13px;color:#94a3b8;">
          Already paid? Contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a> so we can confirm it.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 8b. BILLING — FINAL WARNING (last day before auto-suspension)
// ─────────────────────────────────────────────────────────────
exports.sendFinalWarningEmail = async (tenant, invoice, daysUntilSuspension) => {
  const name = tenant.firstName || tenant.email;
  const outstanding = round2Ish(invoice.totalAmount - (invoice.paidAmount || 0));
  const formatted = `₹${outstanding.toLocaleString('en-IN')}`;

  return send({
    to: tenant.email,
    subject: `Final Warning — Account Suspends in ${daysUntilSuspension} Day${daysUntilSuspension === 1 ? '' : 's'}`,
    html: wrap({
      title: 'Final Warning',
      subtitle: 'Your account will be suspended very soon unless payment is received.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          This is a final notice — invoice <strong>${invoice.invoiceNumber}</strong> for
          <strong>${formatted}</strong> remains unpaid, and your account will be automatically
          suspended in <strong>${daysUntilSuspension} day${daysUntilSuspension === 1 ? '' : 's'}</strong>
          if payment is not received.
        </p>
        <p style="font-size:13px;color:#94a3b8;">
          To avoid interruption, please contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a> immediately.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 9. BILLING — ACCOUNT SUSPENDED (grace period elapsed, unpaid)
// ─────────────────────────────────────────────────────────────
exports.sendAccountSuspendedEmail = async (tenant, invoice) => {
  const name = tenant.firstName || tenant.email;
  const outstanding = round2Ish(invoice.totalAmount - (invoice.paidAmount || 0));
  const formatted = `₹${outstanding.toLocaleString('en-IN')}`;

  return send({
    to: tenant.email,
    subject: `Account Suspended — Payment Overdue`,
    html: wrap({
      title: 'Account Suspended',
      subtitle: 'Access has been paused due to an unpaid subscription invoice.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          Your ${COMPANY_NAME} account access has been suspended because the outstanding
          subscription payment of <strong>${formatted}</strong> (invoice ${invoice.invoiceNumber})
          was not received within the grace period.
        </p>
        <p>
          Your operational data remains securely stored and untouched — it is not affected by
          this suspension. Your account will be automatically reactivated as soon as the
          payment is recorded.
        </p>
        <p style="font-size:13px;color:#94a3b8;">
          To resolve this, please contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 9b. BILLING — INVOICE GENERATED (new billing cycle started)
// ─────────────────────────────────────────────────────────────
exports.sendInvoiceGeneratedEmail = async (tenant, invoice) => {
  const name = tenant.firstName || tenant.email;
  const formatted = `₹${invoice.totalAmount.toLocaleString('en-IN')}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  return send({
    to: tenant.email,
    subject: `New Invoice Generated — ${invoice.invoiceNumber}`,
    html: wrap({
      title: 'New Invoice Generated',
      subtitle: `Your invoice for ${MONTH_NAMES[invoice.periodMonth - 1]} ${invoice.periodYear} is ready.`,
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>A new subscription invoice has been generated for your account.</p>
        <table class="detail-table">
          <tr><td class="detail-label">Invoice</td><td class="detail-value">${invoice.invoiceNumber}</td></tr>
          <tr><td class="detail-label">Plan</td><td class="detail-value">${invoice.planName || 'Custom'}</td></tr>
          <tr><td class="detail-label">Amount</td><td class="detail-value">${formatted}</td></tr>
          <tr><td class="detail-label">Due Date</td><td class="detail-value">${dueDate}</td></tr>
        </table>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 9c. BILLING — PAYMENT FAILED
// ─────────────────────────────────────────────────────────────
exports.sendPaymentFailedEmail = async (tenant, invoice, reason) => {
  const name = tenant.firstName || tenant.email;
  const formatted = `₹${invoice.totalAmount.toLocaleString('en-IN')}`;

  return send({
    to: tenant.email,
    subject: `Payment Failed — ${invoice.invoiceNumber}`,
    html: wrap({
      title: 'Payment Failed',
      subtitle: 'We were unable to process your subscription payment.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          A payment attempt of <strong>${formatted}</strong> for invoice
          <strong>${invoice.invoiceNumber}</strong> could not be completed.
          ${reason ? `<br/><em>Reason: ${reason}</em>` : ''}
        </p>
        <p style="font-size:13px;color:#94a3b8;">
          Please contact <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>
          to arrange payment.
        </p>
      `,
    }),
  });
};

// ─────────────────────────────────────────────────────────────
// 9d. BILLING — SUBSCRIPTION PAYMENT RECEIVED (platform fee, not a
//     customer-facing payment — see sendPaymentConfirmation for that)
// ─────────────────────────────────────────────────────────────
exports.sendSubscriptionPaymentReceivedEmail = async (tenant, invoice, receiptPdfBuffer = null) => {
  const name = tenant.firstName || tenant.email;
  const formatted = `₹${invoice.paidAmount.toLocaleString('en-IN')}`;

  return send({
    to: tenant.email,
    subject: `Payment Received — ${invoice.invoiceNumber}`,
    html: wrap({
      title: 'Payment Received',
      subtitle: 'Thank you — your subscription payment has been recorded.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>We've recorded your payment of <strong>${formatted}</strong> against invoice <strong>${invoice.invoiceNumber}</strong>.</p>
        <table class="detail-table">
          <tr><td class="detail-label">Invoice</td><td class="detail-value">${invoice.invoiceNumber}</td></tr>
          <tr><td class="detail-label">Amount Paid</td><td class="detail-value">${formatted}</td></tr>
          <tr><td class="detail-label">Method</td><td class="detail-value">${invoice.paymentMethod || '—'}</td></tr>
        </table>
        ${receiptPdfBuffer ? '<p>Your receipt is attached to this email as a PDF.</p>' : ''}
      `,
    }),
    attachments: receiptPdfBuffer
      ? [{ filename: `receipt-${invoice.invoiceNumber}.pdf`, content: receiptPdfBuffer, contentType: 'application/pdf' }]
      : undefined,
  });
};

// ─────────────────────────────────────────────────────────────
// 10. BILLING — ACCOUNT REACTIVATED (payment recorded)
// ─────────────────────────────────────────────────────────────
exports.sendAccountReactivatedEmail = async (tenant) => {
  const name = tenant.firstName || tenant.email;
  const loginUrl = `${FRONTEND_BASE()}/auth/login`;

  return send({
    to: tenant.email,
    subject: `Account Reactivated — Welcome Back`,
    html: wrap({
      title: 'Account Reactivated',
      subtitle: 'Your payment was received and access has been restored.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your subscription payment has been received and your account access has been fully restored.</p>
        <a href="${loginUrl}" class="btn">Log In to Your Account</a>
      `,
    }),
  });
};

exports.sendWelcomeEmail = async (tenant, tempPassword) => {
  const name = tenant.firstName || tenant.email;
  const loginUrl = `${FRONTEND_BASE()}/auth/login`;

  return send({
    to: tenant.email,
    subject: `Welcome to ${COMPANY_NAME} — Your Account Details`,
    html: wrap({
      title: `Welcome to ${COMPANY_NAME}`,
      subtitle: 'Your account has been created by the platform administrator.',
      body: `
        <p>Hi <strong>${name}</strong>,</p>
        <p>
          Your ${COMPANY_NAME} account has been provisioned.
          Use the credentials below to log in and complete your setup.
        </p>

        <table class="detail-table">
          <tr>
            <td class="detail-label">Email</td>
            <td class="detail-value">${tenant.email}</td>
          </tr>
          <tr>
            <td class="detail-label">Temporary Password</td>
            <td class="detail-value">
              <span style="font-family:'DM Mono',monospace;font-size:15px;
                letter-spacing:1px;color:#1e40af;font-weight:700;">
                ${tempPassword}
              </span>
            </td>
          </tr>
        </table>

        <a href="${loginUrl}" class="btn">Log In to Your Account</a>

        <div class="info-box">
          <p style="margin:0;font-size:14px;color:#0f172a;font-weight:600;">
            🔒 Change your password after first login
          </p>
          <p style="margin:8px 0 0;font-size:13px;color:#64748b;">
            Go to <strong>Settings → Change Password</strong> once logged in.
          </p>
        </div>

        <p style="font-size:13px;color:#94a3b8;">
          If you did not expect this, contact
          <a href="mailto:${ADMIN_EMAIL()}" style="color:#1e40af;">${ADMIN_EMAIL()}</a>.
        </p>
      `,
    }),
  });
};