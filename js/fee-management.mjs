export const MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
]);

export const QUARTERS = Object.freeze([
  Object.freeze({ id: "Q1", label: "First Quarter (April–June)", startMonth: 3, endMonth: 5 }),
  Object.freeze({ id: "Q2", label: "Second Quarter (July–September)", startMonth: 6, endMonth: 8 }),
  Object.freeze({ id: "Q3", label: "Third Quarter (October–December)", startMonth: 9, endMonth: 11 }),
  Object.freeze({ id: "Q4", label: "Fourth Quarter (January–March)", startMonth: 0, endMonth: 2 })
]);

// The saved-plan registration forms first appear in ad88a12 (2026-10-21).
// Compare timestamps rather than treating every profile without a frequency as legacy.
const PAYMENT_PLAN_INTRODUCED_AT = new Date("2026-10-21T17:00:52+05:30");
const PLAN_FIELDS = ["paymentFrequency", "planTotal", "paymentDueAtRegistration", "registrationPaymentStatus", "paymentDuePeriod", "paymentInstallments", "programType"];
const MONTH_NAMES = new Set(MONTHS);

export function asDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasLegacyMonthlyMap(fees = {}) {
  return Object.entries(fees).some(([year, periods]) =>
    /^\d{4}$/.test(year) && periods && typeof periods === "object" &&
    Object.entries(periods).some(([month, record]) => MONTH_NAMES.has(month) && record && typeof record === "object" &&
      (record.paid === true || record.paid === false || record.paidOn != null) &&
      record.status === undefined && record.amount === undefined)
  );
}

export function classifyFeeProfile(profile = {}) {
  const frequency = String(profile.paymentFrequency || "").trim().toLowerCase();
  const date = asDate(profile.createdAt);
  const planEvidence = PLAN_FIELDS.some(field => profile[field] !== undefined && profile[field] !== null && profile[field] !== "");
  // Existing pre-plan registrations remain legacy monthly even if later edits left stray plan fields.
  if (date && date < PAYMENT_PLAN_INTRODUCED_AT) {
    return { kind: "legacy_monthly", frequency: "monthly", diagnostic: null };
  }
  if (["monthly", "quarterly", "annual"].includes(frequency)) {
    return { kind: "plan", frequency, diagnostic: null };
  }
  if (planEvidence) {
    return { kind: "incomplete", frequency: null, diagnostic: `Payment-plan metadata is incomplete or invalid (saved frequency: ${frequency || "missing"}).` };
  }
  if (date && date >= PAYMENT_PLAN_INTRODUCED_AT) {
    return { kind: "incomplete", frequency: null, diagnostic: "This student was registered after payment plans were introduced, but no supported payment frequency is saved." };
  }
  if (hasLegacyMonthlyMap(profile.fees)) {
    return { kind: "legacy_monthly", frequency: "monthly", diagnostic: null };
  }
  return { kind: "unknown", frequency: null, diagnostic: "Fee workflow cannot be classified: registration date and legacy monthly fee records are unavailable." };
}

export function academicSession(dateValue) {
  const date = asDate(dateValue) || new Date();
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return { startYear, endYear: startYear + 1, key: `${startYear}-${startYear + 1}` };
}

function quarterEnd(sessionStartYear, quarter) {
  const year = quarter.id === "Q4" ? sessionStartYear + 1 : sessionStartYear;
  return new Date(year, quarter.endMonth + 1, 0, 23, 59, 59, 999);
}

function statusFor(record, fallback) {
  if (record?.paid === true || record?.status === "paid") return "Paid";
  if (record?.status === "pending_verification" || record?.paymentRequest?.status === "pending_verification") return "Pending Verification";
  return fallback;
}

const CLOSED_PAYMENT_REQUEST_STATUSES = new Set(["cancelled", "canceled", "failed", "rejected", "expired"]);

export function feePeriodStatus(period, request, requestStatusKnown = request !== undefined) {
  if (period.status === "Paid" || period.status === "Not Applicable") return period.status;
  if (period.registrationPaymentPending) return "Pending Verification";
  const requestStatus = String(request?.status || "").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (requestStatus === "pending_verification") return "Pending Verification";
  if (CLOSED_PAYMENT_REQUEST_STATUSES.has(requestStatus)) return "Not Paid";
  if (requestStatusKnown && period.status === "Pending Verification" && !request) return "Not Paid";
  return period.status;
}

export function canInitiateFeePayment(period, request) {
  return period.requestStatusAvailable !== false && period.applicable && Number(period.amount) > 0 && feePeriodStatus(period, request) === "Not Paid";
}

export function buildFeePaymentRequest(profile = {}, period = {}, reference = "", createdAt = null, studentUid = "") {
  const classification = classifyFeeProfile(profile);
  if (classification.kind !== "plan") throw new Error("A supported saved payment plan is required for a fee payment request.");
  if (!period.applicable || !(Number(period.amount) > 0) || !period.id || !period.periodKey) throw new Error("The fee period is not payable.");
  if (!String(studentUid).trim()) throw new Error("The signed-in student's UID is required for a fee payment request.");
  const matchesFrequency = classification.frequency === "monthly"
    ? /^\d{4}-(?:January|February|March|April|May|June|July|August|September|October|November|December)$/.test(period.periodKey)
    : classification.frequency === "quarterly"
      ? /^\d{4}-\d{4}\.Q[1-4]$/.test(period.periodKey)
      : /^\d{4}-\d{4}\.annual$/.test(period.periodKey);
  if (!matchesFrequency) throw new Error("The fee period does not match the saved payment frequency.");
  const expectedPeriodId = classification.frequency === "monthly" ? period.periodKey : period.periodKey.replace(".", "-");
  if (period.id !== expectedPeriodId) throw new Error("The fee period identifier does not match its period key.");
  const monthlyMatch = String(period.periodKey).match(/^(\d{4})-(January|February|March|April|May|June|July|August|September|October|November|December)$/);
  const planSessionMatch = String(period.periodKey).match(/^(\d{4}-\d{4})\.(?:Q[1-4]|annual)$/);
  const monthIndex = monthlyMatch ? MONTHS.indexOf(monthlyMatch[2]) : -1;
  const periodSession = planSessionMatch
    ? planSessionMatch[1]
    : monthlyMatch
      ? academicSession(new Date(Number(monthlyMatch[1]), monthIndex, 1)).key
      : null;
  if (!periodSession) throw new Error("The fee period academic session is invalid.");
  return {
    studentUid: String(studentUid),
    periodId: period.id,
    periodKey: period.periodKey,
    periodLabel: period.label,
    academicSession: periodSession,
    amount: Number(period.amount),
    paymentFrequency: classification.frequency,
    programType: profile.programType || "individual-subject",
    status: "pending_verification",
    reference,
    createdAt
  };
}

export function assertFeePaymentRequestCanBeSubmitted(existingRequest) {
  if (existingRequest?.status === "pending_verification") throw new Error("A payment request for this period is already awaiting verification.");
  if (existingRequest?.status === "verified" || existingRequest?.status === "paid") throw new Error("This period already has a verified payment request.");
  return true;
}

export function monthlyPeriods({ year = new Date().getFullYear(), enrolledAt, fees = {}, defaultAmount = 0, asOf = new Date() } = {}) {
  const enrollment = asDate(enrolledAt);
  const now = asDate(asOf) || new Date();
  const records = fees[String(year)] || {};
  return MONTHS.map((month, index) => {
    const record = records[month];
    const periodDate = new Date(year, index, 1);
    const applicable = year <= now.getFullYear() &&
      (!enrollment || periodDate >= new Date(enrollment.getFullYear(), enrollment.getMonth(), 1));
    const fallback = applicable ? "Not Paid" : "Not Applicable";
    return {
      id: `${year}-${month}`,
      periodKey: `${year}-${month}`,
      label: month,
      amount: Number.isFinite(Number(record?.amount)) && Number(record?.amount) > 0 ? Number(record.amount) : defaultAmount,
      applicable,
      status: applicable ? statusFor(record, fallback) : "Not Applicable",
      paidOn: record?.paidOn || null,
      request: record?.paymentRequest || null
    };
  });
}

export function quarterlyPeriods({ date = new Date(), enrolledAt, fees = {}, installments = [] } = {}) {
  const session = academicSession(date);
  const enrollment = asDate(enrolledAt);
  const records = fees[session.key] || {};
  return QUARTERS.map((quarter, index) => {
    const record = records[quarter.id];
    const applicable = !enrollment || quarterEnd(session.startYear, quarter) >= enrollment;
    const fallback = applicable ? "Not Paid" : "Not Applicable";
    return {
      id: `${session.key}-${quarter.id}`,
      periodKey: `${session.key}.${quarter.id}`,
      label: quarter.label,
      amount: Number.isFinite(Number(record?.amount)) && Number(record?.amount) > 0
        ? Number(record.amount)
        : Number(installments[index]) || 0,
      applicable,
      status: statusFor(record, record?.status === "not_applicable" ? "Not Applicable" : fallback),
      paidOn: record?.paidOn || null,
      request: record?.paymentRequest || null
    };
  });
}

export function annualPeriod({ profile = {}, date = new Date(), fees = {} } = {}) {
  const session = academicSession(date);
  const record = fees[session.key]?.annual || {};
  const amount = Number(record.amount) || Number(profile.planTotal) || 0;
  const fallback = "Not Paid";
  return {
    id: `${session.key}-annual`,
    periodKey: `${session.key}.annual`,
    label: `Annual Fee (${session.key})`,
    amount,
    applicable: true,
    status: statusFor(record, fallback),
    paidOn: record.paidOn || null,
    request: record.paymentRequest || null
  };
}

export function monthlyAmount(profile, programs) {
  if (profile.programType === "all-subject-combo") return programs.secondary.combo.monthly;
  const subject = String(profile.subject || "").split(",")[0].trim();
  return programs.secondary.subjects[subject] || Number(profile.feeAmount) || 0;
}

export function feePeriodsForProfile(profile = {}, { date = new Date(), programs } = {}) {
  const classification = classifyFeeProfile(profile);
  const fees = profile.fees || {};
  if (classification.kind === "legacy_monthly") {
    const now = asDate(date) || new Date();
    const enrolledAt = asDate(profile.createdAt);
    const years = new Set(Object.keys(fees).filter(key => /^\d{4}$/.test(key)));
    years.add(String(now.getFullYear()));
    return [...years].sort().flatMap(yearKey => {
      const year = Number(yearKey);
      if (year > now.getFullYear()) return [];
      const records = fees[yearKey] || {};
      return monthlyPeriods({ year, enrolledAt, fees, defaultAmount: Number(profile.feeAmount) || 0, asOf: now })
        .filter(period => {
          const record = records[period.label];
          return Boolean(record) || (Boolean(enrolledAt) && period.applicable);
        })
        .map(period => {
          const record = records[period.label];
          const applicable = record?.status === "not_applicable" ? false : true;
          return { ...period, label: `${period.label} ${year}`, applicable, paymentEnabled: false, status: record?.status === "not_applicable" ? "Not Applicable" : period.status };
        });
    });
  }
  if (classification.kind !== "plan") return [];
  if (classification.frequency === "monthly") {
    return monthlyPeriods({ year: (asDate(date) || new Date()).getFullYear(), enrolledAt: profile.createdAt, fees, defaultAmount: monthlyAmount(profile, programs) });
  }
  if (classification.frequency === "quarterly") {
    return quarterlyPeriods({ date, enrolledAt: profile.createdAt, fees, installments: programs?.secondary?.combo?.quarterlyInstallments || [] });
  }
  return [annualPeriod({ profile, date, fees })];
}

export function markFeePeriodPaid(profile = {}, period = {}, paidOn) {
  const match = String(period.periodKey || "").match(/^(\d{4})-([A-Za-z]+)$/) || String(period.periodKey || "").match(/^(\d{4}-\d{4})\.(Q[1-4]|annual)$/);
  if (!match) throw new Error("Fee period reference is invalid.");
  const fees = { ...(profile.fees || {}) };
  const bucket = { ...(fees[match[1]] || {}) };
  const existing = bucket[match[2]] || {};
  if (existing.paid === true || existing.status === "paid") throw new Error("This period is already verified as paid.");
  const legacy = classifyFeeProfile(profile).kind === "legacy_monthly";
  bucket[match[2]] = legacy
    ? { ...existing, paid: true, paidOn: existing.paidOn || paidOn }
    : { ...existing, ...(Number(period.amount) > 0 ? { amount: Number(period.amount) } : {}), paid: true, status: "paid", paidOn: existing.paidOn || paidOn };
  fees[match[1]] = bucket;
  return fees;
}

export function markFeePeriodUnpaid(profile = {}, period = {}) {
  if (classifyFeeProfile(profile).kind !== "legacy_monthly") throw new Error("Only legacy monthly periods can be changed back to unpaid.");
  const match = String(period.periodKey || "").match(/^(\d{4})-([A-Za-z]+)$/);
  if (!match) throw new Error("Fee period reference is invalid.");
  const fees = { ...(profile.fees || {}) };
  const bucket = { ...(fees[match[1]] || {}) };
  const existing = bucket[match[2]] || {};
  bucket[match[2]] = { ...existing, paid: false };
  fees[match[1]] = bucket;
  return fees;
}

export function registrationPaymentLabel(profile = {}) {
  if (profile.registrationPaymentStatus === "verified" || profile.registrationPaymentStatus === "paid") return "Registration payment verified";
  if (profile.registrationPaymentStatus === "pending_verification") return "Registration payment pending verification";
  if (profile.registrationPaymentStatus === "cancelled" || profile.registrationPaymentStatus === "canceled") return "Registration payment cancelled";
  if (profile.registrationPaymentStatus === "failed") return "Registration payment failed";
  if (profile.registrationPaymentStatus === "not_paid") return "Registration payment not paid";
  if (profile.paymentDueAtRegistration !== undefined && profile.paymentDueAtRegistration !== null) return "Registration payment status pending verification";
  return "Registration payment not recorded";
}
