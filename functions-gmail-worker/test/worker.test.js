const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DRAFT_ENDPOINT, EXPECTED_CALLER, MAX_PDF_BYTES, MAX_REQUEST_BYTES,
  createGmailDraftWorkerHandler, validateWorkerPayload, verifyCallingIdentity
} = require("../worker-core");

const AUDIENCE = "https://asia-south1-mentora-edge-v2.cloudfunctions.net/gmailDraftWorker";
const ORCHESTRATOR = "550e8400-e29b-41d4-a716-446655440000";
const PDF = Buffer.from("%PDF-1.7\nvalidated canonical salary slip");
const validPayload = () => ({
  requestId: ORCHESTRATOR,
  payloadHash: "a".repeat(64),
  recipient: "employee@example.com",
  employeeName: "Employee Name",
  payPeriod: "05/04/2027",
  referenceNumber: "ME-PAY-2027-04-001",
  filename: "Mentora_Edge_Salary_Slip_Employee_Name_April_2027.pdf",
  pdfBase64: PDF.toString("base64")
});

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request(payload = validPayload(), overrides = {}) {
  return {
    method: "POST",
    rawBody: Buffer.from(JSON.stringify(payload)),
    body: payload,
    get(name) {
      const key = name.toLowerCase();
      if (key === "authorization") return "Bearer signed-google-id-token";
      if (key === "content-type") return "application/json; charset=utf-8";
      return overrides[key];
    },
    ...overrides
  };
}

function validVerifier(payload = {}) {
  return { async verifyIdToken(args) {
    assert.equal(args.idToken, "signed-google-id-token");
    assert.equal(args.audience, AUDIENCE);
    return { getPayload: () => ({
      iss: "https://accounts.google.com", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300,
      email: EXPECTED_CALLER, email_verified: true, ...payload
    }) };
  } };
}

test("valid worker request authenticates orchestrator and creates only a Gmail draft", async () => {
  const calls = [];
  const secrets = { async read(id) { calls.push({ secret: id }); return id.includes("client-secret") ? "mock-secret" : "mock-refresh-token"; } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token") return { ok: true, json: async () => ({ access_token: "mock-access-token" }) };
    return { ok: true, status: 200, json: async () => ({ id: "draft-123" }) };
  };
  const handler = createGmailDraftWorkerHandler({
    verifier: validVerifier(), secrets, fetchImpl,
    getConfig: () => ({ clientId: "mock-client-id", clientSecretId: "client-secret", refreshTokenSecretId: "refresh-token", audience: AUDIENCE })
  });
  const res = responseCapture();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { draftId: "draft-123" });
  const gmailCall = calls.find((call) => call.url === DRAFT_ENDPOINT);
  assert.equal(gmailCall.options.method, "POST");
  assert.doesNotMatch(gmailCall.url, /messages:send|drafts:send/);
});

test("worker rejects missing, malformed, expired, wrong-audience, and unauthorized caller ID tokens", async () => {
  const invalidVerifier = { async verifyIdToken() { throw new Error("invalid token"); } };
  await assert.rejects(verifyCallingIdentity(undefined, invalidVerifier, AUDIENCE), { statusCode: 401 });
  await assert.rejects(verifyCallingIdentity("Basic token", invalidVerifier, AUDIENCE), { statusCode: 401 });
  await assert.rejects(verifyCallingIdentity("Bearer not-a-valid-token", invalidVerifier, AUDIENCE), { statusCode: 401 });

  for (const claims of [
    { exp: 1 },
    { aud: "https://wrong-audience.example" },
    { email: "other-service@mentora-edge-v2.iam.gserviceaccount.com" },
    { email_verified: false },
    { iss: "https://attacker.example" }
  ]) {
    await assert.rejects(verifyCallingIdentity("Bearer signed-google-id-token", validVerifier(claims), AUDIENCE), { statusCode: 403 });
  }
});

test("worker validates method, content type, schema, recipient, PDF and strict sizes", () => {
  const payload = validPayload();
  assert.equal(validateWorkerPayload(payload, Buffer.byteLength(JSON.stringify(payload))).recipient, "employee@example.com");
  assert.throws(() => validateWorkerPayload({ ...payload, extra: true }, 100), { code: "WORKER_INVALID_PAYLOAD" });
  assert.throws(() => validateWorkerPayload({ ...payload, recipient: "bad\r\nBcc:x@example.com" }, 100), { code: "WORKER_INVALID_RECIPIENT" });
  assert.throws(() => validateWorkerPayload({ ...payload, pdfBase64: Buffer.from("not a pdf").toString("base64") }, 100), { code: "WORKER_INVALID_PDF" });
  assert.throws(() => validateWorkerPayload(payload, MAX_REQUEST_BYTES + 1), { code: "WORKER_REQUEST_TOO_LARGE" });
  const largePdf = Buffer.alloc(MAX_PDF_BYTES + 1, 0x41); largePdf.write("%PDF-", 0, "ascii");
  assert.throws(() => validateWorkerPayload({ ...payload, pdfBase64: largePdf.toString("base64") }, 1024), { code: "WORKER_INVALID_PDF" });
});

test("private worker handler rejects unauthorized, wrong-method and wrong-content-type invocations", async () => {
  const handler = createGmailDraftWorkerHandler({
    verifier: validVerifier(), secrets: { async read() { throw new Error("should not read"); } },
    getConfig: () => ({ audience: AUDIENCE, clientId: "id", clientSecretId: "secret", refreshTokenSecretId: "refresh" })
  });
  const unauthenticated = request(); unauthenticated.get = (name) => name.toLowerCase() === "content-type" ? "application/json" : undefined;
  let res = responseCapture(); await handler(unauthenticated, res); assert.equal(res.statusCode, 401);
  const wrongMethod = request(); wrongMethod.method = "GET";
  res = responseCapture(); await handler(wrongMethod, res); assert.equal(res.statusCode, 405);
  const wrongType = request(); wrongType.get = (name) => name.toLowerCase() === "authorization" ? "Bearer signed-google-id-token" : "text/plain";
  res = responseCapture(); await handler(wrongType, res); assert.equal(res.statusCode, 415);
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /invoker: "private"/);
});

test("worker source has no Firestore imports or calls and contains no send endpoint", () => {
  const files = ["index.js", "worker-core.js", "secret-manager.js"].map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
  assert.doesNotMatch(files, /firebase-admin\/firestore|getFirestore|runTransaction|\.collection\(/);
  assert.doesNotMatch(files, /users\/messages\/send|users\/drafts\/send|messages:send|drafts:send/);
  assert.match(files, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts/);
});

test("worker returns uncertain on Gmail timeout-class responses without revealing provider content", async () => {
  const handler = createGmailDraftWorkerHandler({
    verifier: validVerifier(), secrets: { async read(id) { return id === "client" ? "secret" : "refresh"; } },
    getConfig: () => ({ audience: AUDIENCE, clientId: "id", clientSecretId: "client", refreshTokenSecretId: "refresh" }),
    fetchImpl: async (url) => url === "https://oauth2.googleapis.com/token"
      ? { ok: true, json: async () => ({ access_token: "access" }) }
      : { ok: false, status: 503, json: async () => ({ error_description: "private provider detail" }) }
  });
  const res = responseCapture(); await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { code: "GMAIL_DRAFT_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
  assert.doesNotMatch(JSON.stringify(res.body), /private provider detail/);
});

test("worker network timeout after dispatch is uncertain; secret failure before dispatch is safely retryable", async () => {
  const settings = { audience: AUDIENCE, clientId: "id", clientSecretId: "client", refreshTokenSecretId: "refresh" };
  const timeoutHandler = createGmailDraftWorkerHandler({
    verifier: validVerifier(), secrets: { async read() { return "secret"; } }, getConfig: () => settings,
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, json: async () => ({ access_token: "access" }) };
      throw new Error("socket timeout after request dispatch");
    }
  });
  const timeoutRes = responseCapture(); await timeoutHandler(request(), timeoutRes);
  assert.deepEqual(timeoutRes.body, { code: "GMAIL_DRAFT_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });

  const secretFailureHandler = createGmailDraftWorkerHandler({
    verifier: validVerifier(), secrets: { async read() { throw new Error("secret access denied"); } }, getConfig: () => settings,
    fetchImpl: async () => { throw new Error("must not request Gmail"); }
  });
  const secretRes = responseCapture(); await secretFailureHandler(request(), secretRes);
  assert.deepEqual(secretRes.body, { code: "WORKER_OAUTH_UNAVAILABLE", outcome: "not_created", retryable: true });
});

