'use strict';

// ════════════════════════════════════════════════════════════════════════════
// services/billing.service.js
//
// Tenant subscription billing engine — plans, tax/discount computation,
// invoice generation with gap-free invoice numbers, manual payment
// recording, refunds, structured follow-ups, and the automatic
// trial → active → grace_period → suspended state machine.
//
// Billing is opt-in per tenant (TenantSubscription.isEnrolled). A tenant with
// isEnrolled=false is never touched by the sweep and can never be suspended
// by it — existing tenants stay unenrolled until a superadmin turns billing
// on for them from the Billing page.
//
// Payment collection is manual only (recorded by the superadmin — bank
// transfer / UPI / cheque / cash). No online self-pay flow exists yet (would
// need the platform's own Razorpay keys, which this deployment doesn't have
// configured anywhere).
//
// Payment Status (per-invoice) and Tenant Status (per-subscription) are
// deliberately separate state machines (spec §21) so billing logic never
// gets tangled with account-access logic:
//   Invoice status : draft/generated/pending/partially_paid/paid/overdue/
//                    failed/cancelled/refunded
//   Tenant status  : trial/active/grace_period/suspended/cancelled
// Tenant.billingSuspended (a plain boolean on the Tenant model, cheap to
// check at login) mirrors tenantStatus === 'suspended'.
// ════════════════════════════════════════════════════════════════════════════

const Tenant = require('../models/tenant');
const TenantSubscription = require('../models/tenantSubscription');
const SubscriptionPlan = require('../models/subscriptionPlan');
const BillingAuditLog = require('../models/billingAuditLog');
const { nextSequence } = require('../models/counter');
const emailUtil = require('../utils/email');
const { bufferInvoicePdf } = require('./invoicePdf.service');
const billingSettingsService = require('./billingSettings.service');
const logger = require('../utils/logger');
const { escapeRegex } = require('../utils/validation');

const DEFAULT_GRACE_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** `defaultDays` is the platform-configured fallback (BillingSettings.defaultGracePeriodDays); callers that haven't fetched settings can omit it to fall back to the built-in constant. */
const graceDaysFor = (subscription, defaultDays = DEFAULT_GRACE_PERIOD_DAYS) =>
  Number.isFinite(subscription.gracePeriodDays) ? subscription.gracePeriodDays : defaultDays;

const httpError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const actorName = (user) =>
  (user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email : '') || 'System Automation';

/** Fire-and-forget audit entry — never let a logging failure break the caller. */
const audit = async (tenantId, action, description, extra = {}) => {
  try {
    await BillingAuditLog.create({ tenantId, action, description, ...extra });
  } catch (err) {
    logger.error(`[Billing] Audit log write failed for ${tenantId}/${action}: ${err.message}`);
  }
};

const getOrCreateSubscription = async (tenantId) => {
  let sub = await TenantSubscription.findOne({ tenantId });
  if (!sub) sub = await TenantSubscription.create({ tenantId });
  return sub;
};

const dueDateFor = (year, month, billingDay) =>
  new Date(year, month - 1, billingDay, 23, 59, 59, 999);

/**
 * The next billing-day occurrence at/after `from` — rolls to next month if
 * this month's billing day has already passed. Used only for a tenant's
 * very first invoice, so enrolling mid-month never creates an invoice that's
 * already overdue on day one.
 */
const nextUpcomingPeriod = (subscription, from) => {
  let year = from.getFullYear();
  let month = from.getMonth() + 1;
  if (from.getDate() > subscription.billingDay) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return { year, month, dueDate: dueDateFor(year, month, subscription.billingDay) };
};

const generateInvoiceNumber = async (year) => {
  const settings = await billingSettingsService.getSettings();
  const seq = await nextSequence(`invoice-${year}`);
  return `${settings.invoiceNumberPrefix || 'INV'}-${year}-${String(seq).padStart(4, '0')}`;
};

/** Base/discount/GST/total breakdown, frozen onto the invoice at generation time. */
const computeInvoiceAmounts = (subscription) => {
  const baseAmount = round2(subscription.monthlyFee);
  const discountAmount = round2(
    subscription.discountType === 'percent'
      ? baseAmount * (subscription.discountValue / 100)
      : subscription.discountValue,
  );
  const taxable = Math.max(0, round2(baseAmount - discountAmount));
  const gstAmount = round2(taxable * (subscription.gstPercent / 100));
  const totalAmount = round2(taxable + gstAmount);
  return { baseAmount, discountAmount, gstPercent: subscription.gstPercent, gstAmount, totalAmount };
};

const buildInvoice = async ({ subscription, year, month, dueDate }) => {
  const amounts = computeInvoiceAmounts(subscription);
  return {
    invoiceNumber: await generateInvoiceNumber(year),
    periodMonth: month,
    periodYear: year,
    planName: subscription.planName || 'Custom',
    ...amounts,
    dueDate,
    status: 'pending',
  };
};

/**
 * Rolls the subscription forward to its next billing period once the
 * calendar has actually reached it — anchored to the LAST invoice on file,
 * not to "today's calendar month". This is what stops the sweep from ever
 * back-creating an invoice for a period that was skipped (e.g. a tenant
 * enrolled mid-month whose first invoice already targets next month) or
 * from creating next month's invoice before its cycle has actually begun.
 * Returns true if a new invoice was pushed.
 */
const advanceToNextPeriodIfDue = async (subscription, now) => {
  const latest = subscription.currentInvoice();
  if (!latest) {
    const { year, month, dueDate } = nextUpcomingPeriod(subscription, now);
    subscription.invoices.push(await buildInvoice({ subscription, year, month, dueDate }));
    return true;
  }

  let nextYear = latest.periodYear;
  let nextMonth = latest.periodMonth + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  const reachedNextPeriod = now.getFullYear() > nextYear ||
    (now.getFullYear() === nextYear && now.getMonth() + 1 >= nextMonth);
  if (!reachedNextPeriod) return false;

  const dueDate = dueDateFor(nextYear, nextMonth, subscription.billingDay);
  subscription.invoices.push(await buildInvoice({ subscription, year: nextYear, month: nextMonth, dueDate }));
  return true;
};

/**
 * Builds [key, dayOffset] pairs from admin-configured day lists (BillingSettings
 * .reminderDaysBeforeDue/.reminderDaysOverdue), in the same key format the old
 * hardcoded arrays used ('7d_before', 'due_today', '1d_overdue', ...) so the
 * per-invoice `remindersSent` idempotency guard keeps working unchanged.
 */
const buildReminderPoints = (days, suffix) =>
  [...new Set(days)].sort((a, b) => b - a).map((d) => [d === 0 ? 'due_today' : `${d}d_${suffix}`, d]);

const sendSafely = (promise, label) => promise.catch((err) => logger.error(`[Billing] ${label} failed: ${err.message}`));

/**
 * Daily sweep — for every enrolled, billable tenant:
 *  1. roll forward to the next billing period once its cycle has begun (or
 *     graduate out of a trial once it ends)
 *  2. send pre-due reminders at 7/3/1 days before and on the due date
 *  3. flip pending/partially_paid -> overdue once the due date passes
 *  4. send overdue-day reminders (1d/3d overdue) and a final warning
 *  5. suspend the tenant once an invoice has been overdue past its grace period
 * Safe to run more than once — every step is idempotent/guarded (milestones
 * are tracked per-invoice in `remindersSent`) so re-running the same day
 * (e.g. after a server restart) has no extra side effects.
 */
const runDailyBillingSweep = async () => {
  // tenantStatus:'cancelled' is excluded even though isEnrolled stays true
  // (billingState/buildRow relies on isEnrolled to distinguish "unenrolled"
  // from "cancelled" in the Overview table) — otherwise a cancelled tenant
  // would keep getting fresh invoices generated every cycle.
  const subscriptions = await TenantSubscription.find({ isEnrolled: true, tenantStatus: { $ne: 'cancelled' } });
  const now = new Date();
  const settings = await billingSettingsService.getSettings();
  const reminderPointsBefore = buildReminderPoints(settings.reminderDaysBeforeDue, 'before');
  const reminderPointsOverdue = buildReminderPoints(settings.reminderDaysOverdue, 'overdue');
  let remindersSent = 0, overdueNotices = 0, suspended = 0, trialsGraduated = 0;

  for (const sub of subscriptions) {
    try {
      const tenant = await Tenant.findOne({ tenantId: sub.tenantId }).select('+billingSuspended');
      if (!tenant) continue;

      let changed = false;

      // ── Trial handling ────────────────────────────────────────────────
      if (sub.trialEndsAt && now < sub.trialEndsAt) {
        if (sub.tenantStatus !== 'trial') { sub.tenantStatus = 'trial'; changed = true; }
        if (changed) await sub.save();
        continue; // no billing while in trial
      }
      if (sub.trialEndsAt && sub.tenantStatus === 'trial' && now >= sub.trialEndsAt) {
        sub.tenantStatus = 'active';
        changed = true;
        trialsGraduated++;
        await audit(sub.tenantId, 'trial_ended', 'Trial period ended — billing begins.');
      }

      if (!(sub.monthlyFee > 0)) { if (changed) await sub.save(); continue; }

      if (await advanceToNextPeriodIfDue(sub, now)) {
        changed = true;
        const inv = sub.currentInvoice();
        overdueNotices += 0;
        await audit(sub.tenantId, 'invoice_generated', `Invoice ${inv.invoiceNumber} generated for ${inv.periodMonth}/${inv.periodYear}.`, {
          invoiceNumber: inv.invoiceNumber, amount: inv.totalAmount, newStatus: inv.status,
        });
        sendSafely(emailUtil.sendInvoiceGeneratedEmail(tenant, inv), `Invoice-generated email for ${sub.tenantId}`);
      }

      const graceDays = graceDaysFor(sub, settings.defaultGracePeriodDays);
      let anyOverdue = false;

      for (const invoice of sub.invoices) {
        if (['paid', 'cancelled', 'refunded'].includes(invoice.status)) continue;

        const daysUntilDue = Math.ceil((invoice.dueDate - now) / DAY_MS);
        const daysPastDue = Math.floor((now - invoice.dueDate) / DAY_MS);
        const suspendDate = new Date(invoice.dueDate.getTime() + graceDays * DAY_MS);

        // Pre-due reminders (never sent once it's already overdue).
        if (invoice.status !== 'overdue') {
          for (const [key, atDays] of reminderPointsBefore) {
            if (daysUntilDue === atDays && !invoice.remindersSent.includes(key)) {
              invoice.remindersSent.push(key);
              changed = true;
              remindersSent++;
              sendSafely(emailUtil.sendBillingReminderEmail(tenant, invoice, atDays), `Reminder(${key}) for ${sub.tenantId}`);
            }
          }
        }

        // Pending/partially-paid -> overdue once the due date passes.
        if (['pending', 'partially_paid'].includes(invoice.status) && invoice.dueDate < now) {
          const prevStatus = invoice.status;
          invoice.status = 'overdue';
          changed = true;
          overdueNotices++;
          await audit(sub.tenantId, 'invoice_overdue', `Invoice ${invoice.invoiceNumber} is now overdue.`, {
            invoiceNumber: invoice.invoiceNumber, amount: invoice.totalAmount - invoice.paidAmount,
            previousStatus: prevStatus, newStatus: 'overdue',
          });
          sendSafely(emailUtil.sendBillingOverdueEmail(tenant, invoice, graceDays), `Overdue email for ${sub.tenantId}`);
        }

        if (invoice.status === 'overdue') {
          anyOverdue = true;

          for (const [key, atDays] of reminderPointsOverdue) {
            if (daysPastDue === atDays && !invoice.remindersSent.includes(key)) {
              invoice.remindersSent.push(key);
              changed = true;
              remindersSent++;
              sendSafely(emailUtil.sendBillingOverdueEmail(tenant, invoice, graceDays - atDays), `Overdue reminder(${key}) for ${sub.tenantId}`);
            }
          }

          const daysUntilSuspend = Math.ceil((suspendDate - now) / DAY_MS);
          if (daysUntilSuspend === 1 && !invoice.remindersSent.includes('final_warning')) {
            invoice.remindersSent.push('final_warning');
            changed = true;
            remindersSent++;
            sendSafely(emailUtil.sendFinalWarningEmail(tenant, invoice, 1), `Final warning for ${sub.tenantId}`);
          }

          if (now >= suspendDate) {
            if (!tenant.billingSuspended) {
              tenant.billingSuspended = true;
              await tenant.save();
              invoice.suspendedAt = now;
              changed = true;
              suspended++;
              await audit(sub.tenantId, 'suspended', `Suspended — invoice ${invoice.invoiceNumber} overdue past ${graceDays}-day grace period.`, {
                invoiceNumber: invoice.invoiceNumber, amount: invoice.totalAmount - invoice.paidAmount,
                previousStatus: sub.tenantStatus, newStatus: 'suspended',
              });
              sendSafely(emailUtil.sendAccountSuspendedEmail(tenant, invoice), `Suspension email for ${sub.tenantId}`);
            }
          } else if (sub.tenantStatus !== 'grace_period' && sub.tenantStatus !== 'suspended') {
            sub.tenantStatus = 'grace_period';
            changed = true;
          }
        }
      }

      if (!anyOverdue && !tenant.billingSuspended && sub.tenantStatus === 'grace_period') {
        sub.tenantStatus = 'active';
        changed = true;
      }
      if (tenant.billingSuspended && sub.tenantStatus !== 'suspended') {
        sub.tenantStatus = 'suspended';
        changed = true;
      }

      if (changed) await sub.save();
    } catch (err) {
      logger.error(`[Billing] Sweep failed for tenant ${sub.tenantId}: ${err.message}`);
    }
  }

  logger.info(
    `[Billing] Daily sweep complete — ${subscriptions.length} enrolled tenant(s), ` +
    `${trialsGraduated} trial(s) graduated, ${remindersSent} reminder(s), ` +
    `${overdueNotices} overdue notice(s), ${suspended} suspension(s).`,
  );
  return { scanned: subscriptions.length, trialsGraduated, remindersSent, overdueNotices, suspended };
};

/** Unsuspend the tenant if no invoice is still overdue — shared by payment/waive/refund. */
const reactivateIfClear = async (tenantId, subscription) => {
  const tenant = await Tenant.findOne({ tenantId }).select('+billingSuspended');
  if (!tenant?.billingSuspended) {
    if (tenant && subscription.tenantStatus !== 'active' && subscription.tenantStatus !== 'cancelled' && subscription.tenantStatus !== 'trial') {
      const stillOverdue = subscription.invoices.some((inv) => inv.status === 'overdue');
      if (!stillOverdue) { subscription.tenantStatus = 'active'; await subscription.save(); }
    }
    return;
  }
  const stillOverdue = subscription.invoices.some((inv) => inv.status === 'overdue');
  if (stillOverdue) return;

  tenant.billingSuspended = false;
  await tenant.save();
  subscription.tenantStatus = 'active';
  await subscription.save();
  await audit(tenantId, 'reactivated', 'Tenant reactivated — all overdue invoices resolved.', {
    previousStatus: 'suspended', newStatus: 'active',
  });
  sendSafely(emailUtil.sendAccountReactivatedEmail(tenant), `Reactivation email for ${tenantId}`);
};

const recordManualPayment = async (tenantId, invoiceId, payload, actingUser) => {
  const { amount, method, referenceNumber, notes, paidAt } = payload;
  const amt = round2(amount);
  if (!(amt > 0)) throw httpError('Payment amount must be greater than 0.', 422);

  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);
  if (['cancelled', 'refunded'].includes(invoice.status)) throw httpError(`Cannot record a payment on a ${invoice.status} invoice.`, 422);

  const wasOverdue = invoice.status === 'overdue';
  invoice.paidAmount = round2((invoice.paidAmount || 0) + amt);
  if (method) invoice.paymentMethod = method;
  if (referenceNumber !== undefined) invoice.referenceNumber = referenceNumber;
  if (notes !== undefined) invoice.paymentNotes = notes;
  invoice.paidAt = paidAt ? new Date(paidAt) : new Date();
  invoice.recordedBy = actingUser.id;
  invoice.recordedByName = actorName(actingUser);

  if (invoice.paidAmount >= invoice.totalAmount) {
    invoice.status = 'paid';
  } else if (!wasOverdue) {
    invoice.status = 'partially_paid';
  } // an overdue invoice with a partial top-up stays 'overdue' until fully paid

  await sub.save();
  await audit(tenantId, 'payment_recorded', `Payment of ${amt} recorded against ${invoice.invoiceNumber}.`, {
    invoiceNumber: invoice.invoiceNumber, amount: amt, performedBy: actingUser.id, performedByName: actorName(actingUser),
    previousStatus: wasOverdue ? 'overdue' : 'pending', newStatus: invoice.status,
  });

  if (invoice.status === 'paid') {
    const tenantDoc = await Tenant.findOne({ tenantId });
    if (tenantDoc) {
      sendSafely(
        billingSettingsService.getSettings()
          .then((settings) => bufferInvoicePdf({ tenant: tenantDoc, invoice, mode: 'receipt', settings }))
          .then((pdfBuffer) => emailUtil.sendSubscriptionPaymentReceivedEmail(tenantDoc, invoice, pdfBuffer))
          .catch(() => emailUtil.sendSubscriptionPaymentReceivedEmail(tenantDoc, invoice, null)),
        `Payment-received email for ${tenantId}`,
      );
    }
    await reactivateIfClear(tenantId, sub);
  }

  logger.info(`[Billing] Payment of ${amt} recorded for ${tenantId} (invoice ${invoice.invoiceNumber}) by ${actingUser.email}`);
  return { subscription: sub, invoice };
};

const markPaymentFailed = async (tenantId, invoiceId, reason, actingUser) => {
  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);

  invoice.failedAt = new Date();
  invoice.failureReason = reason || '';
  if (invoice.status === 'pending') invoice.status = 'failed';
  await sub.save();

  await audit(tenantId, 'payment_failed', `Payment attempt failed for ${invoice.invoiceNumber}.${reason ? ' Reason: ' + reason : ''}`, {
    invoiceNumber: invoice.invoiceNumber, performedBy: actingUser?.id, performedByName: actorName(actingUser),
  });
  const tenant = await Tenant.findOne({ tenantId });
  if (tenant) sendSafely(emailUtil.sendPaymentFailedEmail(tenant, invoice, reason), `Payment-failed email for ${tenantId}`);
  return invoice;
};

const issueRefund = async (tenantId, invoiceId, { amount, reason }, actingUser) => {
  const amt = round2(amount);
  if (!(amt > 0)) throw httpError('Refund amount must be greater than 0.', 422);

  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);

  const totalRefundedSoFar = round2(invoice.refunds.reduce((s, r) => s + r.amount, 0));
  if (totalRefundedSoFar + amt > invoice.paidAmount) {
    throw httpError('Refund amount exceeds what was paid on this invoice.', 422);
  }

  invoice.refunds.push({ amount: amt, reason: reason || '', refundedBy: actingUser.id, refundedByName: actorName(actingUser) });
  if (round2(totalRefundedSoFar + amt) >= invoice.paidAmount) invoice.status = 'refunded';

  await sub.save();
  await audit(tenantId, 'refund_issued', `Refund of ${amt} issued for ${invoice.invoiceNumber}.${reason ? ' Reason: ' + reason : ''}`, {
    invoiceNumber: invoice.invoiceNumber, amount: amt, performedBy: actingUser.id, performedByName: actorName(actingUser),
    newStatus: invoice.status,
  });
  return invoice;
};

const addFollowUp = async (tenantId, invoiceId, payload, actingUser) => {
  const { note, type, contactMethod, assignedStaffName, followUpStatus, nextFollowUpDate } = payload;
  if (!note?.trim()) throw httpError('A follow-up note is required.', 422);

  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);

  invoice.followUps.push({
    note: note.trim(),
    type: type || 'call',
    contactMethod: contactMethod || '',
    assignedStaffName: assignedStaffName || '',
    followUpStatus: followUpStatus || 'pending',
    nextFollowUpDate: nextFollowUpDate ? new Date(nextFollowUpDate) : null,
    addedBy: actingUser.id,
    addedByName: actorName(actingUser),
  });
  await sub.save();
  await audit(tenantId, 'follow_up_added', `Follow-up added on ${invoice.invoiceNumber}: "${note.trim().slice(0, 80)}"`, {
    invoiceNumber: invoice.invoiceNumber, performedBy: actingUser.id, performedByName: actorName(actingUser),
  });
  return invoice;
};

const updateFollowUpStatus = async (tenantId, invoiceId, followUpId, followUpStatus) => {
  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);
  const fu = invoice.followUps.id(followUpId);
  if (!fu) throw httpError('Follow-up not found.', 404);
  fu.followUpStatus = followUpStatus;
  await sub.save();
  return invoice;
};

const waiveInvoice = async (tenantId, invoiceId, actingUser) => {
  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);

  const prevStatus = invoice.status;
  invoice.status = 'cancelled';
  invoice.cancelledAt = new Date();
  invoice.cancelReason = 'Waived by superadmin';
  await sub.save();
  await audit(tenantId, 'invoice_waived', `Invoice ${invoice.invoiceNumber} waived.`, {
    invoiceNumber: invoice.invoiceNumber, performedBy: actingUser?.id, performedByName: actorName(actingUser),
    previousStatus: prevStatus, newStatus: 'cancelled',
  });
  await reactivateIfClear(tenantId, sub);
  return invoice;
};

const updateSubscriptionConfig = async (tenantId, payload) => {
  const { isEnrolled, monthlyFee, gstPercent, discountType, discountValue, billingDay, gracePeriodDays, trialDays } = payload;
  const sub = await getOrCreateSubscription(tenantId);
  const wasEnrolled = sub.isEnrolled;

  if (isEnrolled !== undefined) sub.isEnrolled = !!isEnrolled;
  if (monthlyFee !== undefined) sub.monthlyFee = round2(monthlyFee);
  if (gstPercent !== undefined) sub.gstPercent = Number(gstPercent);
  if (discountType !== undefined) sub.discountType = discountType;
  if (discountValue !== undefined) sub.discountValue = round2(discountValue);
  if (billingDay !== undefined) sub.billingDay = billingDay;
  if (gracePeriodDays !== undefined) sub.gracePeriodDays = gracePeriodDays === null || gracePeriodDays === '' ? null : Number(gracePeriodDays);

  if (!wasEnrolled && sub.isEnrolled && trialDays) {
    sub.trialEndsAt = new Date(Date.now() + Number(trialDays) * DAY_MS);
    sub.tenantStatus = 'trial';
  }

  // First invoice ever for a non-trial tenant — due at the next upcoming
  // billing day so enrolling partway through a month doesn't start them off
  // overdue. Every later period is handled by the daily sweep as normal.
  let firstInvoiceCreated = false;
  if (sub.isEnrolled && sub.monthlyFee > 0 && sub.invoices.length === 0 && !(sub.trialEndsAt && sub.trialEndsAt > new Date())) {
    const { year, month, dueDate } = nextUpcomingPeriod(sub, new Date());
    sub.invoices.push(await buildInvoice({ subscription: sub, year, month, dueDate }));
    firstInvoiceCreated = true;
  }

  await sub.save();
  if (!wasEnrolled && sub.isEnrolled) {
    await audit(tenantId, 'enrolled', 'Tenant enrolled in billing.', { newStatus: sub.tenantStatus });
  }
  if (firstInvoiceCreated) {
    const inv = sub.currentInvoice();
    await audit(tenantId, 'invoice_generated', `Invoice ${inv.invoiceNumber} generated for ${inv.periodMonth}/${inv.periodYear}.`, {
      invoiceNumber: inv.invoiceNumber, amount: inv.totalAmount, newStatus: inv.status,
    });
  }
  return sub;
};

const changePlan = async (tenantId, planId, actingUser) => {
  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) throw httpError('Plan not found.', 404);

  const sub = await getOrCreateSubscription(tenantId);
  const prevPlan = sub.planName || 'Custom';
  sub.planId = plan._id;
  sub.planName = plan.name;
  sub.monthlyFee = plan.monthlyPrice;
  sub.gstPercent = plan.gstPercent;
  if (plan.gracePeriodDays !== null && plan.gracePeriodDays !== undefined) sub.gracePeriodDays = plan.gracePeriodDays;
  await sub.save();

  await audit(tenantId, 'plan_changed', `Plan changed from "${prevPlan}" to "${plan.name}".`, {
    performedBy: actingUser?.id, performedByName: actorName(actingUser), previousStatus: prevPlan, newStatus: plan.name,
  });
  return sub;
};

const cancelSubscription = async (tenantId, reason, actingUser) => {
  const sub = await getOrCreateSubscription(tenantId);
  const prevStatus = sub.tenantStatus;
  sub.tenantStatus = 'cancelled';
  sub.cancelledAt = new Date();
  sub.cancelReason = reason || '';

  sub.invoices.forEach((inv) => {
    if (['pending', 'partially_paid', 'overdue'].includes(inv.status)) {
      inv.status = 'cancelled';
      inv.cancelledAt = new Date();
      inv.cancelReason = 'Subscription cancelled';
    }
  });
  await sub.save();

  const tenant = await Tenant.findOne({ tenantId }).select('+billingSuspended');
  if (tenant?.billingSuspended) { tenant.billingSuspended = false; await tenant.save(); }

  await audit(tenantId, 'subscription_cancelled', `Subscription cancelled.${reason ? ' Reason: ' + reason : ''}`, {
    performedBy: actingUser?.id, performedByName: actorName(actingUser), previousStatus: prevStatus, newStatus: 'cancelled',
  });
  return sub;
};

const manualReactivate = async (tenantId, actingUser) => {
  const tenant = await Tenant.findOne({ tenantId }).select('+billingSuspended');
  if (!tenant) throw httpError('Tenant not found.', 404);
  if (tenant.billingSuspended) {
    tenant.billingSuspended = false;
    await tenant.save();
    const sub = await getOrCreateSubscription(tenantId);
    sub.tenantStatus = 'active';
    await sub.save();
    logger.info(`[Billing] Tenant ${tenantId} manually reactivated by ${actingUser.email}`);
    await audit(tenantId, 'reactivated', 'Manually reactivated by superadmin.', {
      performedBy: actingUser.id, performedByName: actorName(actingUser), previousStatus: 'suspended', newStatus: 'active',
    });
    sendSafely(emailUtil.sendAccountReactivatedEmail(tenant), `Manual reactivation email for ${tenantId}`);
  }
  return tenant;
};

/** Manual suspend — independent of the automated overdue/grace-period path. */
const manualSuspend = async (tenantId, reason, actingUser) => {
  const tenant = await Tenant.findOne({ tenantId }).select('+billingSuspended');
  if (!tenant) throw httpError('Tenant not found.', 404);
  if (!tenant.billingSuspended) {
    tenant.billingSuspended = true;
    await tenant.save();
    const sub = await getOrCreateSubscription(tenantId);
    const prevStatus = sub.tenantStatus;
    sub.tenantStatus = 'suspended';
    await sub.save();
    logger.info(`[Billing] Tenant ${tenantId} manually suspended by ${actingUser.email}`);
    await audit(tenantId, 'suspended', `Manually suspended by superadmin.${reason ? ' Reason: ' + reason : ''}`, {
      performedBy: actingUser.id, performedByName: actorName(actingUser), previousStatus: prevStatus, newStatus: 'suspended',
    });
  }
  return tenant;
};

/** On-demand reminder — outside the automated schedule, e.g. a manual nudge. */
const sendManualReminder = async (tenantId, invoiceId, actingUser) => {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) throw httpError('Tenant not found.', 404);
  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);
  if (['paid', 'cancelled', 'refunded'].includes(invoice.status)) throw httpError(`Cannot send a reminder for a ${invoice.status} invoice.`, 422);

  if (invoice.status === 'overdue') {
    await emailUtil.sendBillingOverdueEmail(tenant, invoice, graceDaysFor(sub));
  } else {
    const daysUntilDue = Math.ceil((invoice.dueDate - new Date()) / DAY_MS);
    await emailUtil.sendBillingReminderEmail(tenant, invoice, Math.max(0, daysUntilDue));
  }
  await audit(tenantId, 'reminder_sent', `Manual reminder sent for ${invoice.invoiceNumber}.`, {
    invoiceNumber: invoice.invoiceNumber, performedBy: actingUser.id, performedByName: actorName(actingUser),
  });
  return invoice;
};

/**
 * Credit/debit adjustment on an invoice — spec §9's "Credits/adjustments"
 * line item. A credit reduces the amount owed (e.g. goodwill discount after
 * the fact); a debit increases it (e.g. a correction). Recomputes status the
 * same way a payment would.
 */
const applyAdjustment = async (tenantId, invoiceId, { amount, type, reason }, actingUser) => {
  const amt = round2(amount);
  if (!(amt > 0)) throw httpError('Adjustment amount must be greater than 0.', 422);
  if (!['credit', 'debit'].includes(type)) throw httpError('Adjustment type must be "credit" or "debit".', 422);

  const sub = await getOrCreateSubscription(tenantId);
  const invoice = sub.invoices.id(invoiceId);
  if (!invoice) throw httpError('Invoice not found.', 404);
  if (['cancelled', 'refunded'].includes(invoice.status)) throw httpError(`Cannot adjust a ${invoice.status} invoice.`, 422);

  const delta = type === 'credit' ? -amt : amt;
  invoice.totalAmount = Math.max(0, round2(invoice.totalAmount + delta));
  invoice.adjustments.push({
    amount: amt, type, reason: reason || '', addedBy: actingUser.id, addedByName: actorName(actingUser),
  });

  if (invoice.paidAmount >= invoice.totalAmount && invoice.totalAmount > 0) invoice.status = 'paid';
  else if (invoice.status === 'paid' && invoice.paidAmount < invoice.totalAmount) invoice.status = 'partially_paid';

  await sub.save();
  await audit(tenantId, 'adjustment_applied', `${type === 'credit' ? 'Credit' : 'Debit'} of ${amt} applied to ${invoice.invoiceNumber}.${reason ? ' Reason: ' + reason : ''}`, {
    invoiceNumber: invoice.invoiceNumber, amount: amt, performedBy: actingUser.id, performedByName: actorName(actingUser),
    newStatus: invoice.status,
  });
  if (invoice.status === 'paid') await reactivateIfClear(tenantId, sub);
  return invoice;
};

// ── Row / summary builders for the cross-tenant Billing page ────────────────

const buildRow = (tenant, sub, { targetYear, targetMonth, now }) => {
  const isEnrolled = sub?.isEnrolled ?? false;
  const invoices = sub?.invoices ?? [];
  const invoice = invoices.find((i) => i.periodYear === targetYear && i.periodMonth === targetMonth) ?? null;

  const paidInvoices = invoices.filter((i) => (i.status === 'paid' || i.status === 'partially_paid') && i.paidAt);
  const lastPaid = paidInvoices.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))[0] ?? null;

  const outstandingAmount = round2(
    invoices
      .filter((i) => !['paid', 'cancelled', 'refunded'].includes(i.status))
      .reduce((s, i) => s + Math.max(0, i.totalAmount - (i.paidAmount || 0)), 0),
  );

  const billingState = isEnrolled ? (sub.tenantStatus ?? 'active') : 'unenrolled';

  const daysOverdue = invoice?.status === 'overdue'
    ? Math.max(0, Math.floor((now - new Date(invoice.dueDate)) / DAY_MS))
    : 0;

  return {
    tenantId: tenant.tenantId,
    tenantName: tenant.businessName || `${tenant.firstName} ${tenant.lastName}`.trim(),
    ownerName: `${tenant.firstName} ${tenant.lastName}`.trim(),
    email: tenant.email,
    isEnrolled,
    planId: sub?.planId ? String(sub.planId) : null,
    planName: sub?.planName || (isEnrolled ? 'Custom' : ''),
    monthlyFee: sub?.monthlyFee ?? 0,
    gstPercent: sub?.gstPercent ?? 0,
    billingDay: sub?.billingDay ?? 1,
    gracePeriodDays: sub?.gracePeriodDays ?? null,
    billingSuspended: !!tenant.billingSuspended,
    billingState,
    subscriptionStartDate: sub?.createdAt ?? null,
    currentInvoice: invoice ? {
      id: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      periodMonth: invoice.periodMonth,
      periodYear: invoice.periodYear,
      totalAmount: invoice.totalAmount,
      dueDate: invoice.dueDate,
      status: invoice.status,
      paidAmount: invoice.paidAmount,
      paymentMethod: invoice.paymentMethod || '',
      daysOverdue,
      followUpCount: invoice.followUps.length,
      followUpStatuses: invoice.followUps.map((f) => f.followUpStatus),
    } : null,
    lastPayment: lastPaid ? {
      amount: lastPaid.paidAmount, paidAt: lastPaid.paidAt, method: lastPaid.paymentMethod,
    } : null,
    outstandingAmount,
  };
};

const computeSummary = (rows) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    totalTenants: rows.length,
    enrolled: rows.filter((r) => r.isEnrolled).length,
    trial: rows.filter((r) => r.billingState === 'trial').length,
    active: rows.filter((r) => r.billingState === 'active').length,
    gracePeriod: rows.filter((r) => r.billingState === 'grace_period').length,
    overdue: rows.filter((r) => r.currentInvoice?.status === 'overdue').length,
    suspended: rows.filter((r) => r.billingState === 'suspended').length,
    cancelled: rows.filter((r) => r.billingState === 'cancelled').length,
    unenrolled: rows.filter((r) => r.billingState === 'unenrolled').length,
    mrr: round2(rows.filter((r) => r.isEnrolled && r.billingState !== 'cancelled' && r.billingState !== 'trial').reduce((s, r) => s + r.monthlyFee, 0)),
    totalOutstanding: round2(rows.reduce((s, r) => s + r.outstandingAmount, 0)),
    paidThisMonth: round2(rows.reduce((s, r) => {
      if (!r.lastPayment?.paidAt || new Date(r.lastPayment.paidAt) < monthStart) return s;
      return s + r.lastPayment.amount;
    }, 0)),
  };
};

const DUE_WINDOW_DAYS = { today: 0, week: 7, month: 31 };

const listBillingOverview = async ({
  page = 1, limit = 25, status, search, month, year,
  planId, paymentMethod, minAmount, maxAmount, dueWindow, followUpStatus,
} = {}) => {
  const now = new Date();
  const targetYear = year ?? now.getFullYear();
  const targetMonth = month ?? now.getMonth() + 1;

  const tenantFilter = { role: 'tenant', isSubUser: { $ne: true } };
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    tenantFilter.$or = [{ email: re }, { firstName: re }, { lastName: re }, { businessName: re }];
  }

  const tenants = await Tenant.find(tenantFilter).select('+billingSuspended').sort({ createdAt: -1 });
  const subs = await TenantSubscription.find({ tenantId: { $in: tenants.map((t) => t.tenantId) } });
  const subByTenant = new Map(subs.map((s) => [s.tenantId, s]));

  let rows = tenants.map((t) => buildRow(t, subByTenant.get(t.tenantId), { targetYear, targetMonth, now }));

  const summary = computeSummary(rows);

  if (status && status !== 'all') {
    rows = status === 'overdue'
      ? rows.filter((r) => r.currentInvoice?.status === 'overdue')
      : rows.filter((r) => r.billingState === status);
  }
  if (planId) rows = rows.filter((r) => r.planId === planId);
  if (paymentMethod) rows = rows.filter((r) => r.currentInvoice?.paymentMethod === paymentMethod);
  if (minAmount !== undefined) rows = rows.filter((r) => r.outstandingAmount >= minAmount);
  if (maxAmount !== undefined) rows = rows.filter((r) => r.outstandingAmount <= maxAmount);
  if (followUpStatus) rows = rows.filter((r) => r.currentInvoice?.followUpStatuses.includes(followUpStatus));
  if (dueWindow && DUE_WINDOW_DAYS[dueWindow] !== undefined) {
    const maxDays = DUE_WINDOW_DAYS[dueWindow];
    rows = rows.filter((r) => {
      if (!r.currentInvoice || ['paid', 'cancelled', 'refunded'].includes(r.currentInvoice.status)) return false;
      const daysUntilDue = Math.ceil((new Date(r.currentInvoice.dueDate) - now) / DAY_MS);
      return daysUntilDue <= maxDays;
    });
  }

  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  return {
    rows: pageRows,
    summary,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    period: { month: targetMonth, year: targetYear },
  };
};

const getTenantBillingDetail = async (tenantId) => {
  const tenant = await Tenant.findOne({ tenantId, role: 'tenant' }).select('+billingSuspended');
  if (!tenant) throw httpError('Tenant not found.', 404);
  const sub = await getOrCreateSubscription(tenantId);
  return { tenant, subscription: sub };
};

const getAuditLog = async (tenantId, limit = 100) =>
  BillingAuditLog.find({ tenantId }).sort({ createdAt: -1 }).limit(limit);

// ── Payment Follow-Ups categorization (spec §10) ────────────────────────────

const categorizeFollowUps = async ({ upcomingWindowDays = 7 } = {}) => {
  const now = new Date();
  const settings = await billingSettingsService.getSettings();
  const subs = await TenantSubscription.find({ isEnrolled: true });
  const tenants = await Tenant.find({ tenantId: { $in: subs.map((s) => s.tenantId) } }).select('+billingSuspended');
  const tenantById = new Map(tenants.map((t) => [t.tenantId, t]));

  const buckets = { upcoming: [], dueToday: [], overdue: [], gracePeriod: [], finalWarning: [], suspended: [], paid: [] };

  for (const sub of subs) {
    const tenant = tenantById.get(sub.tenantId);
    if (!tenant) continue;
    const invoice = sub.currentInvoice();
    if (!invoice) continue;

    const daysUntilDue = Math.ceil((invoice.dueDate - now) / DAY_MS);
    const graceDays = graceDaysFor(sub, settings.defaultGracePeriodDays);
    const suspendDate = new Date(invoice.dueDate.getTime() + graceDays * DAY_MS);
    const daysUntilSuspend = Math.ceil((suspendDate - now) / DAY_MS);

    const entry = {
      tenantId: tenant.tenantId,
      tenantName: tenant.businessName || `${tenant.firstName} ${tenant.lastName}`.trim(),
      email: tenant.email,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount,
      outstanding: round2(invoice.totalAmount - (invoice.paidAmount || 0)),
      dueDate: invoice.dueDate,
      daysUntilDue,
      followUpCount: invoice.followUps.length,
    };

    if (invoice.status === 'paid') { buckets.paid.push(entry); continue; }
    if (tenant.billingSuspended) { buckets.suspended.push(entry); continue; }
    if (invoice.status === 'overdue') {
      if (daysUntilSuspend <= 1) buckets.finalWarning.push(entry);
      else buckets.gracePeriod.push(entry);
      buckets.overdue.push(entry);
      continue;
    }
    if (daysUntilDue === 0) { buckets.dueToday.push(entry); continue; }
    if (daysUntilDue > 0 && daysUntilDue <= upcomingWindowDays) { buckets.upcoming.push(entry); continue; }
  }

  return buckets;
};

// ── Billing calendar (spec §13) ─────────────────────────────────────────────

const getBillingCalendar = async ({ month, year, search, planId, status, assignedStaffName } = {}) => {
  const now = new Date();
  const targetYear = year ?? now.getFullYear();
  const targetMonth = month ?? now.getMonth() + 1;
  const rangeStart = new Date(targetYear, targetMonth - 1, 1);
  const rangeEnd = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

  let subs = await TenantSubscription.find({ isEnrolled: true });
  if (planId) subs = subs.filter((s) => String(s.planId) === planId);

  const tenantFilter = { tenantId: { $in: subs.map((s) => s.tenantId) } };
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    tenantFilter.$or = [{ businessName: re }, { firstName: re }, { lastName: re }, { email: re }];
  }
  const tenants = await Tenant.find(tenantFilter).select('businessName firstName lastName tenantId');
  const nameByTenant = new Map(tenants.map((t) => [t.tenantId, t.businessName || `${t.firstName} ${t.lastName}`.trim()]));
  if (search) subs = subs.filter((s) => nameByTenant.has(s.tenantId));

  const events = [];
  for (const sub of subs) {
    const tenantName = nameByTenant.get(sub.tenantId) || sub.tenantId;
    for (const inv of sub.invoices) {
      if ((!status || inv.status === status) && inv.dueDate >= rangeStart && inv.dueDate <= rangeEnd) {
        events.push({
          date: inv.dueDate, type: inv.status === 'overdue' ? 'overdue' : 'due', tenantId: sub.tenantId,
          tenantName, invoiceNumber: inv.invoiceNumber, amount: inv.totalAmount, status: inv.status,
        });
      }
      if (!status && inv.suspendedAt && inv.suspendedAt >= rangeStart && inv.suspendedAt <= rangeEnd) {
        events.push({ date: inv.suspendedAt, type: 'suspension', tenantId: sub.tenantId, tenantName, invoiceNumber: inv.invoiceNumber, amount: inv.totalAmount });
      }
      for (const fu of inv.followUps) {
        if (assignedStaffName && fu.assignedStaffName !== assignedStaffName) continue;
        if (!status && fu.nextFollowUpDate && fu.nextFollowUpDate >= rangeStart && fu.nextFollowUpDate <= rangeEnd) {
          events.push({ date: fu.nextFollowUpDate, type: 'follow_up', tenantId: sub.tenantId, tenantName, invoiceNumber: inv.invoiceNumber, note: fu.note, assignedStaffName: fu.assignedStaffName });
        }
      }
    }
  }
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { period: { month: targetMonth, year: targetYear }, events };
};

// ── Analytics (spec §17) ─────────────────────────────────────────────────────

const getAnalytics = async () => {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const subs = await TenantSubscription.find({});
  const tenants = await Tenant.find({ tenantId: { $in: subs.map((s) => s.tenantId) } })
    .select('tenantId businessName firstName lastName');
  const tenantNameById = new Map(tenants.map((t) => [t.tenantId, t.businessName || `${t.firstName} ${t.lastName}`.trim()]));

  const activeSubs = subs.filter((s) => s.isEnrolled && s.tenantStatus !== 'cancelled');
  const mrr = round2(activeSubs.filter((s) => s.tenantStatus !== 'trial').reduce((s, sub) => s + sub.monthlyFee, 0));
  const arr = round2(mrr * 12);

  let collectedThisYear = 0, billedThisYear = 0, failedCount = 0, refundedAmount = 0;
  let onTimeCount = 0, latePaidCount = 0, totalDelayDays = 0, delayedCount = 0;
  let newSubs30d = 0, cancelledSubs30d = 0;
  let everTrialed = 0, trialConverted = 0;
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
  const revenueByTenant = {};
  // Keyed by the invoice's own billing period (periodYear/periodMonth), not
  // createdAt/paidAt — gives a stable "revenue by billing month" trend where
  // a late payment doesn't retroactively move revenue into the paid month.
  const revenueTrendMap = new Map();
  const trendKey = (y, m) => `${y}-${m}`;

  for (const sub of subs) {
    if (sub.createdAt >= thirtyDaysAgo && sub.isEnrolled) newSubs30d++;
    if (sub.tenantStatus === 'cancelled' && sub.cancelledAt >= thirtyDaysAgo) cancelledSubs30d++;
    if (sub.trialEndsAt) {
      everTrialed++;
      if (['active', 'grace_period', 'suspended'].includes(sub.tenantStatus)) trialConverted++;
    }

    let tenantPaid = 0;
    for (const inv of sub.invoices) {
      if (inv.createdAt >= yearStart) billedThisYear += inv.totalAmount;
      if (inv.status === 'failed') failedCount++;
      refundedAmount += round2(inv.refunds.reduce((s, r) => s + r.amount, 0));

      const tKey = trendKey(inv.periodYear, inv.periodMonth);
      if (!revenueTrendMap.has(tKey)) revenueTrendMap.set(tKey, { billed: 0, collected: 0 });
      const tEntry = revenueTrendMap.get(tKey);
      if (!['cancelled', 'refunded'].includes(inv.status)) tEntry.billed = round2(tEntry.billed + inv.totalAmount);
      if (inv.paidAmount > 0) tEntry.collected = round2(tEntry.collected + inv.paidAmount);

      if ((inv.status === 'paid' || inv.status === 'partially_paid') && inv.paidAt) {
        if (inv.paidAt >= yearStart) collectedThisYear += inv.paidAmount;
        tenantPaid += inv.paidAmount;
        const delay = Math.floor((new Date(inv.paidAt) - new Date(inv.dueDate)) / DAY_MS);
        if (delay <= 0) onTimeCount++;
        else { latePaidCount++; totalDelayDays += delay; delayedCount++; }
      }
    }
    if (tenantPaid > 0) {
      const name = tenantNameById.get(sub.tenantId) || sub.tenantId;
      revenueByTenant[name] = round2((revenueByTenant[name] || 0) + tenantPaid);
    }
  }

  const revenueTrend = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const entry = revenueTrendMap.get(trendKey(y, m));
    revenueTrend.push({ month: m, year: y, billed: entry?.billed ?? 0, collected: entry?.collected ?? 0 });
  }

  const totalResolved = onTimeCount + latePaidCount;
  const totalPaymentAttempts = totalResolved + failedCount;
  const byPlan = {};
  for (const sub of activeSubs) {
    const key = sub.planName || 'Custom';
    byPlan[key] = round2((byPlan[key] || 0) + (sub.tenantStatus !== 'trial' ? sub.monthlyFee : 0));
  }

  const reactivatedLast30Days = (await BillingAuditLog.distinct('tenantId', {
    action: 'reactivated', createdAt: { $gte: thirtyDaysAgo },
  })).length;

  // churnRate: cancelled-in-window as a share of the cohort that could have
  // churned (still-active + cancelled). renewalRate is its complement —
  // a simple, clearly-labeled approximation rather than a cohort-billing-
  // period calculation (which would need a persisted subscription-history
  // table this schema doesn't keep).
  const churnCohort = subs.filter((s) => s.tenantStatus === 'active').length + cancelledSubs30d;
  const churnRate = churnCohort ? round2((cancelledSubs30d / churnCohort) * 100) : 0;

  return {
    revenue: {
      mrr, arr,
      collectedThisYear: round2(collectedThisYear),
      billedThisYear: round2(billedThisYear),
      outstanding: round2(billedThisYear - collectedThisYear),
      refunded: round2(refundedAmount),
      failedPayments: failedCount,
      revenueByPlan: byPlan,
      revenueByTenant,
      revenueTrend,
    },
    subscriptions: {
      active: subs.filter((s) => s.tenantStatus === 'active').length,
      trial: subs.filter((s) => s.tenantStatus === 'trial').length,
      gracePeriod: subs.filter((s) => s.tenantStatus === 'grace_period').length,
      suspended: subs.filter((s) => s.tenantStatus === 'suspended').length,
      cancelled: subs.filter((s) => s.tenantStatus === 'cancelled').length,
      newLast30Days: newSubs30d,
      cancelledLast30Days: cancelledSubs30d,
      reactivatedLast30Days,
      trialConversionRate: everTrialed ? round2((trialConverted / everTrialed) * 100) : 0,
      churnRate,
      renewalRate: round2(100 - churnRate),
    },
    payments: {
      collectionRate: totalResolved ? round2((onTimeCount + latePaidCount) / totalResolved * 100) : 0,
      onTimeRate: totalResolved ? round2(onTimeCount / totalResolved * 100) : 0,
      lateRate: totalResolved ? round2(latePaidCount / totalResolved * 100) : 0,
      failedRate: totalPaymentAttempts ? round2((failedCount / totalPaymentAttempts) * 100) : 0,
      averagePaymentDelayDays: delayedCount ? round2(totalDelayDays / delayedCount) : 0,
    },
  };
};

module.exports = {
  DEFAULT_GRACE_PERIOD_DAYS,
  getOrCreateSubscription,
  runDailyBillingSweep,
  recordManualPayment,
  markPaymentFailed,
  issueRefund,
  addFollowUp,
  updateFollowUpStatus,
  waiveInvoice,
  updateSubscriptionConfig,
  changePlan,
  cancelSubscription,
  manualReactivate,
  manualSuspend,
  sendManualReminder,
  applyAdjustment,
  listBillingOverview,
  getTenantBillingDetail,
  getAuditLog,
  categorizeFollowUps,
  getBillingCalendar,
  getAnalytics,
};
