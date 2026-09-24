'use client';
import { useState } from 'react';
import Icon from './Icon.js';
import { categoryName, formatSize, formatVolume } from '../lib/measure.js';
import { PHASES, phaseInfo, classifyPhase } from '../lib/contrast.js';
import { densityHint, formatHu } from '../lib/roi.js';

const SCOPES = [
  { id: 'slice', name: 'This image' },
  { id: 'around', name: '15 images around here' },
  { id: 'series', name: 'Whole series (16 sampled)' },
];
function axesLabel(f) {
  if (f.ccMm != null) return 'L × W × CC';
  return f.shortMm != null ? 'long × short axis' : 'long axis';
}
const PHASE_SOURCES = {
  user: 'set by a reader',
  dicom: 'from DICOM contrast tag',
  description: 'from series description',
  none: 'not recorded in the images',
};

// Abnormal findings for the open series: contrast phase, measured lesions, density
// (HU), automated suggestions to review, abnormality detection, and the report entry point.
export default function FindingsPanel({
  findings,
  series,
  frame,
  vision,
  detecting,
  busy,
  selectedId,
  onSelect,
  onReview,
  onEdit,
  onDelete,
  onDetect,
  onMeasure,
  onReport,
  approx,
  phase,
  onPhase,
  onMarkExtent,
  onClear,
  onKeyImage,
}) {
  const [scope, setScope] = useState('around');
  const indexOf = (id) => series?.frames.findIndex((x) => x.id === id) ?? -1;
  const list = findings
    .filter((f) => f.seriesId === series?.id && f.status !== 'rejected')
    .sort((a, b) => indexOf(a.frameId) - indexOf(b.frameId));
  const rejected = findings.filter((f) => f.seriesId === series?.id && f.status === 'rejected');
  const pending = list.filter((f) => f.status === 'unreviewed').length;
  const selected = findings.find((f) => f.id === selectedId);
  const enhanced = phase ? phaseInfo(phase.phase).enhanced : false;
  const summary = (f) => {
    if (f.longMm != null) return formatSize(f, { approx });
    return f.roi?.stats ? formatHu(f.roi.stats) : '—';
  };
  return (
    <div className="findings-panel">
      {series && phase && (
        <div className={`phase-box ${enhanced ? 'enhanced' : ''}`}>
          <label className="field-label" htmlFor="contrast-phase">
            Contrast phase
          </label>
          <select
            id="contrast-phase"
            value={phase.source === 'user' ? phase.phase : 'auto'}
            disabled={busy}
            onChange={(e) => onPhase(e.target.value)}
          >
            <option value="auto">
              Auto: {phaseInfo(classifyPhase({ ...series, phaseOverride: null }).phase).name}
            </option>
            {PHASES.filter((p) => p.id !== 'unknown').map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p>
            {phaseInfo(phase.phase).name} · {PHASE_SOURCES[phase.source]}.{' '}
            {enhanced
              ? 'Diagnostic reporting available.'
              : 'Plain CT: sizes are approximate; reports are for screening.'}
          </p>
        </div>
      )}
      <div className="findings-actions">
        <button className="secondary-button" disabled={!frame || busy} onClick={onMeasure}>
          <Icon name="ruler" size={15} />
          Measure lesion
        </button>
        <button className="secondary-button" disabled={!series || busy} onClick={onReport}>
          <Icon name="report" size={15} />
          Report
        </button>
      </div>
      <div className="detect-box">
        <div className="detect-heading">
          <Icon name="sparkles" size={15} />
          <b>Detect abnormalities</b>
          <span className={`ai-state ${vision?.configured ? 'ready' : ''}`}>
            {vision?.configured ? 'READY' : 'OFF'}
          </span>
        </div>
        <label className="sr-only" htmlFor="detect-scope">
          Images to analyze
        </label>
        <select
          id="detect-scope"
          value={scope}
          disabled={!vision?.configured || detecting}
          onChange={(e) => setScope(e.target.value)}
        >
          {SCOPES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className="generate-button"
          disabled={!vision?.configured || !frame || detecting || busy}
          onClick={() => onDetect(scope)}
        >
          {detecting ? <span className="spinner small" /> : <Icon name="sparkles" size={15} />}
          {detecting ? 'Analyzing images…' : 'Find abnormalities'}
        </button>
        <p>
          {vision?.configured
            ? 'Automated suggestions are drafts. Confirm or reject each one; sizes are measured by AliAtlas from the scan.'
            : vision?.message}
        </p>
      </div>
      <div className="findings-summary">
        <span>
          {list.length} {list.length === 1 ? 'finding' : 'findings'}
        </span>
        {pending > 0 && <span className="pending-badge">{pending} to review</span>}
      </div>
      <ol className="findings-list">
        {list.map((f, i) => (
          <li key={f.id}>
            <button
              className={`finding-item ${f.id === selectedId ? 'active' : ''} ${f.status}`}
              onClick={() => onSelect(f)}
              aria-label={`Select ${f.label}`}
            >
              <span className="finding-number">{i + 1}</span>
              <span className="finding-text">
                <b>{f.label}</b>
                <small>
                  {categoryName(f.category)} · Image {indexOf(f.frameId) + 1}
                </small>
              </span>
              <span className="finding-size mono">{summary(f)}</span>
              {f.status === 'unreviewed' && (
                <span className="finding-flag">
                  AUTO{f.confidence != null ? ` ${Math.round(f.confidence * 100)}%` : ''}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {!list.length && (
        <p className="findings-empty">
          No findings yet. Use <b>Measure lesion</b> to drag across a lesion&apos;s longest
          diameter, <b>HU</b> to measure density, or use Find abnormalities.
        </p>
      )}
      {rejected.length > 0 && (
        <p className="findings-rejected">{rejected.length} rejected suggestion(s) hidden.</p>
      )}
      {selected && selected.status !== 'rejected' && (
        <div className="finding-detail">
          <b>{selected.label}</b>
          <p>
            {categoryName(selected.category)}
            {selected.source === 'ai' ? ' · auto-detected' : ''}
          </p>
          <dl className="finding-measures">
            {selected.longMm != null && (
              <>
                <dt>Size</dt>
                <dd className="mono">
                  {formatSize(selected, { approx })}
                  <small>{axesLabel(selected)}</small>
                </dd>
              </>
            )}
            {selected.longMm != null && (
              <>
                <dt>Height</dt>
                <dd>
                  {selected.ccMm != null ? (
                    <span className="mono">
                      {approx ? '≈ ' : ''}
                      {selected.ccMm.toFixed(1)} mm
                      <small>
                        images {indexOf(selected.extent.firstFrameId) + 1}–
                        {indexOf(selected.extent.lastFrameId) + 1} · {selected.extentSlices} slices
                      </small>
                    </span>
                  ) : (
                    <small>Mark the lesion&apos;s top and bottom slice</small>
                  )}
                  <span className="extent-actions">
                    <button
                      className="text-button accent"
                      disabled={busy || !frame}
                      onClick={() => onMarkExtent(selected, 'first')}
                    >
                      Top = this image
                    </button>
                    <button
                      className="text-button accent"
                      disabled={busy || !frame}
                      onClick={() => onMarkExtent(selected, 'last')}
                    >
                      Bottom = this image
                    </button>
                    {selected.extent && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => onClear(selected, 'extent')}
                      >
                        Clear
                      </button>
                    )}
                  </span>
                </dd>
              </>
            )}
            {selected.volumeMl != null && (
              <>
                <dt>Volume</dt>
                <dd className="mono">
                  {formatVolume(selected, { approx })}
                  <small>ellipsoid π/6 × L × W × H</small>
                </dd>
              </>
            )}
            <dt>Density</dt>
            <dd>
              {selected.roi?.stats ? (
                <span className="mono">
                  {formatHu(selected.roi.stats)}
                  <small>
                    range {selected.roi.stats.min} to {selected.roi.stats.max} HU
                    {selected.roi.stats.areaMm2 != null
                      ? ` · ${(selected.roi.stats.areaMm2 / 100).toFixed(2)} cm²`
                      : ''}
                  </small>
                  <small className="density-hint">
                    {densityHint(selected.roi.stats.mean, enhanced, selected.roi.stats)}
                  </small>
                </span>
              ) : (
                <small>
                  Select <b>HU</b> and drag a circle inside the lesion on its image
                </small>
              )}
              {selected.roi && (
                <span className="extent-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => onClear(selected, 'roi')}
                  >
                    Remove density
                  </button>
                </span>
              )}
            </dd>
          </dl>
          {selected.note && <p className="finding-note">{selected.note}</p>}
          {selected.status === 'unreviewed' && selected.frameId !== frame?.id && (
            <p className="finding-note">Go to this image to review it.</p>
          )}
          <div className="annotation-actions">
            {selected.status === 'unreviewed' && (
              <>
                <button
                  className="primary-button"
                  disabled={busy || selected.frameId !== frame?.id}
                  onClick={() => onReview(selected, 'confirmed')}
                >
                  <Icon name="check" size={14} />
                  Confirm
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onReview(selected, 'rejected')}
                >
                  Reject
                </button>
              </>
            )}
            <button className="secondary-button" disabled={busy} onClick={() => onEdit(selected)}>
              Edit
            </button>
            {selected.status === 'confirmed' && (
              <button
                className="secondary-button"
                disabled={busy || selected.frameId !== frame?.id}
                title={
                  selected.frameId !== frame?.id
                    ? 'Go to this finding’s image first'
                    : 'Save the current view as the report key image'
                }
                onClick={() => onKeyImage(selected)}
              >
                Update key image
              </button>
            )}
            <button
              className="icon-button"
              disabled={busy}
              onClick={() => onDelete(selected)}
              aria-label="Delete finding"
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
