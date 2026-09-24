'use client';
import { useEffect, useState } from 'react';
import Icon from './Icon.js';
import { categoryName, formatSize, formatVolume } from '../lib/measure.js';
import { approximateSizes } from '../lib/contrast.js';
import { formatHu } from '../lib/roi.js';

const SECTIONS = [
  { key: 'clinicalHistory', title: 'Clinical history', rows: 2 },
  { key: 'technique', title: 'Technique', rows: 2 },
  { key: 'findingsText', title: 'Findings', rows: 6 },
  { key: 'impression', title: 'Impression', rows: 4 },
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
// confirmed measurements; finalizing is blocked until every automated suggestion is reviewed.
export default function ReportEditor({ study, findings, api, onClose, onError }) {
  const [report, setReport] = useState(null),
    [draft, setDraft] = useState(null),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(null),
    [generating, setGenerating] = useState(false);
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
      const saved = { final: 'Report finalized.', draft: 'Report reopened for editing.' };
      setMessage({ error: false, text: saved[status] || 'Draft saved.' });
      return true;
    } catch (e) {
      setMessage({ error: true, text: e.message });
      return false;
    } finally {
      setSaving(false);
    }
  }
  // Fills every section from the measurements; the drafting service writes the narrative.
  async function autoGenerate() {
    // Ask only when the reader has typed something: text that matches the saved report or
    // the automatic findings would simply be regenerated.
    const written = ['findingsText', 'impression', 'limitations', 'recommendation'].some(
      (k) =>
        draft[k]?.trim() &&
        draft[k] !== report[k] &&
        !(k === 'findingsText' && draft[k] === report.suggestedFindings),
    );
    if (
      written &&
      !window.confirm('Replace the findings, impression, limitations and recommendation?')
    )
      return;
    setGenerating(true);
    setMessage(null);
    try {
      const generated = await api(`/api/studies/${study.id}/report/generate`, { method: 'POST' });
      setDraft({
        ...draft,
        reportType: generated.reportType,
        clinicalHistory: draft.clinicalHistory?.trim()
          ? draft.clinicalHistory
          : generated.clinicalHistory,
        technique: generated.technique,
        findingsText: generated.findingsText,
        impression: generated.impression,
        limitations: generated.limitations,
        recommendation: generated.recommendation,
      });
      const source =
        generated.impressionSource === 'template'
          ? 'Report generated from the measurements (templates).'
          : 'Findings, impression, limitations and recommendation drafted automatically; technique from the DICOM.';
      const history = draft.clinicalHistory?.trim()
        ? ''
        : ' Add the clinical history: it cannot be known from the images.';
      setMessage({
        error: Boolean(generated.note),
        text: `${source}${history} Review every section before saving.${generated.note ? ` ${generated.note}` : ''}`,
      });
    } catch (e) {
      setMessage({ error: true, text: e.message });
    } finally {
      setGenerating(false);
    }
  }
  // Saves the current text first so the PDF matches what is on screen.
  async function downloadPdf() {
    if (!final && !(await save())) return;
    setGenerating(true);
    try {
      const response = await fetch(`/api/studies/${study.id}/report/pdf`);
      if (!response.ok) throw new Error((await response.json()).error || 'PDF failed.');
      const name =
        /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] ||
        'AliAtlas-CT-report.pdf';
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage({ error: false, text: `Downloaded ${name}.` });
    } catch (e) {
      setMessage({ error: true, text: e.message });
    } finally {
      setGenerating(false);
    }
  }
  if (!draft) return <p className="archive-empty">Loading report…</p>;
  return (
    <div className="report-editor">
      <div className="report-toolbar">
        <div className={`report-status ${final ? 'final' : ''}`}>
          <Icon name={final ? 'check' : 'report'} size={15} />
          {final
            ? `Final · ${report.finalizedBy?.name || ''} · ${new Date(report.finalizedAt).toLocaleString()}`
            : `Draft${report.updatedAt ? ` · saved ${new Date(report.updatedAt).toLocaleString()}` : ''}`}
        </div>
        <button
          className="primary-button"
          disabled={final || saving || generating}
          onClick={autoGenerate}
          title={final ? 'This report is final. Click Reopen to regenerate it.' : undefined}
        >
          {generating ? <span className="spinner small" /> : <Icon name="sparkles" size={15} />}
          {generating ? 'Writing report…' : 'Auto-generate report'}
        </button>
      </div>
      {final && (
        <p className="form-hint">
          This report is final and locked. Click <b>Reopen</b> below to edit it or regenerate it
          automatically.
        </p>
      )}
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
          {pending} automated suggestion{pending === 1 ? '' : 's'} still need review before this
          report can be finalized.
        </p>
      )}
      {message && (
        <p className={message.error ? 'form-error' : 'form-hint'} role="status">
          {message.text}
        </p>
      )}
      <p className="form-hint">
        Educational workspace. Automated suggestions and drafts are not a diagnosis; a qualified
        reader is responsible for the final report.
      </p>
      <div className="modal-actions">
        <button className="text-button" onClick={onClose} disabled={saving}>
          Close
        </button>
        <button
          className="text-button"
          onClick={() => window.open(`/report/${study.id}`, '_blank', 'noopener')}
        >
          Print view
        </button>
        <button className="secondary-button" disabled={saving || generating} onClick={downloadPdf}>
          <Icon name="download" size={15} />
          Download PDF
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
              title={pending ? 'Review every automated suggestion first' : undefined}
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
