'use strict';

// Generates a clean, single-page invoice/receipt PDF for a tenant's
// subscription invoice. Streamed directly to the HTTP response — nothing
// written to disk.

const PDFDocument = require('pdfkit');

const INR = (n) => `Rs. ${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const STATUS_LABEL = {
  draft: 'Draft', generated: 'Generated', pending: 'Pending', partially_paid: 'Partially Paid',
  paid: 'Paid', overdue: 'Overdue', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded',
};

const invoicePdfFilename = (invoice, mode) => `${mode === 'receipt' ? 'receipt' : 'invoice'}-${invoice.invoiceNumber}.pdf`;

/** Draws the full invoice/receipt layout onto an already-constructed PDFDocument. Caller owns pipe/end. */
const renderInvoicePdf = (doc, { tenant, invoice, mode = 'invoice' }) => {
  // ── Header ──────────────────────────────────────────────────────────────
  doc.fontSize(20).fillColor('#0f172a').font('Helvetica-Bold')
    .text(process.env.COMPANY_NAME || 'Fully Promoted India', 50, 50);
  doc.fontSize(10).fillColor('#64748b').font('Helvetica')
    .text('Platform Subscription Billing', 50, 74);

  doc.fontSize(16).fillColor('#0f172a').font('Helvetica-Bold')
    .text(mode === 'receipt' ? 'PAYMENT RECEIPT' : 'INVOICE', 350, 50, { width: 200, align: 'right' });
  doc.fontSize(10).fillColor('#64748b').font('Helvetica')
    .text(invoice.invoiceNumber, 350, 72, { width: 200, align: 'right' });

  doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e2e8f0').stroke();

  // ── Bill-to / meta ──────────────────────────────────────────────────────
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold').text('BILLED TO', 50, 118);
  doc.fontSize(11).fillColor('#0f172a').font('Helvetica-Bold')
    .text(tenant.businessName || `${tenant.firstName} ${tenant.lastName}`, 50, 132);
  doc.fontSize(10).fillColor('#334155').font('Helvetica')
    .text(tenant.email, 50, 148)
    .text(`Tenant ID: ${tenant.tenantId}`, 50, 162);

  const metaX = 350;
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold').text('BILLING PERIOD', metaX, 118, { width: 195, align: 'right' });
  doc.fontSize(10).fillColor('#0f172a').font('Helvetica')
    .text(`${invoice.periodMonth}/${invoice.periodYear}`, metaX, 132, { width: 195, align: 'right' });
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold').text('DUE DATE', metaX, 148, { width: 195, align: 'right' });
  doc.fontSize(10).fillColor('#0f172a').font('Helvetica')
    .text(fmtDate(invoice.dueDate), metaX, 162, { width: 195, align: 'right' });
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold').text('STATUS', metaX, 178, { width: 195, align: 'right' });
  doc.fontSize(10).fillColor('#0f172a').font('Helvetica-Bold')
    .text(STATUS_LABEL[invoice.status] || invoice.status, metaX, 192, { width: 195, align: 'right' });

  // ── Line items ──────────────────────────────────────────────────────────
  let y = 230;
  doc.rect(50, y, 495, 24).fill('#f1f5f9');
  doc.fontSize(9).fillColor('#475569').font('Helvetica-Bold');
  doc.text('DESCRIPTION', 60, y + 7);
  doc.text('AMOUNT', 450, y + 7, { width: 85, align: 'right' });
  y += 34;

  doc.fontSize(10).fillColor('#0f172a').font('Helvetica');
  doc.text(`${invoice.planName || 'Subscription'} — ${invoice.periodMonth}/${invoice.periodYear}`, 60, y);
  doc.text(INR(invoice.baseAmount), 450, y, { width: 85, align: 'right' });
  y += 22;

  if (invoice.discountAmount > 0) {
    doc.fillColor('#059669').text('Discount', 60, y);
    doc.text(`- ${INR(invoice.discountAmount)}`, 450, y, { width: 85, align: 'right' });
    y += 22;
  }

  doc.fillColor('#0f172a').text(`GST (${invoice.gstPercent}%)`, 60, y);
  doc.text(INR(invoice.gstAmount), 450, y, { width: 85, align: 'right' });
  y += 30;

  doc.moveTo(50, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
  y += 12;

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text('Total', 60, y);
  doc.text(INR(invoice.totalAmount), 400, y, { width: 135, align: 'right' });
  y += 24;

  if (invoice.paidAmount > 0) {
    doc.fontSize(10).font('Helvetica').fillColor('#059669').text('Paid', 60, y);
    doc.text(INR(invoice.paidAmount), 400, y, { width: 135, align: 'right' });
    y += 18;

    const balance = Math.max(0, invoice.totalAmount - invoice.paidAmount);
    if (balance > 0) {
      doc.fillColor('#dc2626').text('Balance Due', 60, y);
      doc.text(INR(balance), 400, y, { width: 135, align: 'right' });
      y += 18;
    }
  }

  // ── Payment details (receipt mode) ─────────────────────────────────────
  if (mode === 'receipt' && invoice.paidAmount > 0) {
    y += 20;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
    y += 16;
    doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold').text('PAYMENT DETAILS', 50, y);
    y += 16;
    doc.fontSize(10).fillColor('#0f172a').font('Helvetica');
    doc.text(`Payment Date: ${fmtDate(invoice.paidAt)}`, 50, y); y += 16;
    doc.text(`Method: ${invoice.paymentMethod || '—'}`, 50, y); y += 16;
    if (invoice.referenceNumber) { doc.text(`Reference: ${invoice.referenceNumber}`, 50, y); y += 16; }
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  doc.fontSize(8.5).fillColor('#94a3b8').font('Helvetica')
    .text('This is a system-generated document and does not require a signature.', 50, 760, { width: 495, align: 'center' });
};

/**
 * Streams a PDF for one invoice to `res`. `mode` is 'invoice' (bill, shown
 * even if unpaid) or 'receipt' (payment confirmation — only sensible once
 * paidAmount > 0).
 */
const streamInvoicePdf = (res, opts) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoicePdfFilename(opts.invoice, opts.mode)}"`);
  doc.pipe(res);
  renderInvoicePdf(doc, opts);
  doc.end();
};

/** Same layout, collected into an in-memory Buffer — used for email attachments. */
const bufferInvoicePdf = (opts) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  renderInvoicePdf(doc, opts);
  doc.end();
});

module.exports = { streamInvoicePdf, bufferInvoicePdf, invoicePdfFilename };
