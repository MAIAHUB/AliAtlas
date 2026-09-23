// Contrast phase of a CT series. Plain (non-contrast) CT limits lesion margins and
// characterization, so sizes are shown as approximate and reports default to screening.
export const PHASES = [
  { id: 'non-contrast', name: 'Non-contrast', enhanced: false },
  { id: 'arterial', name: 'Arterial', enhanced: true },
  { id: 'portal-venous', name: 'Portal venous', enhanced: true },
  { id: 'delayed', name: 'Delayed', enhanced: true },
  { id: 'contrast', name: 'Contrast (phase not stated)', enhanced: true },
  { id: 'unknown', name: 'Contrast unknown', enhanced: false },
];

const RULES = [
  [
    'non-contrast',
    /\b(non[\s_-]?con(trast)?|nc(ct)?|plain|native|unenhanced|pre[\s_-]?(contrast|con)|w\/?o|without)\b/i,
  ],
  ['arterial', /\b(arterial|art|cta|angio\w*|early)\b/i],
  ['portal-venous', /\b(portal|pv|venous|ven|70\s?s(ec)?)\b/i],
  ['delayed', /\b(delay\w*|late|equilibrium|excret\w*|urogra\w*|nephrogra\w*)\b/i],
  ['contrast', /(\bc\+|\bcontrast\b|\bwith\b|\bpost\b|\benhanced\b|\bcon\b|\biv\b)/i],
];

function fromText(text) {
  for (const [phase, pattern] of RULES) if (pattern.test(text || '')) return phase;
  return null;
}

// Evidence order: a person's correction, the DICOM contrast agent tag, then the
// series/protocol description. Without evidence the phase stays "unknown".
export function classifyPhase(series) {
  if (series.phaseOverride) return { phase: series.phaseOverride, source: 'user' };
  const agent = String(series.contrastAgent || '').trim();
  const described = fromText(`${series.description || ''} ${series.protocolName || ''}`);
  if (agent && !/^(none|no|nil|n\/?a|-)$/i.test(agent))
    return {
      phase: described && described !== 'non-contrast' ? described : 'contrast',
      source: 'dicom',
    };
  if (described) return { phase: described, source: 'description' };
  return { phase: 'unknown', source: 'none' };
}

export const phaseInfo = (id) => PHASES.find((p) => p.id === id) || PHASES.at(-1);
export const isEnhanced = (series) => phaseInfo(classifyPhase(series).phase).enhanced;

// Plain or unknown-phase CT: measurements are approximate.
export const approximateSizes = (series) => !isEnhanced(series);
