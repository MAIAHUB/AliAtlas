import PDFDocument from 'pdfkit';
import { categoryName, formatSize, formatVolume } from './measure.js';
import { approximateSizes, classifyPhase, phaseInfo } from './contrast.js';
import { formatHu } from './roi.js';
import { sliceOf } from './report.js';

// A4 report rendered on the server. Uses the PDF standard fonts (no font files to
// ship), which only cover Windows-1252, so a few symbols are spelled out.
const SUBSTITUTES = { '≈': 'approx.', π: 'pi', '≤': '<=', '≥': '>=', '→': '->', '−': '-' };
const WIN_ANSI = /[^\n\t\x20-\x7e\xa0-\xff–—‘’“”•…€]/g;
export const pdfText = (value) =>
  String(value ?? '')
    .replace(/[≈π≤≥→−]/g, (c) => SUBSTITUTES[c])
    .replace(WIN_ANSI, '?');

const INK = '#111111',
  MUTED = '#666666',
  RULE = '#cccccc';
const MARGIN = 50;

export function buildReportPdf({ study, report, findings, images, generatedAt = new Date() }) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + 30, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: 'CT report', Creator: 'AliAtlas', Producer: 'AliAtlas' },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (height) => {
    if (doc.y + height > bottom()) doc.addPage();
  };
  const diagnostic = report.reportType === 'diagnostic';
  const final = report.status === 'final';

  // Header
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(INK)
    .text(diagnostic ? 'CT Diagnostic Report' : 'CT Screening Report', MARGIN, MARGIN, {
      width: width * 0.55,
    });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(pdfText(study.title), { width: width * 0.55 });
  const phases = [...new Set(study.series.map((s) => phaseInfo(classifyPhase(s).phase).name))];
  const meta = [
    ['Status', final ? 'Final' : 'Draft - not for clinical use'],
    ['Contrast', phases.join(', ')],
    ['Study imported', new Date(study.createdAt).toLocaleDateString('en-GB')],
    ['Generated', generatedAt.toLocaleString('en-GB')],
  ];
  let metaY = MARGIN + 2;
  for (const [label, value] of meta) {
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(label, MARGIN + width * 0.6, metaY, { width: 70 });
    doc
      .fillColor(INK)
      .text(pdfText(value), MARGIN + width * 0.6 + 72, metaY, { width: width * 0.4 - 72 });
    metaY += 13;
  }
  doc.y = Math.max(doc.y, metaY) + 10;
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + width, doc.y)
    .lineWidth(1.5)
    .strokeColor(INK)
    .stroke();
  doc.moveDown(1);

  // Sections
  const heading = (title) => {
    ensure(40);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#333333')
      .text(title.toUpperCase(), MARGIN, doc.y, { width, characterSpacing: 0.6 });
    doc.moveDown(0.3);
  };
  const sections = [
    ['Clinical history', report.clinicalHistory],
    ['Technique', report.technique],
    ['Findings', report.findingsText],
    ['Impression', report.impression],
    ['Limitations', report.limitations],
    ['Recommendation', report.recommendation],
  ].filter(([title, text]) => text?.trim() || !['Limitations', 'Recommendation'].includes(title));
  for (const [title, text] of sections) {
    heading(title);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(INK)
      .text(pdfText(text?.trim() || '-'), MARGIN, doc.y, { width, lineGap: 2 });
    doc.moveDown(0.9);
  }

  // Measured lesions table
  const confirmed = findings
    .filter((f) => f.status === 'confirmed')
    .map((f) => {
      const slice = sliceOf(study, f);
      return { f, ...slice, approx: slice.series ? approximateSizes(slice.series) : true };
    })
    .sort((a, b) => a.index - b.index);
  heading('Measured lesions');
  if (!confirmed.length) {
    doc.font('Helvetica').fontSize(10).fillColor(INK).text('No measured lesions.', MARGIN);
  } else {
    const cols = [
      { title: '#', w: 22 },
      { title: 'Finding', w: width * 0.32 },
      { title: 'Series / image', w: width * 0.2 },
      { title: 'Size', w: width * 0.24 },
      { title: 'Density', w: width * 0.24 - 22 },
    ];
    const row = (cells, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      const heights = cells.map((c, i) =>
        doc.heightOfString(pdfText(c), { width: cols[i].w - 6, lineGap: 1 }),
      );
      const h = Math.max(...heights) + 8;
      ensure(h);
      const y = doc.y;
      let x = MARGIN;
      cells.forEach((c, i) => {
        doc
          .fillColor(bold ? '#333333' : INK)
          .text(pdfText(c), x + 3, y + 4, { width: cols[i].w - 6, lineGap: 1 });
        x += cols[i].w;
      });
      doc
        .moveTo(MARGIN, y + h)
        .lineTo(MARGIN + width, y + h)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc.y = y + h;
    };
    row(
      cols.map((c) => c.title),
      true,
    );
    confirmed.forEach(({ f, series, index, total, approx }, i) => {
      const volume = formatVolume(f, { approx });
      const size = [f.longMm != null ? formatSize(f, { approx }) : '-'];
      if (volume) size.push(`volume ${volume}`);
      const source = f.source === 'ai' ? ' (AI-suggested, confirmed)' : '';
      row([
        String(i + 1),
        `${f.label}\n${categoryName(f.category)}${source}`,
        `${series?.description || 'CT'}\n${index + 1}/${total}`,
        size.join('\n'),
        f.roi?.stats ? formatHu(f.roi.stats) : '-',
      ]);
    });
  }
  doc.moveDown(1);

  // Key images, two per row
  const withImages = confirmed.filter(({ f }) => images.has(f.id));
  if (withImages.length) {
    const gap = 14,
      cell = (width - gap) / 2;
    // Keep the heading on the same page as the first row of images.
    ensure(cell + 60);
    heading('Key images');
    for (let i = 0; i < withImages.length; i += 2) {
      const pair = withImages.slice(i, i + 2);
      ensure(cell + 30);
      const y = doc.y;
      pair.forEach(({ f, index, approx }, j) => {
        const x = MARGIN + j * (cell + gap);
        doc.rect(x, y, cell, cell).fillColor('#000000').fill();
        doc.image(images.get(f.id), x, y, { fit: [cell, cell], align: 'center', valign: 'center' });
        const size = f.longMm != null ? formatSize(f, { approx }) : formatHu(f.roi?.stats);
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            pdfText(`${i + j + 1}. ${f.label} - image ${index + 1} - ${size}`),
            x,
            y + cell + 4,
            {
              width: cell,
            },
          );
      });
      doc.y = y + cell + 24;
    }
  }

  const pending = findings.filter((f) => f.status === 'unreviewed').length;
  if (pending) {
    ensure(30);
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#9a5b00')
      .text(`${pending} AI suggestion(s) have not been reviewed and are not included.`, MARGIN);
  }

  // Signature block
  ensure(50);
  doc.moveDown(1);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(INK)
    .text(
      pdfText(
        final
          ? `Finalized by ${report.finalizedBy?.name || '-'} (${report.finalizedBy?.email || ''}) on ${new Date(report.finalizedAt).toLocaleString('en-GB')}.`
          : 'Not finalized. This draft must be reviewed and finalized by a qualified reader.',
      ),
      MARGIN,
    );

  // Footer, page numbers and draft watermark on every page
  const disclaimer = diagnostic
    ? 'Generated with AliAtlas, an educational workspace. AI-assisted suggestions are not a diagnosis and were reviewed by the reader named in this report.'
    : 'Generated with AliAtlas, an educational workspace. Screening report on non-contrast or unconfirmed-phase CT: sizes marked approx. are approximate and this report is not sufficient for diagnosis.';
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    // The footer sits inside the bottom margin; lift it so pdfkit does not add a page.
    doc.page.margins.bottom = 0;
    if (!final) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .font('Helvetica-Bold')
        .fontSize(110)
        .fillColor('#cc0000')
        .opacity(0.07)
        .text('DRAFT', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    }
    const y = doc.page.height - MARGIN - 18;
    doc
      .moveTo(MARGIN, y - 6)
      .lineTo(MARGIN + width, y - 6)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(disclaimer, MARGIN, y, { width: width - 70, lineBreak: true, height: 24 });
    doc.text(`Page ${p - range.start + 1} of ${range.count}`, MARGIN + width - 60, y, {
      width: 60,
      align: 'right',
    });
  }
  doc.end();
  return done;
}
