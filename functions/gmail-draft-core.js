const crypto = require("node:crypto");

const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const MAILBOX = "mentoraedge@gmail.com";
const DRAFT_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function generateOAuthState() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashOAuthState(state) {
  if (typeof state !== "string" || !STATE_FORMAT.test(state)) throw codedError("invalid-argument", "OAuth state is invalid.");
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

function assertOAuthStateRecord(record, nowMs = Date.now()) {
  const expiresAtMs = record?.expiresAt?.toMillis?.() ??
    (record?.expiresAt instanceof Date ? record.expiresAt.getTime() : record?.expiresAtMs);
  if (!record || typeof record.adminUid !== "string" || !record.adminUid ||
      typeof record.redirectUri !== "string" || !record.redirectUri ||
      !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || record.consumedAt) {
    throw codedError("failed-precondition", "OAuth state is expired, invalid, or already used.");
  }
  return record;
}

async function consumeOAuthState(stateDb, rawState, nowMs = Date.now()) {
  const ref = stateDb.collection("gmailOAuthStates").doc(hashOAuthState(rawState));
  return stateDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = assertOAuthStateRecord(snapshot.exists ? snapshot.data() : null, nowMs);
    transaction.update(ref, { consumedAt: new Date(nowMs) });
    return { adminUid: record.adminUid, redirectUri: record.redirectUri };
  });
}

function buildGmailAuthorizationUrl({ clientId, redirectUri, state }) {
  if (typeof clientId !== "string" || !clientId || typeof redirectUri !== "string" || !redirectUri) {
    throw codedError("failed-precondition", "Gmail OAuth configuration is incomplete.");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "form_post",
    scope: "openid email https://www.googleapis.com/auth/gmail.compose",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  }).toString();
  return url.toString();
}

function assertGoogleMailbox(payload, expectedClientId) {
  if (!payload || payload.aud !== expectedClientId || payload.email_verified !== true ||
      typeof payload.email !== "string" || payload.email !== MAILBOX ||
      typeof payload.sub !== "string" || !payload.sub) {
    throw codedError("permission-denied", "The Google account is not the approved mailbox.");
  }
  return { email: MAILBOX, subject: payload.sub };
}

function claimDraftDisposition(existing, adminUid, payloadHash) {
  if (!existing) return "new";
  if (existing.createdBy !== adminUid) throw codedError("permission-denied", "This Gmail draft request belongs to another administrator.");
  if (existing.payloadHash !== payloadHash) throw codedError("failed-precondition", "This request ID is already bound to different salary details.");
  if (existing.status === "draft_created" && typeof existing.gmailDraftId === "string" && existing.gmailDraftId) return "already-created";
  if (existing.status === "creating") return "in-progress";
  if (existing.status === "unknown") return "uncertain";
  if (existing.status === "failed" && existing.retryable === true) return "retry";
  throw codedError("failed-precondition", "This Gmail draft request cannot be retried safely.");
}

function assertDraftPayloadCompatible(salaryRecord, payloadHash) {
  if (salaryRecord?.gmailDraftPayloadHash && salaryRecord.gmailDraftPayloadHash !== payloadHash) {
    throw codedError("failed-precondition", "This salary request is locked to an existing Gmail draft attempt and cannot be changed.");
  }
  return salaryRecord;
}

function base64Lines(value) {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function buildSalarySlipMime({ recipient, employeeName, payPeriod, referenceNumber, requestId, filename, pdf }) {
  if (![recipient, employeeName, payPeriod, referenceNumber, requestId, filename].every((value) => typeof value === "string" && value.length && !/[\r\n\x00]/.test(value))) {
    throw codedError("invalid-argument", "The draft message contains invalid header values.");
  }
  if (!Buffer.isBuffer(pdf) || pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw codedError("invalid-argument", "The canonical salary-slip PDF is invalid.");
  }
  const boundary = `mentora_${crypto.randomBytes(18).toString("hex")}`;
  const subject = Buffer.from(`Salary Slip ${payPeriod} - ${referenceNumber}`, "utf8").toString("base64");
  const body = `Dear ${employeeName},\n\nPlease find attached your salary slip for the pay period ${payPeriod}.\n\nReference: ${referenceNumber}\nRequest ID: ${requestId}\n\nThis message was prepared by Mentora Edge.\n\nRegards,\nMentora Edge\nShaping Minds | Sharpening Futures`;
  const message = [
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Message-ID: <${requestId}@drafts.mentoraedge.online>`,
    `X-Mentora-Request-ID: ${requestId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(body),
    `--${boundary}`,
    `Content-Type: application/pdf; name=\"${filename}\"`,
    `Content-Disposition: attachment; filename=\"${filename}\"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(pdf),
    `--${boundary}--`,
    ""
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

async function createGmailDraftMessage(accessToken, rawMime, fetchImpl = fetch) {
  const response = await fetchImpl(DRAFT_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: rawMime } }),
    redirect: "error",
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.id !== "string" || !result.id) {
    const error = codedError(`GMAIL_DRAFT_${response.status}`, "Gmail did not confirm draft creation.");
    error.ambiguous = response.status >= 500 || response.status === 429;
    throw error;
  }
  return result.id;
}

function gmailDraftUrl() {
  return "https://mail.google.com/mail/u/0/#drafts";
}

function classifyDraftFailure(error, gmailRequestDispatched) {
  const definiteRejection = /^GMAIL_DRAFT_4\d\d$/.test(error?.code || "") && error.ambiguous !== true;
  const knownWorkerOutcome = error?.workerRequestDispatched === true && error?.ambiguous === false;
  const ambiguous = error?.ambiguous === true ||
    (gmailRequestDispatched === true && error?.workerRequestDispatched !== false && !definiteRejection && !knownWorkerOutcome);
  return { ambiguous, retryable: !ambiguous && error?.retryable !== false };
}

module.exports = {
  assertGoogleMailbox, assertOAuthStateRecord, buildGmailAuthorizationUrl, buildSalarySlipMime,
  assertDraftPayloadCompatible, claimDraftDisposition, consumeOAuthState, createGmailDraftMessage, generateOAuthState,
  classifyDraftFailure, gmailDraftUrl, hashOAuthState
};
