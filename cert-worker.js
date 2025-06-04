// Offload Excel to PDF to ZIP conversion end-to-end in a Worker, embedding JPEG backgrounds without unintended rotation

importScripts(
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
);

const { jsPDF } = globalThis.jspdf;

// utility: Title Case
function toTitleCase(str) {
  return str
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// utility: wrapped text
function drawWrappedText(ctx, text, x, y, w, h, lineH) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (let word of words) {
    const test = line + word + " ";
    if (ctx.measureText(test).width > w && line) {
      lines.push(line.trim());
      line = word + " ";
    } else {
      line = test;
    }
  }
  if (line) lines.push(line.trim());
  const totalH = lines.length * lineH;
  let startY = y + (h - totalH) / 2 + lineH / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + w / 2, startY + i * lineH);
  }
}

onmessage = async (e) => {
  try {
    const { imgDataURL, imgW, imgH, selections, excelBuffer } = e.data;

    // parse Excel
    const wb = XLSX.read(excelBuffer, { type: "array" });
    const rows = [];
    for (let name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (data.length < 2) continue;
      const headers = data[0].map((h) => String(h || "").toLowerCase());
      for (let i = 1; i < data.length; i++) {
        const rowObj = {},
          line = data[i];
        headers.forEach((h, idx) => {
          if (h && line[idx] != null) {
            const v = String(line[idx]).trim();
            rowObj[h] = rowObj[h] ? rowObj[h] + " " + v : v;
          }
        });
        rows.push(rowObj);
      }
    }
    if (!rows.length) throw new Error("No data found in Excel");

    // load image into an ImageBitmap
    const resp = await fetch(imgDataURL);
    const blob = await resp.blob();
    const imgBitmap = await createImageBitmap(blob);

    const zip = new JSZip();

    // for each row, render & PDF
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // offscreen canvas
      const oc = new OffscreenCanvas(imgW, imgH);
      const ctx = oc.getContext("2d");
      ctx.drawImage(imgBitmap, 0, 0);

      // draw each region
      for (let sel of selections) {
        let key = sel.label.toLowerCase();
        let text = row[key] || "";
        if (!text) continue;
        if (sel.titleCase) text = toTitleCase(text);
        ctx.font = `bold ${sel.fontSize}px ${sel.fontFamily}`;
        ctx.fillStyle = "#333";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        drawWrappedText(
          ctx,
          text,
          sel.x,
          sel.y,
          sel.width,
          sel.height,
          Math.round(sel.fontSize * 0.5),
        );
      }

      // convert to JPEG blob at 70% quality
      const jpegBlob = await oc.convertToBlob({
        type: "image/jpeg",
        quality: 0.7,
      });

      // build PDF, embedding JPEG with no rotation
      const pdf = new jsPDF("landscape", "pt", [imgW, imgH]);
      const jpegDataUrl = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(jpegBlob);
      });
      // omit the stray quality-as-rotation argument and force rotation = 0
      pdf.addImage(jpegDataUrl, "JPEG", 0, 0, imgW, imgH, undefined, "FAST", 0);

      const pdfBlob = pdf.output("blob");

      // name & add to zip
      let name = row["name"] ? row["name"].trim() : `certificate_${i + 1}`;
      name = toTitleCase(name || `certificate_${i + 1}`);
      zip.file(`${name}.pdf`, pdfBlob);
    }

    // generate zip ArrayBuffer
    const zipBuf = await zip.generateAsync({ type: "arraybuffer" });
    postMessage(zipBuf, [zipBuf]);
  } catch (err) {
    postMessage({ error: err.message });
  }
};
