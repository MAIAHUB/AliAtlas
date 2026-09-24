import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, assert } from './errors.js';
import { loadStudy, getSeries, seriesDir } from './storage.js';
import { decodePixels } from './dicom.js';
import { windowPixel } from './geometry.js';
import { encodeGrayPng } from './png.js';
import { FINDING_CATEGORIES } from './measure.js';

// Adapter for the external vision/drafting service. Configured only on the server:
//   BAI_API_KEY   secret key (never sent to the browser)
//   BAI_BASE_URL  API root, e.g. https://api.example.com/v1
//   BAI_MODEL     model name that accepts images
//   BAI_API_STYLE request format; 'openai' (chat completions with image_url parts)
// Only rendered slice pixels and scan geometry are sent: no DICOM header, patient
// name, IDs, or dates. Results are suggestions that a person must review.
export const MAX_SLICES = 16;

const config = () => ({
  key: process.env.BAI_API_KEY || '',
  baseUrl: (process.env.BAI_BASE_URL || '').replace(/\/+$/, ''),
  model: process.env.BAI_MODEL || '',
  style: process.env.BAI_API_STYLE || 'openai',
});

export function visionStatus() {
  const c = config();
  const configured = Boolean(c.key && c.baseUrl && c.model);
  return {
    configured,
    provider: 'external',
    message: configured
      ? 'Automated detection is available. Suggestions require review.'
      : 'Automated detection is not configured on this server.',
  };
}

const PROMPT = `You are assisting a radiologist reviewing CT images for teaching.
Look for abnormalities such as tumours, masses, nodules, enlarged lymph nodes, cysts and fluid collections.
Each image is one axial CT slice from the same series, numbered in order, rendered with the stated window.
Pixel coordinates are in the image's own pixel grid: x from 0 (left edge) to width-1, y from 0 (top) to height-1.
For every abnormality, give the image number where it is largest and the two end points of its longest diameter;
add the perpendicular short-axis end points when you can. Do not estimate sizes in mm: the software measures them.
Do not invent findings. If nothing abnormal is visible, return an empty list.
Reply with JSON only, exactly in this shape:
{"findings":[{"image":1,"label":"short name","category":"mass|nodule|lymph-node|cyst|fluid|other","description":"one sentence","confidence":0.0,"long":[[x1,y1],[x2,y2]],"short":[[x1,y1],[x2,y2]]}],"summary":"one or two sentences"}`;

async function renderSlices(owner, studyId, series, frames, window) {
  const files = new Map(),
    images = [];
  for (const frame of frames) {
    if (!files.has(frame.fileId))
      files.set(
        frame.fileId,
        await fs.readFile(path.join(seriesDir(owner, studyId, series.id), `${frame.fileId}.dcm`)),
      );
    const pixels = decodePixels(files.get(frame.fileId), frame),
      gray = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i++)
      gray[i] = Math.round(windowPixel(pixels[i], window.center, window.width, frame.inverted));
    images.push(encodeGrayPng(frame.columns, frame.rows, gray).toString('base64'));
  }
  return images;
}

export function parseModelJson(content) {
  const text = String(content || '')
    .replace(/^```(?:json)?/im, '')
    .replace(/```\s*$/m, '');
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AppError(
      'The detection service returned an unreadable answer. Try again.',
      502,
      'AI_BAD_RESPONSE',
    );
  }
}

const point = (p, frame) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    ? [Math.min(frame.columns - 1, Math.max(0, p[0])), Math.min(frame.rows - 1, Math.max(0, p[1]))]
    : null;
const line = (l, frame) => {
  const a = Array.isArray(l) ? point(l[0], frame) : null,
    b = Array.isArray(l) ? point(l[1], frame) : null;
  return a && b && (a[0] !== b[0] || a[1] !== b[1]) ? [a, b] : null;
};

// Turns the model's answer into finding inputs; anything malformed is dropped.
export function toFindingInputs(answer, series, frames) {
  const list = Array.isArray(answer?.findings) ? answer.findings.slice(0, 50) : [];
  const inputs = [];
  for (const item of list) {
    const frame = frames[Number(item.image) - 1];
    if (!frame) continue;
    const long = line(item.long, frame);
    if (!long) continue;
    inputs.push({
      seriesId: series.id,
      frameId: frame.id,
      label: String(item.label || 'Possible abnormality').slice(0, 80),
      category: FINDING_CATEGORIES.some((c) => c.id === item.category) ? item.category : 'other',
      note: String(item.description || '').slice(0, 1000),
      confidence: Number(item.confidence),
      long,
      short: line(item.short, frame),
    });
  }
  return {
    inputs,
    summary: String(answer?.summary || '').slice(0, 2000),
    dropped: list.length - inputs.length,
  };
}

async function callOpenAiStyle(c, content, system = PROMPT) {
  let response;
  try {
    response = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new AppError(
      'The detection service is unreachable or took too long.',
      502,
      'AI_UNAVAILABLE',
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new AppError(
      'The detection service rejected its credentials. Check the server configuration.',
      502,
      'AI_AUTH',
    );
  if (response.status === 429)
    throw new AppError(
      'The detection service is busy. Wait a moment and retry.',
      429,
      'AI_RATE_LIMIT',
    );
  if (!response.ok)
    throw new AppError(`The detection service returned an error (${response.status}).`, 502);
  const body = await response.json().catch(() => null);
  return body?.choices?.[0]?.message?.content;
}

export async function detectAbnormalities(owner, studyId, { seriesId, frameIds, window }) {
  const c = config();
  assert(visionStatus().configured, visionStatus().message, 503, 'AI_NOT_CONFIGURED');
  assert(c.style === 'openai', `BAI_API_STYLE "${c.style}" is not supported yet.`, 503);
  const study = await loadStudy(owner, studyId),
    series = getSeries(study, seriesId);
  assert(
    Array.isArray(frameIds) && frameIds.length >= 1 && frameIds.length <= MAX_SLICES,
    `Send 1 to ${MAX_SLICES} slices.`,
  );
  const frames = frameIds.map((id) => {
    const frame = series.frames.find((f) => f.id === id);
    assert(frame, 'Slice not found.', 404);
    return frame;
  });
  const w = {
    center: Number.isFinite(window?.center) ? window.center : 40,
    width: Number.isFinite(window?.width) && window.width >= 1 ? window.width : 400,
  };
  const images = await renderSlices(owner, studyId, series, frames, w);
  const [rowSpacing, columnSpacing] = frames[0].spacing || [];
  const content = [
    {
      type: 'text',
      text: `${frames.length} axial CT image(s), each ${frames[0].columns}×${frames[0].rows} pixels${rowSpacing ? `, pixel spacing ${columnSpacing}×${rowSpacing} mm` : ''}, window width ${w.width} HU / level ${w.center} HU, body region: ${series.bodyPart || 'unspecified'}.`,
    },
    ...images.flatMap((b64, i) => [
      { type: 'text', text: `Image ${i + 1}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ]),
  ];
  const answer = parseModelJson(await callOpenAiStyle(c, content));
  return { ...toFindingInputs(answer, series, frames), model: c.model };
}

const REPORT_PROMPT = `You draft a CT report for a radiologist, who will review and edit it before signing.
You receive the report type, the technique and the MEASURED FINDINGS, which are authoritative.
Write four sections:
- findings: clear radiology prose describing each listed finding. Keep every measurement, image number,
  unit and "≈" marker exactly as given. Do not describe any structure or finding that is not listed, and do
  not state that other organs are normal. End with "No other measured abnormality was recorded."
- impression: numbered points, most clinically important first, at most 5, cautious wording
  ("likely", "differential includes"); no definitive diagnosis.
- limitations: 1-3 sentences on the limits of this examination and of the measurements (for a screening
  study, that it is non-contrast or the phase is unconfirmed and sizes are approximate).
- recommendation: appropriate next step for the listed findings (further imaging, follow-up interval
  or clinical correlation), citing a recognised guideline where one applies (for example Fleischner
  Society for pulmonary nodules). Do not invent patient history or risk factors; if follow-up depends on
  them, say so.
Reply with JSON only: {"findings":"...","impression":"1. ...\\n2. ...","limitations":"...","recommendation":"..."}`;

// Drafts the narrative sections from report text only: no images, clinical history or
// identifiers are sent.
export async function draftReport({ reportType, technique, findingsText }) {
  const c = config();
  assert(visionStatus().configured, visionStatus().message, 503, 'AI_NOT_CONFIGURED');
  assert(c.style === 'openai', `BAI_API_STYLE "${c.style}" is not supported yet.`, 503);
  const screening = reportType !== 'diagnostic';
  const text = [
    `Report type: ${screening ? 'screening (non-contrast or unconfirmed contrast phase; lesion characterization is limited, sizes approximate)' : 'diagnostic (contrast-enhanced)'}.`,
    `Technique:\n${String(technique || '').slice(0, 1000)}`,
    `Measured findings:\n${String(findingsText || '').slice(0, 8000)}`,
  ].join('\n\n');
  const answer = parseModelJson(await callOpenAiStyle(c, text, REPORT_PROMPT));
  const field = (name, max) =>
    String(answer?.[name] || '')
      .trim()
      .slice(0, max);
  const draft = {
    findingsText: field('findings', 8000),
    impression: field('impression', 4000),
    limitations: field('limitations', 2000),
    recommendation: field('recommendation', 2000),
  };
  assert(
    draft.impression,
    'The drafting service returned an empty report. Try again.',
    502,
    'AI_BAD_RESPONSE',
  );
  return { ...draft, model: c.model };
}
