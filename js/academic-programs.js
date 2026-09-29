export const ALL_SUBJECTS_VALUE = "all-subject-combo";
const IX_X_SUBJECT_FEES = Object.freeze({
  English: 500,
  "Social Science": 500,
  Science: 600,
  Maths: 600
});
const IX_X_COMBO_MONTHLY = Object.values(IX_X_SUBJECT_FEES).reduce((sum, fee) => sum + fee, 0);
const IX_X_QUARTERLY_INSTALLMENTS = Object.freeze([7000, 7000, 6000]);
const IX_X_ANNUAL_TOTAL = 20000;

export const ACADEMIC_PROGRAMS = Object.freeze({
  secondary: Object.freeze({
    classes: Object.freeze(["IX", "X"]),
    subjects: IX_X_SUBJECT_FEES,
    combo: Object.freeze({
      value: ALL_SUBJECTS_VALUE,
      label: "All-subject combo",
      subjects: Object.freeze(Object.keys(IX_X_SUBJECT_FEES)),
      monthly: IX_X_COMBO_MONTHLY,
      quarterlyInstallments: IX_X_QUARTERLY_INSTALLMENTS,
      annualValue: IX_X_COMBO_MONTHLY * 12,
      annualDiscount: IX_X_COMBO_MONTHLY * 12 - IX_X_ANNUAL_TOTAL,
      annualTotal: IX_X_ANNUAL_TOTAL
    })
  }),
  senior: Object.freeze({
    classes: Object.freeze(["XI", "XII"]),
    subjects: Object.freeze({ English: 5000 })
  })
});

export const ACTIVE_CLASSES = Object.freeze([
  ...ACADEMIC_PROGRAMS.secondary.classes,
  ...ACADEMIC_PROGRAMS.senior.classes
]);

export function getAcademicTier(className) {
  if (ACADEMIC_PROGRAMS.secondary.classes.includes(className)) return "secondary";
  if (ACADEMIC_PROGRAMS.senior.classes.includes(className)) return "senior";
  return null;
}

export function getOfferingOptions(className) {
  const tier = getAcademicTier(className);
  if (tier === "secondary") {
    return [
      ...Object.keys(ACADEMIC_PROGRAMS.secondary.subjects).map(value => ({
        value,
        label: value,
        kind: "subject"
      })),
      {
        value: ALL_SUBJECTS_VALUE,
        label: `${ACADEMIC_PROGRAMS.secondary.combo.label} (${ACADEMIC_PROGRAMS.secondary.combo.subjects.join(", ")})`,
        kind: "combo"
      }
    ];
  }
  if (tier === "senior") {
    return Object.keys(ACADEMIC_PROGRAMS.senior.subjects).map(value => ({ value, label: value, kind: "subject" }));
  }
  return [];
}

export function getPaymentFrequencies(className, offering) {
  const tier = getAcademicTier(className);
  if (tier === "senior") return Object.hasOwn(ACADEMIC_PROGRAMS.senior.subjects, offering) ? ["annual"] : [];
  if (tier !== "secondary") return [];
  if (offering === ALL_SUBJECTS_VALUE) return ["monthly", "quarterly", "annual"];
  return Object.hasOwn(ACADEMIC_PROGRAMS.secondary.subjects, offering) ? ["monthly"] : [];
}

export function getPlanDetails(className, offering, frequency) {
  if (!getPaymentFrequencies(className, offering).includes(frequency)) return null;

  const tier = getAcademicTier(className);
  if (tier === "senior") {
    const annual = ACADEMIC_PROGRAMS.senior.subjects[offering];
    return {
      label: "Annual",
      amount: annual,
      amountDue: annual,
      total: annual
    };
  }

  if (offering !== ALL_SUBJECTS_VALUE) {
    const amount = ACADEMIC_PROGRAMS.secondary.subjects[offering];
    return { label: "Monthly", amount, amountDue: amount, total: amount };
  }

  const combo = ACADEMIC_PROGRAMS.secondary.combo;
  if (frequency === "monthly") {
    return { label: "Monthly", amount: combo.monthly, amountDue: combo.monthly, total: combo.monthly };
  }
  if (frequency === "quarterly") {
    const total = combo.quarterlyInstallments.reduce((sum, installment) => sum + installment, 0);
    return {
      label: "Quarterly",
      amount: total,
      amountDue: combo.quarterlyInstallments[0],
      installments: combo.quarterlyInstallments,
      total
    };
  }
  return {
    label: "Annual",
    amount: combo.annualTotal,
    amountDue: combo.annualTotal,
    originalAmount: combo.annualValue,
    discount: combo.annualDiscount,
    total: combo.annualTotal
  };
}

export function formatINR(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}
