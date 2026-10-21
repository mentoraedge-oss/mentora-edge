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

export function asDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const registrationStatus = String(profile.registrationPaymentStatus || "").toLowerCase();
  const fallback = registrationStatus === "verified" || registrationStatus === "paid"
    ? "Paid"
    : registrationStatus === "pending_verification" || (!registrationStatus && profile.paymentDueAtRegistration !== undefined)
      ? "Pending Verification"
      : "Not Paid";
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

export function registrationPaymentLabel(profile = {}) {
  if (profile.registrationPaymentStatus === "verified" || profile.registrationPaymentStatus === "paid") return "Registration payment verified";
  if (profile.registrationPaymentStatus === "pending_verification") return "Registration payment pending verification";
  if (profile.registrationPaymentStatus === "cancelled" || profile.registrationPaymentStatus === "canceled") return "Registration payment cancelled";
  if (profile.registrationPaymentStatus === "failed") return "Registration payment failed";
  if (profile.registrationPaymentStatus === "not_paid") return "Registration payment not paid";
  if (profile.paymentDueAtRegistration !== undefined && profile.paymentDueAtRegistration !== null) return "Registration payment status pending verification";
  return "Registration payment not recorded";
}
