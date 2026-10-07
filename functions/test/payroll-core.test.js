const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReference, assertRequestId, formatReference, isAdminProfile, nextReferenceSequence,
  normalizeHistoryLimit, normalizeSalary, requireAdminIdentity, sendDisposition,
  smtpTransportSecurity, validateHistoryRequest, validateSalaryOperation
} = require("../payroll-core");

const validSalary = (overrides = {}) => ({
  payPeriod: "05/04/2027", employeeId: "ME-001", employeeName: "Ranita Munshi",
  position: "Educator", employeeEmail: "employee@example.com", basicPay: 25000,
  allowance: 2000, allowanceDisplay: 2000, overtimePay: 0, overtimeDisplay: "NA",
  bonus: 0, bonusDisplay: "NA", totalEarnings: 27000, accountNumber: "123456789012",
  ...overrides
});

test("callable authorization rejects unauthenticated and non-admin users and accepts admin", () => {
  assert.throws(() => requireAdminIdentity(null, null), { code: "unauthenticated" });
  for (const role of ["student", "educator", "parent"]) {
    assert.throws(() => requireAdminIdentity({ uid: "u1" }, { role }), { code: "permission-denied" });
  }
  assert.equal(requireAdminIdentity({ uid: "a1" }, { role: "admin" }), "a1");
  assert.equal(isAdminProfile(null, { role: "admin" }), false);
});

test("normalizes salary, calculates total server-side, and stores account last four only", () => {
  const { salary } = normalizeSalary(validSalary());
  assert.equal(salary.payPeriod, "05/04/2027");
  assert.equal(salary.totalEarnings, 27000);
  assert.equal(salary.accountLast4, "9012");
  assert.equal("accountNumber" in salary, false);
  assert.equal(salary.overtimeDisplay, "NA");
});

test("rejects malformed email including comments accepted by the old loose check", () => {
  for (const employeeEmail of ["bad", "x@host", "x@trusted.example(comment)evil.test", "x@@example.com", "x@example..com"]) {
    assert.throws(() => normalizeSalary(validSalary({ employeeEmail })));
  }
});

test("rejects extra callable fields including a browser-supplied PDF", () => {
  const payload = { requestId: "550e8400-e29b-41d4-a716-446655440000", salary: validSalary() };
  assert.equal(validateSalaryOperation(payload), payload);
  assert.throws(() => validateSalaryOperation({ ...payload, pdfBase64: "browser-pdf" }), { code: "invalid-argument" });
  assert.throws(() => normalizeSalary(validSalary({ pdfBase64: "browser-pdf" })), { code: "invalid-argument" });
  assert.throws(() => validateHistoryRequest({ limit: 10, includeEmail: true }), { code: "invalid-argument" });
  assert.equal(normalizeHistoryLimit(100), 100);
  for (const limit of ["20", 0, 101, 1.5, null]) assert.throws(() => normalizeHistoryLimit(limit), { code: "invalid-argument" });
});

test("rejects invalid dates, format changes, and control characters", () => {
  for (const payPeriod of ["31/02/2027", "2027-04", "05/04/27", "05/04/2027\nBcc:bad@example.com"]) {
    assert.throws(() => normalizeSalary(validSalary({ payPeriod })));
  }
  assert.throws(() => normalizeSalary(validSalary({ employeeName: "Ranita\nBcc:bad@example.com" })));
  assert.throws(() => normalizeSalary(validSalary({ position: "Educator\u200b" })));
});

test("rejects invalid IDs and reference formats", () => {
  assert.throws(() => normalizeSalary(validSalary({ employeeId: "ME 001" })));
  assert.throws(() => assertReference("ME-PAY-2027-04-000"));
  assert.throws(() => assertReference("ME-PAY-2027-04-1000"));
  assert.equal(formatReference(2027, 4, 1), "ME-PAY-2027-04-001");
});

test("rejects negative, over-limit, over-precision, mismatched display, and tampered total amounts", () => {
  for (const overrides of [
    { basicPay: -1 }, { basicPay: 10000001 }, { basicPay: 1.001 },
    { allowance: 100, allowanceDisplay: "NA", totalEarnings: 27100 },
    { totalEarnings: 1 }
  ]) assert.throws(() => normalizeSalary(validSalary(overrides)));
});

test("validates optional account number and rejects whitespace/control data", () => {
  assert.throws(() => normalizeSalary(validSalary({ accountNumber: "12 3456" })));
  assert.throws(() => normalizeSalary(validSalary({ accountNumber: "123456\n" })));
  const { salary } = normalizeSalary(validSalary({ accountNumber: "" }));
  assert.equal(salary.accountLast4, "");
});

test("accepts only canonical UUID v4 request IDs", () => {
  assert.equal(assertRequestId("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  assert.throws(() => assertRequestId("ME-PAY-2027-04-001"));
});

test("reference allocation skips duplicate references and cannot allocate an existing request twice", () => {
  const occupied = new Set([1, 2, 4]);
  const first = nextReferenceSequence(0, occupied);
  assert.equal(first, 3);
  occupied.add(first);
  assert.equal(nextReferenceSequence(0, occupied), 5);
  assert.equal(nextReferenceSequence(999, new Set()), null);
  assert.equal(formatReference(2027, 4, first), "ME-PAY-2027-04-003");
});

test("send state is idempotent for repeated and ambiguous requests and permits only explicit retries", () => {
  const hash = "payload-hash";
  for (const status of ["sent", "sending", "unknown"]) {
    assert.equal(sendDisposition({ createdBy: "a1", payloadHash: hash, status }, "a1", hash), "already-handled");
  }
  assert.equal(sendDisposition({ createdBy: "a1", payloadHash: hash, status: "draft" }, "a1", hash), "send");
  assert.equal(sendDisposition({ createdBy: "a1", payloadHash: hash, status: "failed", retryable: true }, "a1", hash), "send");
  assert.throws(() => sendDisposition({ createdBy: "a1", payloadHash: hash, status: "failed", retryable: false }, "a1", hash), { code: "failed-precondition" });
  assert.throws(() => sendDisposition({ createdBy: "a1", payloadHash: "other", status: "draft" }, "a1", hash), { code: "failed-precondition" });
  assert.throws(() => sendDisposition({ createdBy: "other", payloadHash: hash, status: "draft" }, "a1", hash), { code: "permission-denied" });
});

test("SMTP transport requires TLS and certificate verification on both supported ports", () => {
  assert.deepEqual(smtpTransportSecurity(465), { secure: true, requireTLS: false, tls: { rejectUnauthorized: true } });
  assert.deepEqual(smtpTransportSecurity(587), { secure: false, requireTLS: true, tls: { rejectUnauthorized: true } });
  assert.throws(() => smtpTransportSecurity(25), { code: "invalid-argument" });
});
