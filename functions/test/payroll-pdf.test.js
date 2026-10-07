const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const { createSalarySlipPdf, salaryFilename } = require("../payroll-pdf");
const { normalizeSalary, formatReference } = require("../payroll-core");

const currencyFontPath = path.join(__dirname, "..", "assets", "NotoSans.ttf");

function pdfObjectStream(source, objectId) {
  const objectStart = source.indexOf(`${objectId} 0 obj`);
  assert.notEqual(objectStart, -1, `PDF object ${objectId} exists`);
  const streamStart = source.indexOf("stream", objectStart);
  const bodyStart = source[streamStart + 6] === "\r" && source[streamStart + 7] === "\n"
    ? streamStart + 8
    : streamStart + 7;
  const streamEnd = source.indexOf("endstream", bodyStart);
  assert.notEqual(streamStart, -1, `PDF object ${objectId} has a stream`);
  assert.notEqual(streamEnd, -1, `PDF object ${objectId} stream ends`);
  return source.slice(bodyStart, streamEnd);
}

function unicodeMapForCmap(cmap) {
  const unicodeByGlyph = new Map();
  const ranges = cmap.match(/beginbfrange([\s\S]*?)endbfrange/i)?.[1] || "";
  for (const [, firstGlyph, , mappings] of ranges.matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*\[([^\]]+)\]/gi)) {
    const first = Number.parseInt(firstGlyph, 16);
    for (const [index, [, codePoint]] of [...mappings.matchAll(/<([\da-f]+)>/gi)].entries()) {
      unicodeByGlyph.set(first + index, String.fromCodePoint(Number.parseInt(codePoint, 16)));
    }
  }
  return unicodeByGlyph;
}

function decodePdfTextBlocks(pdf) {
  const source = pdf.toString("latin1");
  const contentObjectId = Number(source.match(/\/Contents\s+(\d+)\s+0\s+R/)?.[1]);
  const pageMarker = source.search(/\/Type \/Page(?!s)/);
  const objectMarker = source.lastIndexOf(" 0 obj", pageMarker);
  const pageStart = source.lastIndexOf("\n", objectMarker) + 1;
  const pageObjectId = Number(source.slice(pageStart, objectMarker).trim());
  assert.ok(pageObjectId && contentObjectId, "PDF has a page content stream");
  const pageObject = source.slice(pageStart, source.indexOf("endobj", pageStart));
  const resourceObjectId = Number(pageObject.match(/\/Resources\s+(\d+)\s+0\s+R/)?.[1]);
  assert.ok(resourceObjectId, "PDF page has resources");
  const resourceStart = source.indexOf(`${resourceObjectId} 0 obj`);
  const resources = source.slice(resourceStart, source.indexOf("endobj", resourceStart));
  const unicodeByFont = new Map();
  for (const [, fontName, fontObjectId] of resources.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
    const fontStart = source.indexOf(`${fontObjectId} 0 obj`);
    const font = source.slice(fontStart, source.indexOf("endobj", fontStart));
    const cmapObjectId = Number(font.match(/\/ToUnicode\s+(\d+)\s+0\s+R/)?.[1]);
    if (cmapObjectId) unicodeByFont.set(fontName, unicodeMapForCmap(pdfObjectStream(source, cmapObjectId)));
  }

  const content = pdfObjectStream(source, contentObjectId);
  return [...content.matchAll(/BT([\s\S]*?)ET/g)].map(([, block]) => {
    const fontName = block.match(/\/(F\d+)\s+[\d.]+\s+Tf/)?.[1];
    const unicodeByGlyph = unicodeByFont.get(fontName);
    const decoded = [...block.matchAll(/<([\da-f]+)>/gi)].map(([, encoded]) => {
      if (unicodeByGlyph) {
        if (encoded.length % 4 !== 0) return "";
        let value = "";
        for (let offset = 0; offset < encoded.length; offset += 4) {
          value += unicodeByGlyph.get(Number.parseInt(encoded.slice(offset, offset + 4), 16)) || "";
        }
        return value;
      }
      return encoded.length % 2 === 0 ? Buffer.from(encoded, "hex").toString("latin1") : "";
    }).join("");
    const matrix = block.match(/1 0 0 1\s+([\d.]+)\s+([\d.]+)\s+Tm/);
    const fontSize = block.match(/\/F\d+\s+([\d.]+)\s+Tf/);
    return { text: decoded, x: matrix ? Number(matrix[1]) : null, fontSize: fontSize ? Number(fontSize[1]) : null };
  }).filter(({ text }) => text);
}

test("canonical PDF is generated from validated salary values and reuses Mentora logo", async () => {
  const { salary } = normalizeSalary({
    payPeriod: "05/04/2027", employeeId: "ME-001", employeeName: "Ranita Munshi", position: "Educator",
    employeeEmail: "employee@example.com", basicPay: 25000, allowance: 3000, allowanceDisplay: 3000,
    overtimePay: 1500, overtimeDisplay: 1500, bonus: 2000, bonusDisplay: 2000, totalEarnings: 31500,
    accountNumber: "123456789012"
  });
  const reference = formatReference(2027, 4, 1);
  const pdf = await createSalarySlipPdf(salary, reference);
  const document = pdf.toString("latin1");
  assert.equal(document.slice(0, 5), "%PDF-");
  const textBlocks = decodePdfTextBlocks(pdf);
  const textContent = textBlocks.map(({ text }) => text).join("");
  assert.match(textContent, /EMPLOYEE PAYSLIP/);
  assert.match(textContent, /Ranita Munshi/);
  assert.match(textContent, /05\/04\/2027/);
  assert.match(textContent, /ME-PAY-2027-04-001/);
  assert.match(textContent, /₹25,000\.00/);
  assert.match(textContent, /₹3,000\.00/);
  assert.match(textContent, /₹1,500\.00/);
  assert.match(textContent, /₹2,000\.00/);
  assert.match(textContent, /₹31,500\.00/);
  const rightEdge = 547 - 14;
  for (const value of ["₹25,000.00", "₹3,000.00", "₹1,500.00", "₹2,000.00", "₹31,500.00"]) {
    const block = textBlocks.find(({ text }) => text === value);
    assert.ok(block, `${value} is present in the PDF text`);
    const measure = new PDFDocument({ size: "A4", margin: 0 });
    measure.font(currencyFontPath).fontSize(block.fontSize);
    const amountWidth = measure.widthOfString(value);
    measure.end();
    assert.ok(Math.abs(block.x + amountWidth - rightEdge) < 1, `${value} ends at the shared right column edge`);
  }
  assert.match(textContent, /Account ending 9012/);
  assert.doesNotMatch(textContent, /123456789012/);
});

test("filename is sanitized and derives its month from the exact entered pay period", () => {
  const filename = salaryFilename({ payPeriod: "05/04/2027", employeeName: "Ranita Munshi" });
  assert.equal(filename, "Mentora_Edge_Salary_Slip_Ranita_Munshi_April_2027.pdf");
});
