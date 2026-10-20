const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { claimDraftDisposition, assertDraftPayloadCompatible, classifyDraftFailure } = require("../gmail-draft-core");
const { claimSalarySlipDraft, invokePrivateGmailDraftWorker } = require("../gmail-draft-orchestrator");

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYLOAD_HASH = "a".repeat(64);
const WORKER_URL = "https://asia-south1-mentora-edge-v2.cloudfunctions.net/gmailDraftWorker";

function database(initialSalary) {
  const documents = new Map([[`salarySlips/${REQUEST_ID}`, initialSalary]]);
  let tail = Promise.resolve();
  function ref(collection, id) { return { key: `${collection}/${id}` }; }
  return {
    collection(name) { return { doc(id) { return ref(name, id); } }; },
    async runTransaction(callback) {
      let release;
      const prior = tail;
      tail = new Promise((resolve) => { release = resolve; });
      await prior;
      try {
        const writes = [];
        const transaction = {
          async get(document) {
            const value = documents.get(document.key);
            return { exists: value !== undefined, data: () => value };
          },
          create(document, value) { writes.push(["create", document.key, value]); },
          set(document, value, options) { writes.push(["set", document.key, value, options]); },
          update(document, value) { writes.push(["update", document.key, value]); }
        };
        const result = await callback(transaction);
        for (const [kind, key, value] of writes) {
          if (kind === "create" && documents.has(key)) throw new Error("already exists");
          documents.set(key, kind === "set" ? { ...(documents.get(key) || {}), ...value } : { ...(documents.get(key) || {}), ...value });
        }
        return result;
      } finally { release(); }
    },
    inspect(key) { return documents.get(key); }
  };
}

const salary = () => ({
  createdBy: "admin-1", payloadHash: PAYLOAD_HASH, referenceNumber: "ME-PAY-2027-04-001", status: "draft",
  employeeEmail: "employee@example.com", employeeName: "Employee Name", payPeriod: "05/04/2027"
});
const fieldValue = { serverTimestamp: () => "server-time" };

test("valid orchestrator service-to-service invocation uses the exact worker URL as token audience", async () => {
  let audience;
  let requestOptions;
  const result = await invokePrivateGmailDraftWorker({
    workerUrl: WORKER_URL,
    googleAuth: { async getIdTokenClient(value) { audience = value; return { async getRequestHeaders() { return new Headers({ Authorization: "Bearer mock-oidc-token" }); } }; } },
    payload: { requestId: REQUEST_ID, recipient: "employee@example.com", pdfBase64: Buffer.from("%PDF-").toString("base64") },
    fetchImpl: async (_url, options) => { requestOptions = options; return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ draftId: "draft-123" }) }; }
  });
  assert.equal(audience, WORKER_URL);
  assert.equal(requestOptions.headers.get("authorization"), "Bearer mock-oidc-token");
  assert.equal(result.draftId, "draft-123");
});

test("concurrent orchestrator claims create only one worker-eligible claim", async () => {
  const db = database(salary());
  const args = { db, FieldValue: fieldValue, adminUid: "admin-1", requestId: REQUEST_ID, payloadHash: PAYLOAD_HASH, claimDraftDisposition, assertDraftPayloadCompatible };
  const results = await Promise.allSettled([claimSalarySlipDraft(args), claimSalarySlipDraft(args)]);
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.created).length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "failed-precondition").length, 1);
  assert.equal(db.inspect(`salarySlipDraftRequests/${REQUEST_ID}`).status, "creating");
});

test("completed duplicate orchestration returns the existing draft and does not claim a new worker call", async () => {
  const db = database(salary());
  await db.runTransaction((tx) => tx.create({ key: `salarySlipDraftRequests/${REQUEST_ID}` }, {
    provider: "gmail", requestId: REQUEST_ID, createdBy: "admin-1", payloadHash: PAYLOAD_HASH,
    referenceNumber: "ME-PAY-2027-04-001", status: "draft_created", gmailDraftId: "existing-draft"
  }));
  const result = await claimSalarySlipDraft({
    db, FieldValue: fieldValue, adminUid: "admin-1", requestId: REQUEST_ID, payloadHash: PAYLOAD_HASH,
    claimDraftDisposition, assertDraftPayloadCompatible
  });
  assert.equal(result.created, false);
  assert.equal(result.record.gmailDraftId, "existing-draft");
});

test("worker timeouts and ambiguous responses remain uncertain and non-retryable", async () => {
  let dispatched = false;
  await assert.rejects(invokePrivateGmailDraftWorker({
    workerUrl: WORKER_URL,
    googleAuth: { async getIdTokenClient() { return { async getRequestHeaders() { return new Headers({ Authorization: "Bearer mock" }); } }; } },
    payload: {}, onDispatched() { dispatched = true; }, fetchImpl: async () => { throw new Error("timeout"); }
  }), (error) => {
    assert.equal(error.ambiguous, true);
    assert.deepEqual(classifyDraftFailure(error, dispatched), { ambiguous: true, retryable: false });
    return true;
  });
  dispatched = false;
  await assert.rejects(invokePrivateGmailDraftWorker({
    workerUrl: WORKER_URL,
    googleAuth: { async getIdTokenClient() { return { async getRequestHeaders() { return new Headers({ Authorization: "Bearer mock" }); } }; } },
    payload: {}, onDispatched() { dispatched = true; },
    fetchImpl: async () => ({ ok: false, status: 502, headers: new Headers(), text: async () => JSON.stringify({ code: "GMAIL_DRAFT_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false }) })
  }), (error) => {
    assert.deepEqual(classifyDraftFailure(error, dispatched), { ambiguous: true, retryable: false });
    return true;
  });
});

test("SMTP send implementation remains present and untouched by worker orchestration", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const sendStart = source.indexOf("exports.sendSalarySlip =");
  const listStart = source.indexOf("exports.listSalarySlips =", sendStart);
  const smtpBlock = source.slice(sendStart, listStart);
  assert.match(source, /nodemailer\.createTransport/);
  assert.match(smtpBlock, /await transporter\.sendMail/);
  assert.match(smtpBlock, /status: "sent"/);
  assert.match(source, /serviceAccount: GMAIL_DRAFT_ORCHESTRATOR_SERVICE_ACCOUNT/);
});
