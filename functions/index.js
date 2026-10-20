const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString, defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { GoogleAuth, OAuth2Client } = require("google-auth-library");
const nodemailer = require("nodemailer");
const { createSalarySlipPdf, salaryFilename } = require("./payroll-pdf");
const { createSecretManagerClient } = require("./gmail-secret-manager");
const {
  assertDraftPayloadCompatible, assertGoogleMailbox, buildGmailAuthorizationUrl,
  claimDraftDisposition, classifyDraftFailure, consumeOAuthState,
  generateOAuthState, hashOAuthState, gmailDraftUrl
} = require("./gmail-draft-core");
const { claimSalarySlipDraft: claimSalarySlipDraftTransaction, invokePrivateGmailDraftWorker } = require("./gmail-draft-orchestrator");
const {
  assertReference, assertRequestId, formatReference, nextReferenceSequence, normalizeHistoryLimit,
  normalizeSalary, requireAdminIdentity, sendDisposition, smtpTransportSecurity,
  validateHistoryRequest, validateSalaryOperation
} = require("./payroll-core");

initializeApp();
const db = getFirestore();
// OAuth state is isolated from payroll documents in the default database.
const oauthStateDb = getFirestore("mentora-oauth-state");
const smtpHost = defineString("SMTP_HOST");
const smtpPort = defineString("SMTP_PORT", { default: "587" });
const smtpUser = defineString("SMTP_USER");
const smtpFrom = defineString("SMTP_FROM");
const smtpPassword = defineSecret("SMTP_PASSWORD");
const gmailOAuthClientId = defineString("GMAIL_OAUTH_CLIENT_ID", { default: "" });
const gmailOAuthRedirectUri = defineString("GMAIL_OAUTH_REDIRECT_URI", { default: "" });
const gmailOAuthClientSecretId = defineString("GMAIL_OAUTH_CLIENT_SECRET_ID", { default: "gmail-oauth-client-secret" });
const gmailOAuthRefreshTokenSecretId = defineString("GMAIL_OAUTH_REFRESH_TOKEN_SECRET_ID", { default: "gmail-oauth-refresh-token" });
const gmailDraftWorkerUrl = defineString("GMAIL_DRAFT_WORKER_URL", { default: "" });
const MAX_SENDS_PER_ADMIN_PER_DAY = 100;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COLLECTION = "gmailOAuthStates";
const DRAFT_REQUEST_COLLECTION = "salarySlipDraftRequests";
const GMAIL_DRAFT_ORCHESTRATOR_SERVICE_ACCOUNT = "mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com";
const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const gmailSecrets = createSecretManagerClient(googleAuth);
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
      validateWithHttpsError(assertDraftPayloadCompatible, existing, normalized.payloadHash);
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

function oauthConfiguration() {
  const clientId = gmailOAuthClientId.value();
  const redirectUriValue = gmailOAuthRedirectUri.value();
  if (!clientId || !redirectUriValue) {
    throw new HttpsError("failed-precondition", "Gmail OAuth is not configured. Complete the documented Google Cloud setup first.");
  }
  let redirectUri;
  try { redirectUri = new URL(redirectUriValue); } catch {
    throw new HttpsError("failed-precondition", "The Gmail OAuth callback URL is not configured correctly.");
  }
  if (redirectUri.protocol !== "https:" || redirectUri.username || redirectUri.password || redirectUri.search || redirectUri.hash) {
    throw new HttpsError("failed-precondition", "The Gmail OAuth callback URL must be an HTTPS function URL without query parameters.");
  }
  return { clientId, redirectUri: redirectUri.toString() };
}

function callbackRequestMatches(request, redirectUri) {
  const expected = new URL(redirectUri);
  const host = request.get("host");
  const requestPath = request.path || "/";
  const forwardedProtocol = request.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || request.protocol;
  return protocol === "https" && host === expected.host &&
    (requestPath === "/" || requestPath === expected.pathname);
}

function callbackFormParams(request) {
  if (!request.is("application/x-www-form-urlencoded")) return null;
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  if (Buffer.isBuffer(request.rawBody)) return Object.fromEntries(new URLSearchParams(request.rawBody.toString("utf8")));
  return null;
}

exports.beginGmailDraftOAuth = onCall({
  ...callableOptions,
  serviceAccount: GMAIL_DRAFT_ORCHESTRATOR_SERVICE_ACCOUNT
}, async (request) => {
  const adminUid = await requireAdmin(request);
  const { clientId, redirectUri } = oauthConfiguration();
  const rawState = generateOAuthState();
  const now = Date.now();
  const stateRef = oauthStateDb.collection(OAUTH_STATE_COLLECTION).doc(hashOAuthState(rawState));
  try {
    await stateRef.create({
      adminUid,
      redirectUri,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(now + OAUTH_STATE_TTL_MS),
      consumedAt: null
    });
  } catch (error) {
    console.error("Gmail OAuth state creation failed", { code: safeFailureCode(error) });
    throw new HttpsError("internal", "Could not start Gmail authorization. Please try again.");
  }
  return { authorizationUrl: buildGmailAuthorizationUrl({ clientId, redirectUri, state: rawState }) };
});

function htmlCallbackPage(success) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Mentora Edge Gmail authorization</title><body style="font:16px system-ui,sans-serif;max-width:600px;margin:12vh auto;padding:24px;color:#0f2a44"><h1>${success ? "Authorization complete" : "Authorization could not be completed"}</h1><p>${success ? "Gmail draft access is ready. You may close this window." : "The Gmail authorization was not completed. Return to Mentora Edge and start authorization again, or contact the administrator."}</p></body></html>`;
}

async function exchangeAuthorizationCode(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  const tokenResponse = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokenResponse.id_token !== "string" || typeof tokenResponse.refresh_token !== "string") {
    const error = new Error("Google authorization exchange failed or did not return offline credentials.");
    error.code = `OAUTH_EXCHANGE_${response.status}`;
    throw error;
  }
  return tokenResponse;
}

exports.gmailOAuthCallback = require("firebase-functions/v2/https").onRequest({
  region: "asia-south1",
  serviceAccount: "mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com",
  invoker: "public",
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 2
}, async (request, response) => {
  response.set("Cache-Control", "no-store, max-age=0");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("Referrer-Policy", "no-referrer");
  if (request.method !== "POST") {
    response.status(405).type("html").send(htmlCallbackPage(false));
    return;
  }
  try {
    const { clientId, redirectUri } = oauthConfiguration();
    if (!callbackRequestMatches(request, redirectUri)) throw new Error("Callback URL mismatch.");
    const callbackParams = callbackFormParams(request);
    if (!callbackParams) throw new Error("Invalid authorization response type.");
    const rawState = callbackParams.state;
    if (typeof rawState !== "string") throw new Error("Invalid state.");
    const stateRecord = await consumeOAuthState(oauthStateDb, rawState, Date.now());
    if (stateRecord.redirectUri !== redirectUri) throw new Error("Callback URL changed during authorization.");
    if (callbackParams.error) throw new Error("Authorization was declined.");
    const code = callbackParams.code;
    if (typeof code !== "string" || code.length < 1 || code.length > 4096 || /[\r\n\x00]/.test(code)) throw new Error("Invalid authorization response.");
    const clientSecret = await gmailSecrets.read(gmailOAuthClientSecretId.value());
    const tokens = await exchangeAuthorizationCode(code, clientId, clientSecret, redirectUri);
    const verifier = new OAuth2Client(clientId);
    const ticket = await verifier.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    assertGoogleMailbox(ticket.getPayload(), clientId);
    await gmailSecrets.addVersion(gmailOAuthRefreshTokenSecretId.value(), tokens.refresh_token);
    response.status(200).type("html").send(htmlCallbackPage(true));
  } catch (error) {
    console.error("Gmail OAuth callback failed", { code: safeFailureCode(error) });
    response.status(400).type("html").send(htmlCallbackPage(false));
  }
});

async function claimSalarySlipDraft(adminUid, requestId, payloadHash) {
  try {
    return await claimSalarySlipDraftTransaction({
      db, FieldValue, adminUid, requestId, payloadHash,
      claimDraftDisposition,
      assertDraftPayloadCompatible
    });
  } catch (error) {
    const callableCodes = new Set(["invalid-argument", "unauthenticated", "permission-denied", "not-found", "failed-precondition"]);
    if (callableCodes.has(error?.code)) throw new HttpsError(error.code, error.message);
    throw error;
  }
}

function draftResult(record) {
  return {
    status: "draft_created",
    draftId: record.gmailDraftId,
    requestId: record.requestId,
    referenceNumber: assertReference(record.referenceNumber),
    gmailUrl: gmailDraftUrl()
  };
}

async function updateDraftState(requestId, values) {
  await db.collection(DRAFT_REQUEST_COLLECTION).doc(requestId).update({ ...values, updatedAt: FieldValue.serverTimestamp() });
}

exports.createSalarySlipDraft = onCall({
  ...callableOptions,
  serviceAccount: GMAIL_DRAFT_ORCHESTRATOR_SERVICE_ACCOUNT,
  timeoutSeconds: 60
}, async (request) => {
  const adminUid = await requireAdmin(request);
  const operation = validateWithHttpsError(validateSalaryOperation, request.data);
  const requestId = validateWithHttpsError(assertRequestId, operation.requestId);
  const normalized = validateWithHttpsError(normalizeSalary, operation.salary);
  await prepareRecord(adminUid, requestId, normalized);
  const claim = await claimSalarySlipDraft(adminUid, requestId, normalized.payloadHash);
  if (!claim.created) return draftResult(claim.record);

  const referenceNumber = assertReference(claim.salary.referenceNumber);
  const filename = salaryFilename(claim.salary).replace(/[^A-Za-z0-9._-]/g, "_");
  let gmailRequestDispatched = false;
  try {
    const pdf = await createSalarySlipPdf(claim.salary, referenceNumber);
    const workerUrl = gmailDraftWorkerUrl.value();
    const workerPayload = {
      requestId,
      payloadHash: normalized.payloadHash,
      recipient: claim.salary.employeeEmail,
      employeeName: claim.salary.employeeName,
      payPeriod: claim.salary.payPeriod,
      referenceNumber,
      filename,
      pdfBase64: pdf.toString("base64")
    };
    const workerResult = await invokePrivateGmailDraftWorker({
      workerUrl,
      googleAuth,
      payload: workerPayload,
      onDispatched: () => { gmailRequestDispatched = true; }
    });
    const gmailDraftId = workerResult.draftId;
    const completed = {
      provider: "gmail", requestId, createdBy: adminUid, payloadHash: normalized.payloadHash,
      referenceNumber, status: "draft_created", retryable: false,
      attemptCount: claim.record.attemptCount, gmailDraftId,
      createdAt: claim.record.createdAt, draftCreatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    try { await updateDraftState(requestId, completed); }
    catch (error) {
      // Gmail confirmed creation. Leave the claim non-retryable if persistence fails; never create a second draft automatically.
      console.error("Gmail draft result persistence failed", { requestId, code: safeFailureCode(error) });
    }
    return draftResult(completed);
  } catch (error) {
    const { ambiguous, retryable } = classifyDraftFailure(error, gmailRequestDispatched);
    try {
      await updateDraftState(requestId, {
        status: ambiguous ? "unknown" : "failed",
        retryable,
        failureCode: safeFailureCode(error),
        outcomeUnknownAt: ambiguous ? FieldValue.serverTimestamp() : null
      });
    } catch (stateError) {
      console.error("Gmail draft outcome state update failed", { requestId, code: safeFailureCode(stateError) });
    }
    console.error("Gmail draft creation failed", { requestId, code: safeFailureCode(error), ambiguous });
    if (ambiguous) {
      throw new HttpsError("failed-precondition", "Gmail may have created this draft, but the result could not be confirmed. Check Gmail Drafts and reconcile before retrying.");
    }
    throw new HttpsError("failed-precondition", "Gmail could not create the draft. Review the configuration and retry this same request if no draft exists.");
  }
});
