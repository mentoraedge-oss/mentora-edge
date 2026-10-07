const path = require("node:path");
const PDFDocument = require("pdfkit");

const LOGO_PATH = path.join(__dirname, "assets", "mentora-edge-logo.png");
const CURRENCY_FONT_PATH = path.join(__dirname, "assets", "NotoSans.ttf");
const NAVY = "#0F2A44";
const GREEN = "#16A34A";
const MUTED = "#64748B";
const LIGHT = "#F1F5F9";
const money = (amount) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(amount);

function createSalarySlipPdf(salary, referenceNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, compress: false, info: { Title: "Mentora Edge Employee Payslip", Author: "Mentora Edge" } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const left = 48, right = 547, width = right - left;
    const contentLeft = left + 14;
    const contentRight = right - 14;
    const amountColumnWidth = 180;
    const amountColumnX = contentRight - amountColumnWidth;
    doc.rect(0, 0, 595.28, 148).fill(NAVY);
    doc.image(LOGO_PATH, left, 28, { fit: [66, 66] });
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(21).text("MENTORA EDGE", 132, 43);
    doc.font("Helvetica").fontSize(9).fillColor("#D7E2EC").text("SHAPING MINDS  |  SHARPENING FUTURES", 133, 72);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#FFFFFF").text("EMPLOYEE PAYSLIP", 133, 103);
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#D7E2EC").text("OFFICIAL SALARY STATEMENT", right, 119, { align: "right" });

    const info = (label, value, x, y, maxWidth = 205) => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(value || "-", x, y + 15, { width: maxWidth, height: 28, ellipsis: true });
    };
    info("Pay Period", salary.payPeriod, left, 184);
    info("Employee ID", salary.employeeId, 315, 184);
    info("Employee Name", salary.employeeName, left, 236);
    info("Position", salary.position, 315, 236);

    doc.roundedRect(left, 302, width, 34, 5).fill(NAVY);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#FFFFFF").text("EARNINGS", left + 14, 314);
    doc.fontSize(8).text("DESCRIPTION", contentLeft, 356)
      .text("AMOUNT (INR)", amountColumnX, 356, { align: "right", width: amountColumnWidth });
    doc.moveTo(left, 376).lineTo(right, 376).lineWidth(0.7).strokeColor("#DCE2E8").stroke();

    const rows = [
      ["Basic Pay", money(salary.basicPay)],
      ["Allowance", salary.allowanceDisplay === "NA" ? "NA" : money(salary.allowance)],
      ["Overtime Pay", salary.overtimeDisplay === "NA" ? "NA" : money(salary.overtimePay)],
      ["Bonus", salary.bonusDisplay === "NA" ? "NA" : money(salary.bonus)]
    ];
    rows.forEach(([label, amount], index) => {
      const y = 393 + index * 38;
      if (index % 2 === 0) doc.rect(left, y - 7, width, 30).fill(LIGHT);
      doc.font("Helvetica").fontSize(10).fillColor(NAVY).text(label, contentLeft, y);
      doc.font(CURRENCY_FONT_PATH).fontSize(10).fillColor(NAVY)
        .text(amount, amountColumnX, y, { align: "right", width: amountColumnWidth });
    });

    doc.roundedRect(left, 558, width, 46, 5).fill("#E8F8ED");
    doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text("TOTAL EARNINGS", contentLeft, 576);
    doc.font(CURRENCY_FONT_PATH).fontSize(14).fillColor(GREEN)
      .text(money(salary.totalEarnings), amountColumnX, 573, { align: "right", width: amountColumnWidth });
    doc.moveTo(left, 638).lineTo(right, 638).lineWidth(0.7).strokeColor("#DCE2E8").stroke();
    info("Account Number", salary.accountLast4 ? `Account ending ${salary.accountLast4}` : "Not provided", left, 660);
    info("Reference Number", referenceNumber, 315, 660, 232);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("This salary slip is generated electronically by Mentora Edge.", left, 790);
    doc.moveTo(left, 817).lineTo(right, 817).lineWidth(3).strokeColor(GREEN).stroke();
    doc.end();
  });
}

function salaryFilename(salary) {
  const [day, month, year] = salary.payPeriod.split("/").map(Number);
  const period = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const safeName = salary.employeeName.normalize("NFKD").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().replace(/\s+/g, "_") || "Employee";
  return `Mentora_Edge_Salary_Slip_${safeName}_${period.replace(/\s+/g, "_")}.pdf`;
}

module.exports = { createSalarySlipPdf, salaryFilename };
