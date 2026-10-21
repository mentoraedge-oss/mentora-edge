import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { academicSession, annualPeriod, canInitiateFeePayment, feePeriodStatus, monthlyPeriods, quarterlyPeriods, registrationPaymentLabel } from "../../js/fee-management.mjs";

const date = value => new Date(`${value}T12:00:00`);

test("academic pricing keeps the approved IX-X and XI-XII fee plans", async () => {
  const source = await readFile(new URL("../../js/academic-programs.js", import.meta.url), "utf8");
  const pricing = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const combo = pricing.ACADEMIC_PROGRAMS.secondary.combo;
  assert.equal(combo.monthly, 2200);
  assert.deepEqual(combo.quarterlyInstallments, [5000, 5000, 5000, 5000]);
  assert.equal(combo.quarterlyInstallments.reduce((sum, value) => sum + value, 0), 20000);
  assert.equal(combo.annualValue, 26400);
  assert.equal(combo.annualDiscount, 6400);
  assert.equal(combo.annualTotal, 20000);
  assert.deepEqual(pricing.getPaymentFrequencies("XI", "English"), ["annual"]);
  assert.equal(pricing.getPlanDetails("XII", "English", "annual").total, 5000);
});

test("academic sessions use April through March", () => {
  assert.equal(academicSession(date("2026-04-01")).key, "2026-2027");
  assert.equal(academicSession(date("2027-03-31")).key, "2026-2027");
  assert.equal(academicSession(date("2027-04-01")).key, "2027-2028");
});

test("quarterly late joining excludes only quarters ended before enrolment", () => {
  const quarters = enrolledAt => quarterlyPeriods({
    date: date("2026-08-15"),
    enrolledAt: date(enrolledAt),
    installments: [5000, 5000, 5000, 5000]
  });
  assert.deepEqual(quarters("2026-04-03").map(p => p.applicable), [true, true, true, true]);
  assert.deepEqual(quarters("2026-08-03").map(p => p.applicable), [false, true, true, true]);
  assert.deepEqual(quarters("2026-10-03").map(p => p.applicable), [false, false, true, true]);
  assert.deepEqual(quarters("2027-01-03").map(p => p.applicable), [false, false, false, true]);
  assert.equal(quarters("2026-04-03").filter(p => p.applicable).reduce((sum, p) => sum + p.amount, 0), 20000);
  assert.deepEqual(quarters("2026-08-03").filter(p => p.applicable).map(p => p.amount), [5000, 5000, 5000]);
  assert.equal(quarters("2026-08-03").filter(p => p.applicable).reduce((sum, p) => sum + p.amount, 0), 15000);
  assert.equal(quarters("2026-10-03").filter(p => p.applicable).reduce((sum, p) => sum + p.amount, 0), 10000);
  assert.equal(quarters("2027-01-03").filter(p => p.applicable).reduce((sum, p) => sum + p.amount, 0), 5000);
});

test("stored quarter amounts and statuses override the standard schedule", () => {
  const items = quarterlyPeriods({
    date: date("2026-08-15"),
    enrolledAt: date("2026-04-01"),
    installments: [5000, 5000, 5000, 5000],
    fees: { "2026-2027": { Q2: { amount: 5250, status: "pending_verification" }, Q3: { amount: 5000, paid: true } } }
  });
  assert.equal(items[1].amount, 5250);
  assert.equal(items[1].status, "Pending Verification");
  assert.equal(items[2].status, "Paid");
});

test("monthly view makes remaining months in the current year payable after enrollment", () => {
  const months = monthlyPeriods({ year: 2026, enrolledAt: date("2026-08-03"), asOf: date("2026-10-21"), defaultAmount: 500, fees: { 2026: {
    August: { amount: 500, status: "pending_verification" },
    July: { amount: 500, paid: true },
    September: { amount: 500, paid: true },
    November: { amount: 500, status: "not_applicable" },
    December: { amount: 500, status: "not_applicable" }
  } } });
  assert.equal(months.length, 12);
  assert.equal(months[0].status, "Not Applicable");
  assert.equal(months[0].status, "Not Applicable");
  assert.equal(months[6].status, "Not Applicable");
  assert.equal(canInitiateFeePayment(months[0], null), false);
  assert.equal(months[7].status, "Pending Verification");
  assert.equal(months[7].amount, 500);
  assert.equal(months[7].periodKey, "2026-August");
  for (const monthName of ["November", "December"]) {
    const month = months.find(period => period.label === monthName);
    assert.equal(month.applicable, true);
    assert.equal(month.status, "Not Paid");
    assert.equal(month.amount, 500);
    assert.equal(canInitiateFeePayment(month, null), true);
  }
  assert.equal(months.find(period => period.label === "November").status, feePeriodStatus(months.find(period => period.label === "November"), null));
  assert.equal(canInitiateFeePayment(months.find(period => period.label === "November"), { status: "pending_verification" }), false);
  assert.equal(feePeriodStatus(months.find(period => period.label === "November"), { status: "cancelled" }), "Not Paid");
  assert.equal(canInitiateFeePayment(months.find(period => period.label === "November"), { status: "cancelled" }), true);
  assert.equal(months[8].status, "Paid");
  assert.equal(canInitiateFeePayment(months[8], null), false);
  assert.equal(monthlyPeriods({ year: 2027, enrolledAt: date("2026-08-03"), asOf: date("2026-10-21"), defaultAmount: 500 })[10].status, "Not Applicable");
});

test("annual status stays pending until an explicit verification record exists", () => {
  const profile = { paymentFrequency: "annual", planTotal: 20000, registrationPaymentStatus: "pending_verification" };
  assert.equal(annualPeriod({ profile, date: date("2026-06-01") }).status, "Pending Verification");
  assert.equal(registrationPaymentLabel(profile), "Registration payment pending verification");
  assert.equal(annualPeriod({ profile, date: date("2026-06-01"), fees: { "2026-2027": { annual: { amount: 20000, paid: true } } } }).status, "Paid");
});

test("fee actions match the period and payment-request status", () => {
  const unpaid = { applicable: true, amount: 500, status: "Not Paid" };
  assert.equal(canInitiateFeePayment(unpaid, null), true);
  assert.equal(feePeriodStatus(unpaid, { status: "pending_verification" }), "Pending Verification");
  assert.equal(canInitiateFeePayment(unpaid, { status: "pending_verification" }), false);
  assert.equal(feePeriodStatus({ ...unpaid, status: "Pending Verification" }, null, true), "Not Paid");
  assert.equal(feePeriodStatus({ ...unpaid, status: "Pending Verification" }, null, false), "Pending Verification");
  assert.equal(canInitiateFeePayment({ ...unpaid, requestStatusAvailable: false }, null), false);
  for (const status of ["cancelled", "canceled", "failed", "rejected", "expired"]) {
    assert.equal(feePeriodStatus({ ...unpaid, status: "Pending Verification" }, { status }), "Not Paid");
    assert.equal(canInitiateFeePayment({ ...unpaid, status: "Pending Verification" }, { status }), true);
  }
  assert.equal(canInitiateFeePayment({ ...unpaid, status: "Paid" }, null), false);
  assert.equal(canInitiateFeePayment({ ...unpaid, applicable: false, status: "Not Applicable" }, null), false);
  assert.equal(canInitiateFeePayment({ ...unpaid, amount: 0 }, null), false);
});

test("registration status labels preserve verification, failure, cancellation, and unpaid states", () => {
  assert.equal(registrationPaymentLabel({ registrationPaymentStatus: "verified" }), "Registration payment verified");
  assert.equal(registrationPaymentLabel({ registrationPaymentStatus: "pending_verification" }), "Registration payment pending verification");
  assert.equal(registrationPaymentLabel({ registrationPaymentStatus: "cancelled" }), "Registration payment cancelled");
  assert.equal(registrationPaymentLabel({ registrationPaymentStatus: "failed" }), "Registration payment failed");
  assert.equal(registrationPaymentLabel({ registrationPaymentStatus: "not_paid" }), "Registration payment not paid");
  assert.equal(annualPeriod({ profile: { paymentFrequency: "annual", planTotal: 20000, registrationPaymentStatus: "failed", paymentDueAtRegistration: 500 }, date: date("2026-06-01") }).status, "Not Paid");
});
