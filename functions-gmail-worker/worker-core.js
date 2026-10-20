const crypto = require("node:crypto");

const EXPECTED_CALLER = "mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com";
const DRAFT_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^ME-PAY-(\d{4})-(0[1-9]|1[0-2])-(?!000)\d{3}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function workerFailure(code, message, { statusCode = 400, outcome = "not_created", retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.outcome = outcome;
  error.retryable = retryable;
  return error;
}

function validateEmail(value) {
  if (typeof value !== "string" || value.length < 6 || value.length > 254 || value !== value.trim() || CONTROL.test(value)) {
    throw workerFailure("WORKER_INVALID_RECIPIENT", "Invalid recipient.");
  }
  const [local, domain, extra] = value.split("@");
  const labels = (domain || "").split(".");
  if (extra !== undefined || (local || "").length > 64 || (domain || "").length > 253 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local || "") || !/^[A-Za-z0-9.-]+$/.test(domain || "") ||
      local.includes("..") || local.startsWith(".") || local.endsWith(".") || labels.length < 2 ||
      labels.some((label) => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) || labels.at(-1).length < 2) {
    throw workerFailure("WORKER_INVALID_RECIPIENT", "Invalid recipient.");
  }
  return value;
}

function validatePayPeriod(value) {
  if (typeof value !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    throw workerFailure("WORKER_INVALID_PERIOD", "Invalid pay period.");
  }
  const [day, month, year] = value.split("/").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw workerFailure("WORKER_INVALID_PERIOD", "Invalid pay period.");
  }
  return value;
}

function validateWorkerPayload(body, rawBodyLength) {
  if (!Number.isSafeInteger(rawBodyLength) || rawBodyLength < 1 || rawBodyLength > MAX_REQUEST_BYTES) {
    throw workerFailure("WORKER_REQUEST_TOO_LARGE", "The worker request exceeds its size limit.", { statusCode: 413 });
  }
  const keys = ["requestId", "payloadHash", "recipient", "employeeName", "payPeriod", "referenceNumber", "filename", "pdfBase64"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length ||
      Object.keys(body).some((key) => !keys.includes(key))) {
    throw workerFailure("WORKER_INVALID_PAYLOAD", "The worker request payload is invalid.");
  }
  if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId) ||
      typeof body.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(body.payloadHash)) {
    throw workerFailure("WORKER_INVALID_PAYLOAD", "The worker request payload is invalid.");
  }
  if (typeof body.employeeName !== "string" || body.employeeName.length < 2 || body.employeeName.length > 80 ||
      body.employeeName !== body.employeeName.trim() || CONTROL.test(body.employeeName)) {
    throw workerFailure("WORKER_INVALID_PAYLOAD", "The worker request payload is invalid.");
  }
  if (typeof body.referenceNumber !== "string" || !REFERENCE.test(body.referenceNumber) ||
      typeof body.filename !== "string" || body.filename.length > 180 || !/^Mentora_Edge_Salary_Slip_[A-Za-z0-9._-]+\.pdf$/.test(body.filename)) {
    throw workerFailure("WORKER_INVALID_PAYLOAD", "The worker request payload is invalid.");
  }
  if (typeof body.pdfBase64 !== "string" || body.pdfBase64.length < 8 || body.pdfBase64.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 8 ||
      body.pdfBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.pdfBase64)) {
    throw workerFailure("WORKER_INVALID_PDF", "The PDF attachment is invalid.");
  }
  const pdf = Buffer.from(body.pdfBase64, "base64");
  if (pdf.length > MAX_PDF_BYTES || pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-" || pdf.toString("base64") !== body.pdfBase64) {
    throw workerFailure("WORKER_INVALID_PDF", "The PDF attachment is invalid.");
  }
  return {
    requestId: body.requestId.toLowerCase(), payloadHash: body.payloadHash,
    recipient: validateEmail(body.recipient), employeeName: body.employeeName,
    payPeriod: validatePayPeriod(body.payPeriod), referenceNumber: body.referenceNumber,
    filename: body.filename, pdf
  };
}

function assertWorkerAudience(value) {
  let url;
  try { url = new URL(value); } catch { throw workerFailure("WORKER_NOT_CONFIGURED", "Worker authentication is not configured.", { statusCode: 503 }); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw workerFailure("WORKER_NOT_CONFIGURED", "Worker authentication is not configured.", { statusCode: 503 });
  }
  return url.toString();
}

async function verifyCallingIdentity(authorization, verifier, audience, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof authorization !== "string" || authorization.length > 16384) {
    throw workerFailure("WORKER_UNAUTHENTICATED", "Authenticated service invocation is required.", { statusCode: 401 });
  }
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) throw workerFailure("WORKER_UNAUTHENTICATED", "Authenticated service invocation is required.", { statusCode: 401 });
  let payload;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: match[1], audience });
    payload = ticket.getPayload();
  } catch {
    throw workerFailure("WORKER_UNAUTHENTICATED", "Authenticated service invocation is required.", { statusCode: 401 });
  }
  const validIssuer = payload?.iss === "https://accounts.google.com" || payload?.iss === "accounts.google.com";
  if (!validIssuer || payload.aud !== audience || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds ||
      payload.email !== EXPECTED_CALLER || payload.email_verified !== true) {
    throw workerFailure("WORKER_FORBIDDEN", "The calling service identity is not authorized.", { statusCode: 403 });
  }
  return EXPECTED_CALLER;
}

function base64Lines(value) {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function buildDraftMime(payload) {
  const boundary = `mentora_${crypto.randomBytes(18).toString("hex")}`;
  const subject = Buffer.from(`Salary Slip ${payload.payPeriod} - ${payload.referenceNumber}`, "utf8").toString("base64");
  const body = `Dear ${payload.employeeName},\n\nPlease find attached your salary slip for the pay period ${payload.payPeriod}.\n\nReference: ${payload.referenceNumber}\nRequest ID: ${payload.requestId}\n\nThis message was prepared by Mentora Edge.\n\nRegards,\nMentora Edge\nShaping Minds | Sharpening Futures`;
  return Buffer.from([
    `To: ${payload.recipient}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Message-ID: <${payload.requestId}@drafts.mentoraedge.online>`,
    `X-Mentora-Request-ID: ${payload.requestId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    base64Lines(body), `--${boundary}`, `Content-Type: application/pdf; name=\"${payload.filename}\"`,
    `Content-Disposition: attachment; filename=\"${payload.filename}\"`, "Content-Transfer-Encoding: base64", "",
    base64Lines(payload.pdf), `--${boundary}--`, ""
  ].join("\r\n"), "utf8").toString("base64url");
}

async function refreshAccessToken({ config, secrets, fetchImpl }) {
  try {
    const [clientSecret, refreshToken] = await Promise.all([
      secrets.read(config.clientSecretId), secrets.read(config.refreshTokenSecretId)
    ]);
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.access_token !== "string") {
      throw workerFailure("WORKER_OAUTH_UNAVAILABLE", "Gmail credentials are unavailable.", { statusCode: 502, retryable: true });
    }
    return result.access_token;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw workerFailure("WORKER_OAUTH_UNAVAILABLE", "Gmail credentials are unavailable.", { statusCode: 502, retryable: true });
  }
}

async function createDraft(accessToken, rawMime, fetchImpl, onDispatched) {
  let response;
  try {
    onDispatched();
    response = await fetchImpl(DRAFT_ENDPOINT, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: rawMime } }), redirect: "error", signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw workerFailure("GMAIL_DRAFT_OUTCOME_UNKNOWN", "Gmail may have created the draft, but the response was not confirmed.", {
      statusCode: 502, outcome: "unknown", retryable: false
    });
  }
  const result = await response.json().catch(() => ({}));
  if (response.ok && typeof result.id === "string" && result.id.length > 0 && result.id.length <= 512) return result.id;
  const isDefiniteRejection = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw workerFailure(isDefiniteRejection ? `GMAIL_DRAFT_${response.status}` : "GMAIL_DRAFT_OUTCOME_UNKNOWN",
    "Gmail did not confirm draft creation.", {
      statusCode: isDefiniteRejection ? 422 : 502,
      outcome: isDefiniteRejection ? "not_created" : "unknown",
      retryable: isDefiniteRejection
    });
}

function createGmailDraftWorkerHandler({ verifier, secrets, fetchImpl = fetch, getConfig }) {
  return async (request, response) => {
    response.set("Cache-Control", "no-store, max-age=0");
    response.set("X-Content-Type-Options", "nosniff");
    let gmailRequestDispatched = false;
    try {
      const config = getConfig();
      const audience = assertWorkerAudience(config.audience);
      await verifyCallingIdentity(request.get("authorization"), verifier, audience);
      if (request.method !== "POST") throw workerFailure("WORKER_METHOD_NOT_ALLOWED", "Only POST is supported.", { statusCode: 405 });
      if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") || "")) {
        throw workerFailure("WORKER_CONTENT_TYPE", "Content-Type must be application/json.", { statusCode: 415 });
      }
      const rawLength = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.length
        : Buffer.byteLength(JSON.stringify(request.body || {}), "utf8");
      const payload = validateWorkerPayload(request.body, rawLength);
      if (!config.clientId || !config.clientSecretId || !config.refreshTokenSecretId) {
        throw workerFailure("WORKER_NOT_CONFIGURED", "Gmail draft credentials are not configured.", { statusCode: 503, retryable: true });
      }
      const accessToken = await refreshAccessToken({ config, secrets, fetchImpl });
      const rawMime = buildDraftMime(payload);
      const draftId = await createDraft(accessToken, rawMime, fetchImpl, () => { gmailRequestDispatched = true; });
      response.status(200).json({ draftId });
    } catch (error) {
      if (!error?.statusCode) {
        error = workerFailure(
          gmailRequestDispatched ? "GMAIL_DRAFT_OUTCOME_UNKNOWN" : "WORKER_FAILURE",
          gmailRequestDispatched ? "Gmail may have created the draft, but the response was not confirmed." : "The worker could not process the request.",
          gmailRequestDispatched
            ? { statusCode: 502, outcome: "unknown", retryable: false }
            : { statusCode: 502, outcome: "not_created", retryable: true }
        );
      }
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      response.status(status).json({
        code: typeof error?.code === "string" && /^[A-Z0-9_-]{1,48}$/.test(error.code) ? error.code : "WORKER_FAILURE",
        outcome: error?.outcome === "unknown" ? "unknown" : "not_created",
        retryable: error?.retryable === true
      });
    }
  };
}

module.exports = {
  DRAFT_ENDPOINT, EXPECTED_CALLER, MAX_PDF_BYTES, MAX_REQUEST_BYTES,
  assertWorkerAudience, buildDraftMime, createGmailDraftWorkerHandler,
  validateWorkerPayload, verifyCallingIdentity
};
