import { deflateSync } from "node:zlib";

// A one-page PDF with a line of Helvetica text and, if asked, a
// Flate-compressed 1-bit image: a few kilobytes on disk, width x height
// pixels decoded.
export function pdfFile({ text = "", image } = {}) {
  const data = image && deflateSync(Buffer.alloc((image.width / 8) * image.height));
  const content = `${image ? "q 300 0 0 200 0 0 cm /Im0 Do Q " : ""}${text ? `BT /F1 18 Tf 20 100 Td (${text}) Tj ET` : ""}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >>${image ? " /XObject << /Im0 6 0 R >>" : ""} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...(image ? [[`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, data, "\nendstream"]] : []),
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const part = Buffer.concat([`${index + 1} 0 obj\n`, ...[body].flat(), "\nendobj\n"].map((piece) => Buffer.from(piece)));
    parts.push(part);
    size += part.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([...parts, Buffer.from(xref)]));
}
