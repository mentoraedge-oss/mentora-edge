const crypto = require("node:crypto");

const MAX_COMPONENT = 10000000;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^ME-PAY-(\d{4})-(0[1-9]|1[0-2])-(?!000)\d{3}$/;

function reject(field, reason) {
  const error = new Error(`${field} ${reason}`);
  error.code = "invalid-argument";
  return error;
}

function assertObjectShape(value, field, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reject(field, "must be an object.");
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw reject(field, "contains missing or unsupported fields.");
  }
  return value;
}

function validateSalaryOperation(value) {
  return assertObjectShape(value, "Payroll request", ["requestId", "salary"]);
}

function validateHistoryRequest(value) {
  return assertObjectShape(value, "History request", [], ["limit"]);
}

function normalizeHistoryLimit(value) {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw reject("History limit", "must be an integer from 1 to 100.");
  return value;
}

function requireAdminIdentity(auth, profile) {
  if (!auth?.uid) {
    const error = new Error("Authentication is required.");
    error.code = "unauthenticated";
    throw error;
  }
  if (!isAdminProfile(auth, profile)) {
    const error = new Error("Administrator access is required.");
    error.code = "permission-denied";
    throw error;
  }
  return auth.uid;
}

function sendDisposition(record, adminUid, payloadHash) {
  if (!record) {
    const error = new Error("Salary slip request was not found.");
    error.code = "not-found";
    throw error;
  }
  if (record.createdBy !== adminUid) {
    const error = new Error("This send request belongs to another administrator.");
    error.code = "permission-denied";
    throw error;
  }
  if (record.payloadHash !== payloadHash) {
    const error = new Error("Salary details changed after preparation.");
    error.code = "failed-precondition";
    throw error;
  }
  if (["sent", "sending", "unknown"].includes(record.status)) return "already-handled";
  if (record.status === "draft" || (record.status === "failed" && record.retryable === true)) return "send";
  const error = new Error("This salary slip is not in a sendable state.");
  error.code = "failed-precondition";
  throw error;
}

function smtpTransportSecurity(port) {
  if (port === 465) return { secure: true, requireTLS: false, tls: { rejectUnauthorized: true } };
  if (port === 587) return { secure: false, requireTLS: true, tls: { rejectUnauthorized: true } };
  throw reject("SMTP port", "must be 465 or 587.");
}

function nextReferenceSequence(lastSequence, blockedSequences) {
  if (!Number.isInteger(lastSequence) || lastSequence < 0 || lastSequence > 999 || !(blockedSequences instanceof Set)) {
    throw reject("Reference sequence", "counter data is invalid.");
  }
  let sequence = lastSequence + 1;
  while (sequence <= 999 && blockedSequences.has(sequence)) sequence++;
  return sequence <= 999 ? sequence : null;
}

function text(value, field, { min = 1, max = 100, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || value !== value.trim() || CONTROL_OR_FORMAT.test(value)) {
    throw reject(field, `must be ${min}-${max} characters with no surrounding whitespace or control characters.`);
  }
  if (pattern && !pattern.test(value)) throw reject(field, "has an invalid format.");
  return value;
}

function parsePayPeriod(value) {
  const period = text(value, "Pay period", { min: 10, max: 10, pattern: /^\d{2}\/\d{2}\/\d{4}$/ });
  const [, dayText, monthText, yearText] = period.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const day = Number(dayText), month = Number(monthText), year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw reject("Pay period", "must be a valid date in DD/MM/YYYY format.");
  }
  return { value: period, year, month };
}

function numberAmount(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COMPONENT || Number(value.toFixed(2)) !== value) {
    throw reject(field, `must be an amount from 0 to ${MAX_COMPONENT} with at most two decimal places.`);
  }
  return Math.round(value * 100) / 100;
}

function component(value, display, field, allowNA) {
  const amount = numberAmount(value, field);
  if (allowNA && display === "NA") {
    if (amount !== 0) throw reject(field, "must be zero when its display value is NA.");
    return { amount: 0, display: "NA" };
  }
  if (display !== amount) throw reject(field, "display value must match its amount.");
  return { amount, display };
}

function normalizeEmail(value) {
  const email = text(value, "Employee email", { min: 6, max: 254 });
  const [local, domain, extra] = email.split("@");
  const labels = (domain || "").split(".");
  if (extra !== undefined || (local || "").length > 64 || (domain || "").length > 253 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local || "") || !/^[A-Za-z0-9.-]+$/.test(domain || "") ||
      local.includes("..") || local.startsWith(".") || local.endsWith(".") || labels.length < 2 ||
      labels.some((label) => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) || labels.at(-1).length < 2) {
    throw reject("Employee email", "must be a valid ASCII email address.");
  }
  return email;
}

function normalizeSalary(input) {
  assertObjectShape(input, "Salary", ["payPeriod", "employeeId", "employeeName", "position", "employeeEmail", "basicPay", "allowance", "allowanceDisplay", "overtimePay", "overtimeDisplay", "bonus", "bonusDisplay", "totalEarnings"], ["accountNumber"]);
  const payPeriod = parsePayPeriod(input.payPeriod);
  const employeeId = text(input.employeeId, "Employee ID", { min: 3, max: 40, pattern: /^[A-Z0-9][A-Z0-9-]*$/ });
  const latin = "A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF";
  const employeeName = text(input.employeeName, "Employee name", { min: 2, max: 80, pattern: new RegExp(`^[${latin}](?:[${latin} .'-]*[${latin}])?$`) });
  const position = text(input.position, "Position", { min: 2, max: 80, pattern: new RegExp(`^[${latin}0-9](?:[${latin}0-9 &/().'-]*[${latin}0-9])?$`) });
  const employeeEmail = normalizeEmail(input.employeeEmail);
  const basicPay = numberAmount(input.basicPay, "Basic pay");
  const allowance = component(input.allowance, input.allowanceDisplay, "Allowance", true);
  const overtime = component(input.overtimePay, input.overtimeDisplay, "Overtime pay", true);
  const bonus = component(input.bonus, input.bonusDisplay, "Bonus", true);
  const totalEarnings = Math.round((basicPay + allowance.amount + overtime.amount + bonus.amount) * 100) / 100;
  if (typeof input.totalEarnings !== "number" || !Number.isFinite(input.totalEarnings) || Math.round(input.totalEarnings * 100) !== Math.round(totalEarnings * 100)) {
    throw reject("Total earnings", "do not match the salary components.");
  }

  let accountLast4 = "";
  if (input.accountNumber !== undefined && input.accountNumber !== "") {
    const accountNumber = text(input.accountNumber, "Account number", { min: 6, max: 34, pattern: /^\d{6,34}$/ });
    accountLast4 = accountNumber.slice(-4);
  }

  const salary = {
    payPeriod: payPeriod.value, periodYear: payPeriod.year, periodMonth: payPeriod.month,
    employeeId, employeeName, position, employeeEmail, basicPay,
    allowance: allowance.amount, allowanceDisplay: allowance.display,
    overtimePay: overtime.amount, overtimeDisplay: overtime.display,
    bonus: bonus.amount, bonusDisplay: bonus.display,
    totalEarnings, accountLast4
  };
  return { salary, payloadHash: crypto.createHash("sha256").update(JSON.stringify(salary)).digest("hex") };
}

function assertRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw reject("Send request ID", "must be a UUID v4.");
  return value.toLowerCase();
}

function formatReference(year, month, sequence) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) throw reject("Reference number", "sequence is exhausted for this month.");
  return `ME-PAY-${year}-${String(month).padStart(2, "0")}-${String(sequence).padStart(3, "0")}`;
}

function assertReference(value) {
  if (typeof value !== "string" || !REFERENCE.test(value)) throw reject("Reference number", "must match ME-PAY-YYYY-MM-NNN.");
  return value;
}

function isAdminProfile(requestAuth, profile) {
  return Boolean(requestAuth?.uid && profile && profile.role === "admin");
}

module.exports = {
  assertObjectShape, assertReference, assertRequestId, formatReference, isAdminProfile,
  nextReferenceSequence, normalizeHistoryLimit, normalizeSalary, requireAdminIdentity,
  sendDisposition, smtpTransportSecurity, validateHistoryRequest, validateSalaryOperation
};
