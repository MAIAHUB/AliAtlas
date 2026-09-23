'use client';
import { useEffect, useState } from 'react';
import Icon from './Icon.js';
import { categoryName, formatSize, formatVolume } from '../lib/measure.js';
import { approximateSizes } from '../lib/contrast.js';
import { formatHu } from '../lib/roi.js';

const SECTIONS = [
  { key: 'clinicalHistory', title: 'Clinical history', rows: 2 },
  { key: 'technique', title: 'Technique', rows: 2 },
  { key: 'findingsText', title: 'Findings', rows: 7 },
  { key: 'impression', title: 'Impression', rows: 3 },
  { key: 'limitations', title: 'Limitations', rows: 2 },
  { key: 'recommendation', title: 'Recommendation', rows: 2 },
];

function KeyImage({ studyId, finding }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="muted">—</span>;
  return (
    <img
      src={`/api/studies/${studyId}/findings/${finding.id}/image`}
      alt={`Key image for ${finding.label}`}
      onError={() => setMissing(true)}
    />
  );
}

// Structured radiology report for a study. Findings text can be generated from the
// confirmed measurements; finalizing is blocked until every AI suggestion is reviewed.
export default function ReportEditor({ study, findings, api, onClose, onError }) {
  const [report, setReport] = useState(null),
    [draft, setDraft] = useState(null),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(null);
  useEffect(() => {
    let alive = true;
    api(`/api/studies/${study.id}/report`)
      .then((r) => {
        if (!alive) return;
        setReport(r);
        setDraft({
          reportType: r.reportType,
          clinicalHistory: r.clinicalHistory,
          technique: r.technique,
          findingsText: r.findingsText || r.suggestedFindings,
          impression: r.impression,
          limitations: r.limitations,
          recommendation: r.recommendation,
        });
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [study.id]);
  const final = report?.status === 'final';
  const pending = findings.filter((f) => f.status === 'unreviewed').length;
  const measured = findings
    .filter((f) => f.status === 'confirmed')
    .map((f) => {
      const series = study.series.find((s) => s.id === f.seriesId);
      return {
        f,
        series,
        approx: series ? approximateSizes(series) : true,
        index: series?.frames.findIndex((x) => x.id === f.frameId) ?? -1,
      };
    })
    .sort((a, b) => a.index - b.index);
  async function save(status) {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api(`/api/studies/${study.id}/report`, {
        method: 'PUT',
        body: status === 'draft' ? { status } : { ...draft, ...(status ? { status } : {}) },
      });
      setReport({ ...report, ...next });
      setMessage({
        error: false,
        text:
          status === 'final'
            ? 'Report finalized.'
            : status === 'draft'
              ? 'Report reopened for editing.'
              : 'Draft saved.',
      });
    } catch (e) {
      setMessage({ error: true, text: e.message });
    } finally {
      setSaving(false);
    }
  }
  if (!draft) return <p className="archive-empty">Loading report…</p>;
  return (
    <div className="report-editor">
      <div className={`report-status ${final ? 'final' : ''}`}>
        <Icon name={final ? 'check' : 'report'} size={15} />
        {final
          ? `Final · ${report.finalizedBy?.name || ''} · ${new Date(report.finalizedAt).toLocaleString()}`
          : `Draft${report.updatedAt ? ` · saved ${new Date(report.updatedAt).toLocaleString()}` : ''}`}
      </div>
      <div className="report-type">
        <label className="field-label" htmlFor="report-type">
          Report type
        </label>
        <select
          id="report-type"
          value={draft.reportType}
          disabled={final}
          onChange={(e) => setDraft({ ...draft, reportType: e.target.value })}
        >
          <option value="screening">Screening report</option>
          <option value="diagnostic" disabled={!report.canDiagnose}>
            Diagnostic report{report.canDiagnose ? '' : ' (needs a contrast-enhanced series)'}
          </option>
        </select>
        {!report.canDiagnose && (
          <p className="form-hint">
            Plain CT: suitable for screening and teaching. Lesion margins and enhancement cannot be
            assessed, so sizes are approximate. Set the contrast phase in Findings if this series
            was enhanced.
          </p>
        )}
      </div>
      {SECTIONS.map((section) => (
        <div className="report-section" key={section.key}>
          <div className="report-section-heading">
            <label className="field-label" htmlFor={`report-${section.key}`}>
              {section.title}
            </label>
            {section.key === 'findingsText' && !final && (
              <button
                className="text-button accent"
                onClick={() => setDraft({ ...draft, findingsText: report.suggestedFindings })}
              >
                Insert measured findings
              </button>
            )}
          </div>
          <textarea
            id={`report-${section.key}`}
            className="form-input"
            rows={section.rows}
            readOnly={final}
            value={draft[section.key]}
            onChange={(e) => setDraft({ ...draft, [section.key]: e.target.value })}
          />
        </div>
      ))}
      <h3 className="report-subheading">Measured lesions</h3>
      {measured.length ? (
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Finding</th>
                <th>Image</th>
                <th>Size</th>
                <th>Density</th>
                <th>Key image</th>
              </tr>
            </thead>
            <tbody>
              {measured.map(({ f, index, approx }, i) => (
                <tr key={f.id}>
                  <td>{i + 1}</td>
                  <td>
                    <b>{f.label}</b>
                    <small>{categoryName(f.category)}</small>
                  </td>
                  <td className="mono">{index + 1}</td>
                  <td className="mono">
                    {formatSize(f, { approx })}
                    {formatVolume(f, { approx }) && <small>{formatVolume(f, { approx })}</small>}
                  </td>
                  <td className="mono">{f.roi?.stats ? formatHu(f.roi.stats) : '—'}</td>
                  <td>
                    <KeyImage studyId={study.id} finding={f} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="findings-empty">No confirmed measurements yet.</p>
      )}
      {pending > 0 && !final && (
        <p className="form-error">
          {pending} AI suggestion{pending === 1 ? '' : 's'} still need review before this report can
          be finalized.
        </p>
      )}
      {message && (
        <p className={message.error ? 'form-error' : 'form-hint'} role="status">
          {message.text}
        </p>
      )}
      <p className="form-hint">
        Educational workspace. AI suggestions are not a diagnosis; a qualified reader is responsible
        for the final report.
      </p>
      <div className="modal-actions">
        <button className="text-button" onClick={onClose} disabled={saving}>
          Close
        </button>
        <button
          className="secondary-button"
          onClick={() => window.open(`/report/${study.id}`, '_blank', 'noopener')}
        >
          <Icon name="download" size={15} />
          Print / PDF
        </button>
        {final ? (
          <button className="secondary-button" disabled={saving} onClick={() => save('draft')}>
            Reopen
          </button>
        ) : (
          <>
            <button className="secondary-button" disabled={saving} onClick={() => save()}>
              Save draft
            </button>
            <button
              className="primary-button"
              disabled={saving || pending > 0 || !draft.impression.trim()}
              onClick={() => save('final')}
              title={pending ? 'Review every AI suggestion first' : undefined}
            >
              <Icon name="check" size={15} />
              Finalize
            </button>
          </>
        )}
      </div>
    </div>
  );
}
