const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString, defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const { createSalarySlipPdf, salaryFilename } = require("./payroll-pdf");
const {
  assertReference, assertRequestId, formatReference, nextReferenceSequence, normalizeHistoryLimit,
  normalizeSalary, requireAdminIdentity, sendDisposition, smtpTransportSecurity,
  validateHistoryRequest, validateSalaryOperation
} = require("./payroll-core");

initializeApp();
const db = getFirestore();
const smtpHost = defineString("SMTP_HOST");
const smtpPort = defineString("SMTP_PORT", { default: "587" });
const smtpUser = defineString("SMTP_USER");
const smtpFrom = defineString("SMTP_FROM");
const smtpPassword = defineSecret("SMTP_PASSWORD");
const MAX_SENDS_PER_ADMIN_PER_DAY = 100;
// TEMPORARY: Disable App Check only for payroll callables while the reCAPTCHA Enterprise token issue is investigated.
const callableOptions = { region: "asia-south1", enforceAppCheck: false, timeoutSeconds: 60, memory: "512MiB", maxInstances: 3 };

async function requireAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Please sign in as an administrator.");
  const profile = await db.collection("users").doc(request.auth.uid).get();
  return validateWithHttpsError(requireAdminIdentity, request.auth, profile.exists ? profile.data() : null);
}

function validateWithHttpsError(validator, ...args) {
  try {
    return validator(...args);
  } catch (error) {
    const callableCodes = new Set(["invalid-argument", "unauthenticated", "permission-denied", "not-found", "failed-precondition"]);
    if (callableCodes.has(error?.code)) throw new HttpsError(error.code, error.message);
    throw error;
  }
}

function recordData(salary, payloadHash) {
  return { ...salary, payloadHash, updatedAt: FieldValue.serverTimestamp() };
}

async function allocateReference(transaction, year, month) {
  const periodKey = `${year}-${String(month).padStart(2, "0")}`;
  const counterRef = db.collection("salarySlipCounters").doc(periodKey);
  const counterSnap = await transaction.get(counterRef);
  const lastSequence = Number(counterSnap.data()?.lastSequence || 0);
  if (!Number.isInteger(lastSequence) || lastSequence < 0 || lastSequence > 999) {
    throw new HttpsError("failed-precondition", "The monthly salary reference counter is invalid.");
  }
  const blockedSequences = new Set();
  let sequence = nextReferenceSequence(lastSequence, blockedSequences);
  let referenceNumber;
  while (sequence !== null) {
    referenceNumber = assertReference(formatReference(year, month, sequence));
    const legacyCollision = await transaction.get(db.collection("salarySlips").doc(referenceNumber));
    const recordCollision = await transaction.get(db.collection("salarySlips").where("referenceNumber", "==", referenceNumber).limit(1));
    if (!legacyCollision.exists && recordCollision.empty) break;
    blockedSequences.add(sequence);
    sequence = nextReferenceSequence(lastSequence, blockedSequences);
  }
  if (sequence === null) throw new HttpsError("resource-exhausted", "The monthly salary reference sequence is full.");
  transaction.set(counterRef, { period: periodKey, lastSequence: sequence, updatedAt: FieldValue.serverTimestamp() });
  return referenceNumber;
}

async function prepareRecord(adminUid, requestId, normalized) {
  const slips = db.collection("salarySlips");
  const requestRef = slips.doc(requestId);
  return db.runTransaction(async (transaction) => {
    const existingSnap = await transaction.get(requestRef);
    if (existingSnap.exists) {
      const existing = existingSnap.data();
      if (existing.createdBy !== adminUid) throw new HttpsError("permission-denied", "This send request belongs to another administrator.");
      if (existing.status !== "draft" && existing.payloadHash !== normalized.payloadHash) {
        throw new HttpsError("failed-precondition", "This request has already started. Its salary details cannot be changed; reconcile its send status before starting another request.");
      }
      if (existing.status === "sent" || existing.status === "sending" || existing.status === "unknown") return existing;
      let referenceNumber = existing.referenceNumber;
      if (existing.periodYear !== normalized.salary.periodYear || existing.periodMonth !== normalized.salary.periodMonth) {
        referenceNumber = await allocateReference(transaction, normalized.salary.periodYear, normalized.salary.periodMonth);
      }
      const updated = { ...recordData(normalized.salary, normalized.payloadHash), referenceNumber };
      transaction.update(requestRef, updated);
      return { ...existing, ...updated };
    }

    const referenceNumber = await allocateReference(transaction, normalized.salary.periodYear, normalized.salary.periodMonth);
    const created = {
      ...normalized.salary, payloadHash: normalized.payloadHash, requestId, referenceNumber,
      status: "draft", retryable: false, createdBy: adminUid,
      createdAt: FieldValue.serverTimestamp(), sentAt: null,
      failureReason: null
    };
    transaction.create(requestRef, created);
    return created;
  });
}

function callableResult(record, pdfBase64) {
  return {
    status: record.status,
    referenceNumber: assertReference(record.referenceNumber),
    totalEarnings: record.totalEarnings,
    filename: salaryFilename(record),
    ...(pdfBase64 ? { pdfBase64 } : {})
  };
}

exports.prepareSalarySlip = onCall(callableOptions, async (request) => {
  const adminUid = await requireAdmin(request);
  const operation = validateWithHttpsError(validateSalaryOperation, request.data);
  const requestId = validateWithHttpsError(assertRequestId, operation.requestId);
  const normalized = validateWithHttpsError(normalizeSalary, operation.salary);
  const record = await prepareRecord(adminUid, requestId, normalized);
  const pdf = await createSalarySlipPdf(record, assertReference(record.referenceNumber));
  return callableResult(record, pdf.toString("base64"));
});

function smtpTransport() {
  const host = smtpHost.value();
  const user = smtpUser.value();
  const from = smtpFrom.value();
  const port = Number(smtpPort.value());
  if (!host || /[\r\n\x00]/.test(host) || !user || /[\r\n\x00]/.test(user) || !from || /[\r\n\x00]/.test(from) || ![465, 587].includes(port)) {
    throw new HttpsError("failed-precondition", "SMTP configuration is incomplete. Configure a valid host, sender, user, and port 465 or 587.");
  }
  return {
    from, port,
    transporter: nodemailer.createTransport({
      host, port, ...smtpTransportSecurity(port),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
      auth: { user, pass: smtpPassword.value() }
    })
  };
}

async function claimSend(adminUid, requestId, payloadHash) {
  const requestRef = db.collection("salarySlips").doc(requestId);
  const rateKey = new Date().toISOString().slice(0, 10);
  const rateRef = db.collection("payrollRateLimits").doc(`${adminUid}_${rateKey}`);
  return db.runTransaction(async (transaction) => {
    const [recordSnap, rateSnap] = await Promise.all([transaction.get(requestRef), transaction.get(rateRef)]);
    const record = recordSnap.exists ? recordSnap.data() : null;
    const disposition = validateWithHttpsError(sendDisposition, record, adminUid, payloadHash);
    if (disposition === "already-handled") return { record, claimed: false };
    const count = Number(rateSnap.data()?.count || 0);
    if (count >= MAX_SENDS_PER_ADMIN_PER_DAY) throw new HttpsError("resource-exhausted", "Daily salary-slip send limit reached. Try again tomorrow or contact the system administrator.");
    const next = {
      status: "sending", retryable: false, failureReason: null,
      sendStartedAt: FieldValue.serverTimestamp(),
      sendAttemptCount: Number(record.sendAttemptCount || 0) + 1
    };
    transaction.update(requestRef, next);
    transaction.set(rateRef, { count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { record: { ...record, ...next }, claimed: true };
  });
}

function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "EMAIL_PROVIDER_ERROR";
  return /^[A-Z0-9_-]{1,48}$/.test(code) ? code : "EMAIL_PROVIDER_ERROR";
}

exports.sendSalarySlip = onCall({ ...callableOptions, secrets: [smtpPassword] }, async (request) => {
  const adminUid = await requireAdmin(request);
  const operation = validateWithHttpsError(validateSalaryOperation, request.data);
  const requestId = validateWithHttpsError(assertRequestId, operation.requestId);
  const normalized = validateWithHttpsError(normalizeSalary, operation.salary);
  const record = await prepareRecord(adminUid, requestId, normalized);
  if (["sent", "sending", "unknown"].includes(record.status)) return callableResult(record);

  const { transporter, from } = smtpTransport();
  const pdf = await createSalarySlipPdf(record, assertReference(record.referenceNumber));
  const claimed = await claimSend(adminUid, requestId, normalized.payloadHash);
  if (!claimed.claimed) return callableResult(claimed.record);

  const requestRef = db.collection("salarySlips").doc(requestId);
  const filename = salaryFilename(record);
  try {
    const info = await transporter.sendMail({
      from, to: record.employeeEmail, subject: "Monthly Salary Slip",
      messageId: `<${requestId}@payroll.mentoraedge>`,
      text: `Dear ${record.employeeName},\n\nPlease find attached your salary slip for the pay period ${record.payPeriod}.\n\nYou can download and retain your salary slip for your records.\n\nRegards,\nMentora Edge\nShaping Minds · Sharpening Futures`,
      attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
      disableFileAccess: true, disableUrlAccess: true
    });
    const accepted = Array.isArray(info.accepted) && info.accepted.some((address) => String(address).toLowerCase() === record.employeeEmail.toLowerCase());
    if (!accepted) {
      await requestRef.update({ status: "failed", retryable: true, failureReason: "RECIPIENT_REJECTED", failedAt: FieldValue.serverTimestamp() });
      return { status: "failed", referenceNumber: record.referenceNumber, message: "The mail server rejected this recipient. Review the address and retry this same request." };
    }
    await requestRef.update({ status: "sent", retryable: false, failureReason: null, sentAt: FieldValue.serverTimestamp(), messageId: `<${requestId}@payroll.mentoraedge>` });
    return { status: "sent", referenceNumber: record.referenceNumber };
  } catch (error) {
    const failureCode = safeFailureCode(error);
    try {
      await requestRef.update({ status: "unknown", retryable: false, failureReason: failureCode, outcomeUnknownAt: FieldValue.serverTimestamp() });
    } catch (stateError) {
      console.error("Payroll state update failed", { requestId, code: safeFailureCode(stateError) });
    }
    console.error("Payroll email outcome requires reconciliation", { requestId, code: failureCode });
    return { status: "unknown", referenceNumber: record.referenceNumber, message: "The mail outcome is uncertain. Do not resend as a new request until the mail provider has been checked." };
  }
});

exports.listSalarySlips = onCall({ ...callableOptions, timeoutSeconds: 30 }, async (request) => {
  await requireAdmin(request);
  validateWithHttpsError(validateHistoryRequest, request.data);
  const limit = validateWithHttpsError(normalizeHistoryLimit, request.data?.limit);
  const snapshot = await db.collection("salarySlips").orderBy("createdAt", "desc").limit(limit).get();
  return {
    records: snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        requestId: data.requestId || doc.id,
        referenceNumber: data.referenceNumber || "",
        employeeName: data.employeeName || "",
        employeeId: data.employeeId || "",
        payPeriod: data.payPeriod || "",
        totalEarnings: Number(data.totalEarnings) || 0,
        status: data.status || "unknown",
        createdAt: data.createdAt?.toDate().toISOString() || null,
        sentAt: data.sentAt?.toDate().toISOString() || null
      };
    })
  };
});
