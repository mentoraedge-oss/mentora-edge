import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { academicSession, annualPeriod, assertFeePaymentRequestCanBeSubmitted, buildFeePaymentRequest, canInitiateFeePayment, classifyFeeProfile, feePeriodStatus, feePeriodsForProfile, markFeePeriodPaid, markFeePeriodUnpaid, monthlyPeriods, quarterlyPeriods, registrationPaymentLabel } from "../../js/fee-management.mjs";

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

test("annual fee status remains separate from registration payment verification", () => {
  const profile = { paymentFrequency: "annual", planTotal: 20000, registrationPaymentStatus: "pending_verification" };
  assert.equal(annualPeriod({ profile, date: date("2026-06-01") }).status, "Not Paid");
  assert.equal(registrationPaymentLabel(profile), "Registration payment pending verification");
  assert.equal(annualPeriod({ profile, date: date("2026-06-01"), fees: { "2026-2027": { annual: { amount: 20000, paid: true } } } }).status, "Paid");
});

test("legacy monthly records are identified without inventing registration payments", () => {
  const profile = {
    createdAt: date("2025-01-12"),
    fees: { 2025: { January: { paid: true, paidOn: "2025-01-10" }, February: { paid: false } } }
  };
  assert.deepEqual(classifyFeeProfile(profile), { kind: "legacy_monthly", frequency: "monthly", diagnostic: null });
  const periods = feePeriodsForProfile(profile, { date: date("2025-03-15") });
  assert.equal(periods.find(period => period.periodKey === "2025-January").status, "Paid");
  assert.equal(periods.find(period => period.periodKey === "2025-February").status, "Not Paid");
  assert.equal(periods.find(period => period.periodKey === "2025-January").paidOn, "2025-01-10");
  assert.equal(periods.every(period => period.paymentEnabled === false), true);
  assert.equal(registrationPaymentLabel(profile), "Registration payment not recorded");
});

test("pre-plan registration date keeps an existing student on legacy monthly handling despite stray plan fields", () => {
  const profile = {
    createdAt: date("2025-08-01"),
    paymentFrequency: "quarterly",
    planTotal: 20000,
    paymentDueAtRegistration: 5000,
    registrationPaymentStatus: "pending_verification",
    fees: { 2025: { August: { paid: true, paidOn: "2025-08-01" } } }
  };
  assert.equal(classifyFeeProfile(profile).kind, "legacy_monthly");
  assert.equal(feePeriodsForProfile(profile, { date: date("2025-09-01") }).every(period => period.paymentEnabled === false), true);
  assert.equal(profile.paymentFrequency, "quarterly");
});

test("legacy admin paid and unpaid updates preserve historical fee data and paidOn", () => {
  const profile = {
    createdAt: date("2025-01-12"),
    fees: { 2025: { January: { paid: false, amount: 500, note: "keep" }, February: { paid: true, paidOn: "2025-02-05" } } }
  };
  const paidFees = markFeePeriodPaid(profile, { periodKey: "2025-January", amount: 500 }, "server-time");
  assert.equal(paidFees[2025].January.paid, true);
  assert.equal(paidFees[2025].January.note, "keep");
  assert.equal(paidFees[2025].February.paidOn, "2025-02-05");
  const unpaidFees = markFeePeriodUnpaid({ ...profile, fees: paidFees }, { periodKey: "2025-January" });
  assert.equal(unpaidFees[2025].January.paid, false);
  assert.equal(unpaidFees[2025].January.paidOn, "server-time");
  assert.equal(unpaidFees[2025].February.paidOn, "2025-02-05");
  assert.throws(() => markFeePeriodUnpaid({ paymentFrequency: "monthly" }, { periodKey: "2025-January" }), /legacy monthly/);
});

test("student monthly status reads the same legacy map after an admin update", () => {
  const profile = { fees: { 2025: { March: { paid: false } } } };
  const fees = markFeePeriodPaid(profile, { periodKey: "2025-March" }, "verified-once");
  const dashboardPeriods = feePeriodsForProfile({ ...profile, fees }, { date: date("2025-03-15") });
  assert.equal(dashboardPeriods.find(period => period.periodKey === "2025-March").status, "Paid");
  assert.equal(dashboardPeriods.find(period => period.periodKey === "2025-March").paidOn, "verified-once");
  assert.equal(classifyFeeProfile({ ...profile, fees }).kind, "legacy_monthly");
});

test("saved monthly, quarterly, and annual plan generations use their stored frequency", () => {
  const monthly = { createdAt: date("2026-10-22"), paymentFrequency: "monthly", planTotal: 500, feeAmount: 500 };
  const quarterly = { createdAt: date("2026-10-22"), paymentFrequency: "quarterly", planTotal: 20000 };
  const annual = { createdAt: date("2026-10-22"), paymentFrequency: "annual", planTotal: 20000 };
  assert.deepEqual([monthly, quarterly, annual].map(item => classifyFeeProfile(item).frequency), ["monthly", "quarterly", "annual"]);
  assert.equal(feePeriodsForProfile(monthly, { date: date("2026-10-23"), programs: { secondary: { subjects: { English: 500 }, combo: { monthly: 2200 } } } }).length, 12);
  assert.equal(feePeriodsForProfile(quarterly, { date: date("2026-10-23"), programs: { secondary: { combo: { quarterlyInstallments: [5000, 5000, 5000, 5000] } } } }).length, 4);
  assert.equal(feePeriodsForProfile(annual, { date: date("2026-10-23") }).length, 1);
  assert.equal(annualPeriod({ profile: { ...annual, registrationPaymentStatus: "verified" }, date: date("2026-10-23") }).status, "Not Paid");
});

test("legacy and all new frequencies expose matching periods, amounts, QR request data, and verified status", () => {
  const asOf = date("2026-11-19");
  const programs = { secondary: { subjects: { English: 500 }, combo: { monthly: 2200, quarterlyInstallments: [5000, 5000, 5000, 5000] } } };
  const profiles = [
    { createdAt: date("2025-01-12"), fees: { 2025: { January: { paid: true, paidOn: "2025-01-10" } } } },
    { createdAt: date("2026-10-22"), class: "IX", subject: "English", programType: "individual-subject", paymentFrequency: "monthly", feeAmount: 500, planTotal: 500 },
    { createdAt: date("2026-10-22"), class: "IX", subject: "English, Social Science, Science, Maths", programType: "all-subject-combo", paymentFrequency: "quarterly", planTotal: 20000, paymentInstallments: [5000, 5000, 5000, 5000], fees: { "2026-2027": { Q1: { status: "not_applicable", amount: 5000 }, Q2: { status: "not_applicable", amount: 5000 } } } },
    { createdAt: date("2026-10-22"), class: "IX", subject: "English, Social Science, Science, Maths", programType: "all-subject-combo", paymentFrequency: "annual", planTotal: 20000 }
  ];
  const [legacy, monthly, quarterly, annual] = profiles;
  const legacyPeriods = feePeriodsForProfile(legacy, { date: asOf, programs });
  assert.equal(classifyFeeProfile(legacy).kind, "legacy_monthly");
  assert.equal(legacyPeriods.find(period => period.periodKey === "2025-January").status, "Paid");
  assert.equal(legacyPeriods.some(period => period.paymentEnabled !== false), false);

  const cases = [
    { profile: monthly, expectedFrequency: "monthly", expectedAmount: 500, period: p => p.find(item => item.periodKey === "2026-November"), expectedCount: 12 },
    { profile: quarterly, expectedFrequency: "quarterly", expectedAmount: 5000, period: p => p.find(item => item.periodKey === "2026-2027.Q3"), expectedCount: 4 },
    { profile: annual, expectedFrequency: "annual", expectedAmount: 20000, period: p => p[0], expectedCount: 1 }
  ];
  for (const item of cases) {
    const adminPeriods = feePeriodsForProfile(item.profile, { date: asOf, programs });
    const studentPeriods = feePeriodsForProfile(item.profile, { date: asOf, programs });
    assert.equal(adminPeriods.length, item.expectedCount);
    assert.deepEqual(studentPeriods, adminPeriods);
    if (item.expectedFrequency === "quarterly") {
      assert.deepEqual(adminPeriods.map(candidate => candidate.status), ["Not Applicable", "Not Applicable", "Not Paid", "Not Paid"]);
      const q4 = adminPeriods.find(candidate => candidate.periodKey === "2026-2027.Q4");
      const q4Request = buildFeePaymentRequest(item.profile, q4, "ME-test-q4", "server-created-at", "student-uid");
      assert.equal(q4Request.periodId, "2026-2027-Q4");
      assert.equal(q4Request.amount, 5000);
    }
    const period = item.period(adminPeriods);
    assert.equal(period.amount, item.expectedAmount);
    assert.equal(canInitiateFeePayment(period, null), true);
    assert.equal(feePeriodStatus(period, { status: "pending_verification" }), "Pending Verification");
    const request = buildFeePaymentRequest(item.profile, period, "ME-test-reference", "server-created-at", "student-uid");
    assert.equal(request.studentUid, "student-uid");
    assert.equal(request.periodId, period.id);
    assert.equal(request.periodKey, period.periodKey);
    assert.equal(request.academicSession, "2026-2027");
    assert.equal(request.amount, item.expectedAmount);
    assert.equal(request.paymentFrequency, item.expectedFrequency);
    assert.equal(request.status, "pending_verification");
    assert.equal(Object.hasOwn(request, "paid"), false);
    const fees = markFeePeriodPaid(item.profile, period, "verified-at");
    const verifiedPeriods = feePeriodsForProfile({ ...item.profile, fees }, { date: asOf, programs });
    assert.equal(item.period(verifiedPeriods).status, "Paid");
    assert.equal(item.period(verifiedPeriods).paidOn, "verified-at");
    assert.equal(canInitiateFeePayment(item.period(verifiedPeriods), null), false);
    if (item.expectedFrequency === "quarterly") {
      assert.deepEqual([fees["2026-2027"].Q1.status, fees["2026-2027"].Q2.status], ["not_applicable", "not_applicable"]);
      assert.equal(verifiedPeriods.find(candidate => candidate.periodKey === "2026-2027.Q4").status, "Not Paid");
    }
  }
  assert.throws(() => buildFeePaymentRequest(legacy, legacyPeriods[0], "legacy", "now", "legacy-uid"), /supported saved payment plan/);
});

test("duplicate pending request is rejected while cancelled request may be retried", () => {
  assert.throws(() => assertFeePaymentRequestCanBeSubmitted({ status: "pending_verification" }), /already awaiting verification/);
  assert.throws(() => assertFeePaymentRequestCanBeSubmitted({ status: "verified" }), /already has a verified/);
  assert.equal(assertFeePaymentRequestCanBeSubmitted({ status: "cancelled" }), true);
  assert.equal(assertFeePaymentRequestCanBeSubmitted(null), true);
});

test("partial, malformed, and unclassified records produce diagnostics instead of inferred plans", () => {
  assert.equal(classifyFeeProfile({ createdAt: date("2026-10-22"), planTotal: 500 }).kind, "incomplete");
  assert.match(classifyFeeProfile({ createdAt: date("2026-10-22"), paymentFrequency: "weekly" }).diagnostic, /invalid/);
  assert.equal(classifyFeeProfile({}).kind, "unknown");
  assert.equal(classifyFeeProfile({ fees: { 2025: { January: { paid: true, paidOn: "2025-01-03" } } } }).kind, "legacy_monthly");
});

test("admin and dashboard keep using the selected users document as the fee source", async () => {
  const admin = await readFile(new URL("../../admin.html", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../../dashboard.html", import.meta.url), "utf8");
  assert.match(admin, /doc\(db,"users",\$\("feeStudent"\)\.value\)/);
  assert.match(admin, /option\.value=u\.id/);
  assert.match(admin, /Document ID: /);
  assert.match(admin, /New plan · /);
  assert.match(admin, /import \{ ACADEMIC_PROGRAMS, ACTIVE_CLASSES, formatINR, getAcademicTier \}/);
  assert.match(admin, /getDoc\(doc\(db,"users",selectedStudentId,"feePaymentRequests",period\.id\)\)/);
  assert.doesNotMatch(admin, /getDocs\(collection\(db,"users",selectedStudentId,"feePaymentRequests"\)\)/);
  assert.match(admin, /Fee Management\] \$\{operation\} failed/);
  assert.match(admin, /Could not \$\{operation\} for student \$\{selectedStudentId\}/);
  assert.match(admin, /feePeriodsForProfile\(profile/);
  assert.match(admin, /markFeePeriodPaid\(profile,period,serverTimestamp\(\)\)/);
  assert.match(admin, /Request: /);
  assert.match(dashboard, /doc\(db,"users",uid\)/);
  assert.match(dashboard, /feePeriodsForProfile\(profile/);
  assert.doesNotMatch(dashboard, /annual display/);
  assert.match(dashboard, /buildFeePaymentRequest\(/);
  assert.match(dashboard, /studentProfile,period,[\s\S]*activeStudentUid/);
  assert.match(dashboard, /Thank you! Your fee payment confirmation has been received\. Your fee status will be updated shortly after verification by the admin\./);
  assert.doesNotMatch(dashboard, /markFeePeriodPaid/);
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
