const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertDraftPayloadCompatible, assertGoogleMailbox, assertOAuthStateRecord, buildGmailAuthorizationUrl, buildSalarySlipMime,
  claimDraftDisposition, classifyDraftFailure, consumeOAuthState, createGmailDraftMessage, generateOAuthState,
  gmailDraftUrl, hashOAuthState
} = require("../gmail-draft-core");
const { createSecretManagerClient } = require("../gmail-secret-manager");

function stateDatabase(initial) {
  let data = initial;
  let documentId;
  const ref = { id: "", collectionName: "" };
  const database = {
    collection(name) {
      ref.collectionName = name;
      return { doc(id) { documentId = id; ref.id = id; return ref; } };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get() { return { exists: data !== null, data: () => data }; },
        update(_document, patch) { writes.push(patch); }
      };
      const result = await callback(transaction);
      for (const write of writes) data = { ...data, ...write };
      return result;
    },
    inspect() { return { data, documentId }; }
  };
  return database;
}

test("OAuth state is cryptographically random, URL-safe, and only its hash is a document key", () => {
  const one = generateOAuthState();
  const two = generateOAuthState();
  assert.match(one, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one, two);
  assert.equal(hashOAuthState(one), require("node:crypto").createHash("sha256").update(one).digest("hex"));
  assert.notEqual(hashOAuthState(one), one);
  assert.throws(() => hashOAuthState("bad state"), { code: "invalid-argument" });
});

test("OAuth state is consumed transactionally once and rejects replay and expiration", async () => {
  const raw = generateOAuthState();
  const now = 1_800_000_000_000;
  const database = stateDatabase({ adminUid: "admin-1", redirectUri: "https://callback.example/", expiresAt: new Date(now + 1_000), consumedAt: null });
  const result = await consumeOAuthState(database, raw, now);
  assert.deepEqual(result, { adminUid: "admin-1", redirectUri: "https://callback.example/" });
  assert.equal(database.inspect().documentId, hashOAuthState(raw));
  assert.equal(database.inspect().data.consumedAt.getTime(), now);
  await assert.rejects(consumeOAuthState(database, raw, now), { code: "failed-precondition" });

  const expired = stateDatabase({ adminUid: "admin-1", redirectUri: "https://callback.example/", expiresAt: new Date(now), consumedAt: null });
  await assert.rejects(consumeOAuthState(expired, generateOAuthState(), now), { code: "failed-precondition" });
  assert.throws(() => assertOAuthStateRecord(null, now), { code: "failed-precondition" });
});

test("OAuth URL requests offline compose access and exact callback URI", () => {
  const authorization = new URL(buildGmailAuthorizationUrl({
    clientId: "client-id.apps.googleusercontent.com", redirectUri: "https://callback.example/callback", state: generateOAuthState()
  }));
  assert.equal(authorization.origin, "https://accounts.google.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://callback.example/callback");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("response_mode"), "form_post");
  assert.match(authorization.searchParams.get("scope"), /https:\/\/www\.googleapis\.com\/auth\/gmail\.compose/);
  assert.match(authorization.searchParams.get("scope"), /openid email/);
});

test("Google identity must match audience, verified status, and exact mailbox", () => {
  const identity = { aud: "client-id", email: "mentoraedge@gmail.com", email_verified: true, sub: "google-subject" };
  assert.deepEqual(assertGoogleMailbox(identity, "client-id"), { email: "mentoraedge@gmail.com", subject: "google-subject" });
  for (const override of [
    { aud: "other-client" }, { email: "someone@gmail.com" }, { email: "MentoraEdge@gmail.com" },
    { email_verified: false }, { sub: "" }
  ]) assert.throws(() => assertGoogleMailbox({ ...identity, ...override }, "client-id"), { code: "permission-denied" });
});

test("draft request claim returns created results and rejects concurrent, ambiguous, mismatched, or foreign claims", () => {
  const base = { createdBy: "admin-1", payloadHash: "hash", status: "draft_created", gmailDraftId: "draft-id" };
  assert.equal(claimDraftDisposition(null, "admin-1", "hash"), "new");
  assert.equal(claimDraftDisposition(base, "admin-1", "hash"), "already-created");
  assert.equal(claimDraftDisposition({ ...base, status: "creating" }, "admin-1", "hash"), "in-progress");
  assert.equal(claimDraftDisposition({ ...base, status: "unknown" }, "admin-1", "hash"), "uncertain");
  assert.equal(claimDraftDisposition({ ...base, status: "failed", retryable: true }, "admin-1", "hash"), "retry");
  assert.throws(() => claimDraftDisposition(base, "admin-2", "hash"), { code: "permission-denied" });
  assert.throws(() => claimDraftDisposition(base, "admin-1", "other-hash"), { code: "failed-precondition" });
  assert.throws(() => claimDraftDisposition({ ...base, status: "failed", retryable: false }, "admin-1", "hash"), { code: "failed-precondition" });
});

test("overlapping Gmail draft requests serialize to one claim and one provider attempt", async () => {
  let state = null;
  let providerAttempts = 0;
  async function attempt() {
    const disposition = claimDraftDisposition(state, "admin-1", "payload-hash");
    if (disposition !== "new" && disposition !== "retry") return "blocked";
    state = { createdBy: "admin-1", payloadHash: "payload-hash", status: "creating", retryable: false };
    providerAttempts++;
    return "claimed";
  }
  const results = await Promise.all([attempt(), attempt()]);
  assert.deepEqual(results.sort(), ["blocked", "claimed"]);
  assert.equal(providerAttempts, 1);
});

test("draft failures distinguish pre-request and definite rejection from ambiguous create outcomes", () => {
  assert.deepEqual(classifyDraftFailure(new Error("credential unavailable"), false), { ambiguous: false, retryable: true });
  assert.deepEqual(classifyDraftFailure(Object.assign(new Error("bad request"), { code: "GMAIL_DRAFT_400" }), true), { ambiguous: false, retryable: true });
  assert.deepEqual(classifyDraftFailure(Object.assign(new Error("network"), { code: "ECONNRESET" }), true), { ambiguous: true, retryable: false });
  assert.deepEqual(classifyDraftFailure(Object.assign(new Error("server error"), { code: "GMAIL_DRAFT_503", ambiguous: true }), true), { ambiguous: true, retryable: false });
});

test("a salary record claimed for Gmail drafting cannot be mutated under the same request ID", () => {
  assert.equal(assertDraftPayloadCompatible({ gmailDraftPayloadHash: "same" }, "same").gmailDraftPayloadHash, "same");
  assert.throws(() => assertDraftPayloadCompatible({ gmailDraftPayloadHash: "original" }, "changed"), { code: "failed-precondition" });
});

test("canonical PDF is attached to a MIME draft with a stable reconciliation marker", () => {
  const pdf = Buffer.from("%PDF-1.7\ncanonical test payslip");
  const raw = buildSalarySlipMime({
    recipient: "employee@example.com", employeeName: "Employee Name", payPeriod: "05/04/2027",
    referenceNumber: "ME-PAY-2027-04-001", requestId: "550e8400-e29b-41d4-a716-446655440000",
    filename: "Mentora_Slip.pdf", pdf
  });
  const message = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(message, /To: employee@example\.com/);
  assert.match(message, /X-Mentora-Request-ID: 550e8400-e29b-41d4-a716-446655440000/);
  assert.match(message, /Message-ID: <550e8400-e29b-41d4-a716-446655440000@drafts\.mentoraedge\.online>/);
  assert.match(message, /Content-Type: application\/pdf/);
  assert.match(message, /Content-Disposition: attachment; filename="Mentora_Slip\.pdf"/);
  assert.ok(message.includes(pdf.toString("base64")));
  assert.throws(() => buildSalarySlipMime({ recipient: "x@example.com\r\nBcc:a@example.com", pdf }));
});

test("only the Gmail drafts.create endpoint is used and repeated result links to Drafts", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: "draft-id" }) };
  };
  assert.equal(await createGmailDraftMessage("access-token", "encoded-mime", fakeFetch), "draft-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: { raw: "encoded-mime" } });
  assert.equal(gmailDraftUrl(), "https://mail.google.com/mail/u/0/#drafts");

  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.doesNotMatch(source, /users\/messages\/send|users\/drafts\/send|gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages:send/);
  assert.match(source, /getFirestore\("mentora-oauth-state"\)/);
  assert.match(source, /const db = getFirestore\(\);/);
  assert.match(source, /serviceAccount: "mentora-oauth-callback@mentora-edge-v2\.iam\.gserviceaccount\.com"/);
  assert.match(source, /invoker: "public"/);
  for (const functionName of ["beginGmailDraftOAuth", "createSalarySlipDraft"]) {
    const declaration = source.slice(source.indexOf(`exports.${functionName} =`));
    assert.match(declaration, /await requireAdmin\(request\)/, `${functionName} keeps the admin check`);
  }
  assert.match(source, /provider: "gmail"/);
});

test("Secret Manager read/add calls use mocked transport and never print secret material", async () => {
  const calls = [];
  const auth = { async getClient() { return { async getRequestHeaders(url) { return new Headers({ Authorization: `Bearer for:${new URL(url).hostname}` }); } }; } };
  const client = createSecretManagerClient(auth, async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") return { ok: true, json: async () => ({ payload: { data: Buffer.from("mock-secret").toString("base64") } }) };
    return { ok: true, json: async () => ({ name: "secret-version" }) };
  });
  assert.equal(await client.read("gmail-oauth-client-secret"), "mock-secret");
  await client.addVersion("gmail-oauth-refresh-token", "mock-refresh-token");
  assert.equal(calls[0].url, "https://secretmanager.googleapis.com/v1/projects/mentora-edge-v2/secrets/gmail-oauth-client-secret/versions/latest:access");
  assert.equal(calls[1].url, "https://secretmanager.googleapis.com/v1/projects/mentora-edge-v2/secrets/gmail-oauth-refresh-token:addVersion");
  assert.equal(JSON.parse(calls[1].options.body).payload.data, Buffer.from("mock-refresh-token").toString("base64"));
  await assert.rejects(client.read("invalid secret id"));
});
