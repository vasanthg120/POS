/** A merged CRM quotation (CRM data + POS tracking + Razorpay), as the backend's normalise()/mergeTracking() return it. */

export interface PriceAdjustment {
  name: string;
  amount: number;
  rate: string | null;
}

export interface QuoteBreakdown {
  subtotal: number;
  discounts: PriceAdjustment[];
  fees: PriceAdjustment[];
  taxes: PriceAdjustment[];
  discountTotal: number;
  feesTotal: number;
  taxTotal: number;
  total: number;
}

export interface QuoteTimelineEntry {
  event: string;
  date: string;
  by: string;
  type: 'status' | 'payment' | 'note' | 'warning' | 'error' | string;
}

export interface QuotePaymentEntry {
  source: 'Manual' | 'Razorpay' | string;
  amount: number;
  date: string | null;
  reference: string | null;
}

export interface QuoteDetailData {
  quoteId: string;
  quoteNumber: string;
  title?: string;
  dealName?: string;
  ownerName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  customerAddress?: string;
  ownerCompany?: string;
  ownerCompanyCity?: string;
  ownerTaxIds?: { label: string; value: string }[];

  amount: number;
  currency?: string;
  status?: string;
  clientApprovalStatus?: string;
  approvalStatus?: 'approved' | 'rejected' | 'pending' | 'draft' | string;
  isExpired?: boolean;
  isDraft?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiryDate?: string | null;
  notes?: string;
  paymentOption?: string;

  breakdown?: QuoteBreakdown;
  clientFeedback?: { text: string; date: string | null; fromClient: boolean }[];

  quotationStatus?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  paidAmount?: number;
  balanceDue?: number;
  paidAt?: string | null;
  bankTransferRef?: string;
  bankTransferNotes?: string;
  timeline?: QuoteTimelineEntry[];
  manualPayments?: {
    amount: number; method: string; referenceNumber?: string;
    paymentDate?: string; notes?: string;
  }[];
  payments?: QuotePaymentEntry[];
  _paymentId?: string | null;
  rzpBank?: string | null;
  rzpVpa?: string | null;
  rzpWallet?: string | null;
  trackingUpdatedAt?: string | null;
  outcome?: 'approved' | 'pending' | 'rejectedOrExpired' | string;

  raw?: Record<string, unknown>;
}
