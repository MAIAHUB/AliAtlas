'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import DicomViewer from './DicomViewer.js';
import Icon from './Icon.js';
import {
  COLORS,
  REGIONS,
  PRESETS,
  MANUAL_LABELS,
  regionForSeries,
  structureCategory,
} from '../lib/catalog.js';
import { clamp } from '../lib/geometry.js';
import { jobTiming, formatDuration } from '../lib/job-timing.js';
import { FINDING_CATEGORIES, formatSize, lineLength } from '../lib/measure.js';
import { classifyPhase, approximateSizes } from '../lib/contrast.js';
import { formatHu } from '../lib/roi.js';
import FindingsPanel from './FindingsPanel.js';
import ReportEditor from './ReportEditor.js';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body
      ? { 'Content-Type': 'application/json', ...options.headers }
      : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) signedOut();
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request failed.');
  return body;
}
function signedOut() {
  window.location.replace('/login');
  throw new Error('Your session has ended. Sign in again.');
}
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
function saveFile(content, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Modal({ title, subtitle, onClose, children, wide = false, locked = false }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={locked}
          aria-label="Close dialog"
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Tool({ icon, children, active, onClick, disabled, title }) {
  return (
    <button
      className={`tool ${active ? 'active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <Icon name={icon} size={16} />
      {children}
    </button>
  );
}

// Live clock for an anatomy job: elapsed, remaining, and time per model step.
function JobTimer({ job }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  const active = ['queued', 'running'].includes(job.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const t = jobTiming(job, now);
  const failed = job.status === 'failed';
  return (
    <div className={`job-timer ${job.status}`} role="status" aria-label="Anatomy job timing">
      {job.status === 'queued' ? (
        <div className="job-clock">
          <div>
            <small>Waiting for worker</small>
            <b className="mono">{formatDuration(t.queued)}</b>
          </div>
        </div>
      ) : t.finished ? (
        <div className="job-clock">
          <div>
            <small>{failed ? 'Stopped after' : 'Total time'}</small>
            <b className="mono">{formatDuration(t.elapsed)}</b>
          </div>
          <div>
            <small>Finished at</small>
            <b className="mono">
              {job.finishedAt
                ? new Date(job.finishedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '—'}
            </b>
          </div>
        </div>
      ) : (
        <div className="job-clock">
          <div>
            <small>Elapsed</small>
            <b className="mono">{formatDuration(t.elapsed)}</b>
          </div>
          <div>
            <small>Remaining</small>
            <b className="mono">
              {t.remaining != null ? `~${formatDuration(t.remaining)}` : 'Learning'}
            </b>
          </div>
        </div>
      )}
      {!t.finished && <progress value={t.progress} max="100" />}
      <p className={failed ? 'job-error' : ''}>
        {job.message}
        {job.status === 'completed' && job.device ? ` · ${job.device.toUpperCase()}` : ''}
      </p>
      {t.remaining == null && job.status === 'running' && (
        <p className="job-hint">
          First run on this machine: time estimates appear once each model step has run once.
        </p>
      )}
      {t.steps.length > 0 && (
        <ol className="job-steps">
          {t.steps.map((step) => (
            <li key={step.id} className={step.state}>
              <i aria-hidden="true" />
              <span>{step.label}</span>
              <span className="mono">
                {step.state === 'pending'
                  ? step.estimateSeconds != null
                    ? `~${formatDuration(step.estimateSeconds)}`
                    : ''
                  : formatDuration(step.seconds)}
                {step.state === 'running' && step.estimateSeconds != null
                  ? ` / ~${formatDuration(step.estimateSeconds)}`
                  : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
      {t.queued >= 1 && job.startedAt && (
        <p className="job-hint">Queued for {formatDuration(t.queued)} before starting.</p>
      )}
    </div>
  );
}

export default function AtlasWorkspace({ user }) {
  const [studies, setStudies] = useState([]),
    [study, setStudy] = useState(null),
    [seriesId, setSeriesId] = useState(''),
    [index, setIndex] = useState(0);
  const [records, setRecords] = useState([]),
    [jobs, setJobs] = useState([]),
    [ai, setAi] = useState({ ready: false }),
    [archive, setArchive] = useState({ enabled: false }),
    [importSource, setImportSource] = useState('upload'),
    [archived, setArchived] = useState(null),
    [openingArchive, setOpeningArchive] = useState(null),
    [initialized, setInitialized] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [mode, setMode] = useState('scroll'),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState([0, 0]),
    [windowing, setWindowing] = useState({ width: 350, center: 40 }),
    [invert, setInvert] = useState(false);
  const [showLabels, setShowLabels] = useState(true),
    [selectedId, setSelectedId] = useState(null),
    [query, setQuery] = useState(''),
    [scope, setScope] = useState('slice'),
    [category, setCategory] = useState('all');
  const [region, setRegion] = useState('headneck'),
    [playing, setPlaying] = useState(false),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null),
    [files, setFiles] = useState([]),
    [uploadProgress, setUploadProgress] = useState(null),
    [dragOver, setDragOver] = useState(false),
    [draft, setDraft] = useState(null),
    [labelError, setLabelError] = useState('');
  const [sideOpen, setSideOpen] = useState(true);
  const [findings, setFindings] = useState([]),
    [panel, setPanel] = useState('structures'),
    [selectedFindingId, setSelectedFindingId] = useState(null),
    [measureDraft, setMeasureDraft] = useState(null),
    [findingForm, setFindingForm] = useState(null),
    [findingError, setFindingError] = useState(''),
    [detecting, setDetecting] = useState(false),
    [vision, setVision] = useState({ configured: false });
  const fileInput = useRef(null),
    folderInput = useRef(null),
    annotationInput = useRef(null),
    viewer = useRef(null),
    sequence = useRef(0),
    currentStudy = useRef(null),
    keyState = useRef({}),
    annotationRevision = useRef(0);
  currentStudy.current = study?.id;
  const series = study?.series.find((s) => s.id === seriesId),
    frame = series?.frames[index];
  const frameLabels = useMemo(
    () => records.filter((r) => r.seriesId === seriesId && r.frameId === frame?.id),
    [records, seriesId, frame?.id],
  );
  const visibleLabels = useMemo(
    () =>
      frameLabels.filter(
        (r) =>
          category === 'all' ||
          structureCategory(r.structure || r.label.toLowerCase()) === category,
      ),
    [frameLabels, category],
  );
  const structureList = useMemo(
    () =>
      records
        .filter(
          (r) =>
            r.seriesId === seriesId &&
            (scope === 'series' || r.frameId === frame?.id) &&
            (category === 'all' ||
              structureCategory(r.structure || r.label.toLowerCase()) === category) &&
            r.label.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => a.label.localeCompare(b.label)),
    [records, seriesId, frame?.id, scope, query, category],
  );
  const selected = records.find((r) => r.id === selectedId),
    activeJob = jobs.find((j) => j.seriesId === seriesId),
    busyJob = activeJob && ['queued', 'running'].includes(activeJob.status);
  const preset =
    PRESETS.find((p) => p.width === windowing.width && p.center === windowing.center)?.id ||
    'custom';
  const labeledSlices = new Set(
    records.filter((r) => r.seriesId === seriesId).map((r) => r.frameId),
  ).size;
  const fail = (e) => setNotice({ type: 'error', message: e.message });
  function applyAnnotations(result, id) {
    if (currentStudy.current === id && result.revision >= annotationRevision.current) {
      annotationRevision.current = result.revision;
      setRecords(result.records);
    }
  }
  function resetView() {
    setPan([0, 0]);
    setZoom(1);
    setInvert(false);
    setWindowing(
      frame ? { width: frame.windowWidth, center: frame.windowCenter } : { width: 350, center: 40 },
    );
  }
  function changeSlice(next) {
    setIndex(clamp(next, 0, (series?.frames.length || 1) - 1));
    setSelectedId(null);
  }
  function changeSeries(id, sourceStudy = study) {
    const next = sourceStudy.series.find((s) => s.id === id);
    setSeriesId(id);
    setIndex(Math.floor(next.frames.length / 2));
    setSelectedId(null);
    setPan([0, 0]);
    setZoom(1);
    setInvert(false);
    setPlaying(false);
    setWindowing({ width: next.frames[0].windowWidth, center: next.frames[0].windowCenter });
  }
  async function openStudy(id) {
    const run = ++sequence.current;
    setLoading(true);
    setPlaying(false);
    setStudy(null);
    setRecords([]);
    setJobs([]);
    setSelectedId(null);
    setFindings([]);
    setSelectedFindingId(null);
    setMeasureDraft(null);
    try {
      const [next, annotations, jobResult, findingResult] = await Promise.all([
        api(`/api/studies/${id}`),
        api(`/api/studies/${id}/annotations`),
        api(`/api/studies/${id}/jobs`),
        api(`/api/studies/${id}/findings`),
      ]);
      if (run !== sequence.current) return;
      setStudy(next);
      setFindings(findingResult.records);
      annotationRevision.current = annotations.revision;
      setRecords(annotations.records);
      setJobs(jobResult.jobs);
      const first = [...next.series].sort(
        (a, b) =>
          (/LOCALIZER|SCOUT/.test(a.imageType) ? 1 : 0) -
            (/LOCALIZER|SCOUT/.test(b.imageType) ? 1 : 0) ||
          Number(!!a.segmentationIssue) - Number(!!b.segmentationIssue) ||
          b.frames.length - a.frames.length,
      )[0];
      changeSeries(first.id, next);
      setRegion(regionForSeries(first));
    } catch (e) {
      if (run === sequence.current) fail(e);
    } finally {
      if (run === sequence.current) setLoading(false);
    }
  }
  async function refreshWorkspace() {
    const workspace = await api('/api/workspace');
    setStudies(workspace.studies);
    setAi(workspace.ai);
    setArchive(workspace.archive);
    setVision(workspace.vision);
    setInitialized(true);
    return workspace;
  }
  useEffect(() => {
    if (window.matchMedia('(max-width: 700px)').matches) setSideOpen(false);
  }, []);
  useEffect(() => {
    let alive = true;
    api('/api/workspace')
      .then((w) => {
        if (!alive) return;
        setStudies(w.studies);
        setAi(w.ai);
        setArchive(w.archive);
        setVision(w.vision);
        setInitialized(true);
        if (w.studies[0]) openStudy(w.studies[0].id);
      })
      .catch(fail);
    return () => {
      alive = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    const id = study?.id;
    if (!id) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const [nextJobs, workspace, annotations] = await Promise.all([
          api(`/api/studies/${id}/jobs`),
          api('/api/workspace'),
          api(`/api/studies/${id}/annotations`),
        ]);
        if (!alive || currentStudy.current !== id) return;
        setJobs(nextJobs.jobs);
        setAi(workspace.ai);
        applyAnnotations(annotations, id);
      } catch {
        /* Foreground operations report errors; a temporary poll failure must not interrupt viewing. */
      }
    }, 3500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [study?.id]);
  useEffect(() => {
    if (!playing || !series) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % series.frames.length), 160);
    return () => clearInterval(timer);
  }, [playing, series]);
  keyState.current = {
    frame,
    series,
    index,
    modal,
    zoom,
    playing,
    showLabels,
    changeSlice,
    resetView,
  };
  useEffect(() => {
    const handler = (e) => {
      if (e.defaultPrevented || (e.key === ' ' && e.target.closest('button,a,[role=button]')))
        return;
      if (
        e.target.closest('input,select,textarea,dialog,[contenteditable=true]') ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      const k = keyState.current;
      if (!k.frame || k.modal) return;
      const key = e.key.toLowerCase();
      if (
        [
          'arrowup',
          'arrowright',
          'arrowdown',
          'arrowleft',
          ' ',
          '+',
          '=',
          '-',
          's',
          'p',
          'w',
          'a',
          'r',
          'l',
          'm',
          'h',
        ].includes(key)
      )
        e.preventDefault();
      if (['arrowup', 'arrowright'].includes(key)) k.changeSlice(k.index + 1);
      if (['arrowdown', 'arrowleft'].includes(key)) k.changeSlice(k.index - 1);
      if (key === ' ') setPlaying(!k.playing);
      if (key === 's') setMode('scroll');
      if (key === 'p') setMode('pan');
      if (key === 'w') setMode('window');
      if (key === 'a') setMode('label');
      if (key === 'm') setMode('measure');
      if (key === 'h') setMode('roi');
      if (key === 'escape') setMeasureDraft(null);
      if (key === 'r') k.resetView();
      if (key === 'l') setShowLabels(!k.showLabels);
      if (key === '+' || key === '=') setZoom(clamp(k.zoom * 1.2, 0.25, 8));
      if (key === '-') setZoom(clamp(k.zoom / 1.2, 0.25, 8));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const frameFindings = findings.filter((f) => f.frameId === frame?.id);
  const phase = series ? classifyPhase(series) : null,
    approx = series ? approximateSizes(series) : false;
  function findingSummary(form) {
    const size =
      form.id || !form.long
        ? form
        : {
            longMm: lineLength(frame, form.long).value,
            shortMm: lineLength(frame, form.short)?.value ?? null,
            unit: lineLength(frame, form.long).unit,
          };
    const parts = [];
    if (size.longMm != null) parts.push(`Size ${formatSize(size, { approx })}`);
    if (form.roi?.stats) parts.push(`Density ${formatHu(form.roi.stats)}`);
    parts.push(approx ? 'plain CT: sizes are approximate' : 'measured from the scan');
    return parts.join(' · ');
  }
  async function patchFinding(body) {
    const result = await api(`/api/studies/${study.id}/findings`, { method: 'PATCH', body });
    setFindings(result.records);
    return result.records.find((f) => f.id === body.id);
  }
  // A density circle is added to the selected finding on this slice, or starts a new one.
  async function measuredRoi(roi) {
    const target = findings.find((f) => f.id === selectedFindingId && f.frameId === frame.id);
    if (!target) {
      openFindingForm({
        seriesId,
        frameId: frame.id,
        long: null,
        short: null,
        roi,
        category: 'other',
      });
      return;
    }
    setSaving(true);
    try {
      const updated = await patchFinding({
        id: target.id,
        roi: { center: roi.center, radius: roi.radius },
      });
      setMode('scroll');
      setNotice({
        type: 'success',
        message: `Density added to ${updated.label}: ${formatHu(updated.roi.stats)}.`,
      });
      await storeKeyImage(updated);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  // Top and bottom slice of a lesion give its craniocaudal size; the other end
  // defaults to the slice where the lesion was measured.
  async function markExtent(finding, edge) {
    const other =
      edge === 'first'
        ? finding.extent?.lastFrameId || finding.frameId
        : finding.extent?.firstFrameId || finding.frameId;
    setSaving(true);
    try {
      await patchFinding({
        id: finding.id,
        extent:
          edge === 'first'
            ? { firstFrameId: frame.id, lastFrameId: other }
            : { firstFrameId: other, lastFrameId: frame.id },
      });
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function clearFindingPart(finding, part) {
    setSaving(true);
    try {
      await patchFinding({ id: finding.id, [part]: null });
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function setPhase(next) {
    setSaving(true);
    try {
      const updated = await api(`/api/studies/${study.id}`, {
        method: 'PATCH',
        body: { seriesId, phase: next },
      });
      setStudy(updated);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  function startMeasure() {
    setPlaying(false);
    setMeasureDraft(null);
    setMode('measure');
    setPanel('findings');
  }
  function openFindingForm(draft) {
    setFindingError('');
    setFindingForm({
      label: `Lesion ${findings.filter((f) => f.status !== 'rejected').length + 1}`,
      category: 'mass',
      note: '',
      ...draft,
    });
    setModal('finding');
  }
  // First drag = long axis, second drag = short axis, then name the finding.
  function measured(line) {
    if (!measureDraft || measureDraft.frameId !== frame.id)
      setMeasureDraft({ seriesId, frameId: frame.id, long: line, short: null });
    else {
      const draft = { ...measureDraft, short: line };
      setMeasureDraft(draft);
      openFindingForm(draft);
    }
  }
  async function storeKeyImage(finding) {
    try {
      const blob = await viewer.current?.captureFinding(finding);
      if (!blob) return;
      await fetch(`/api/studies/${study.id}/findings/${finding.id}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
    } catch {
      /* The report shows a dash when a key image is missing; the finding itself is saved. */
    }
  }
  async function saveFinding(e) {
    e.preventDefault();
    setSaving(true);
    setFindingError('');
    try {
      let saved;
      if (findingForm.id) {
        const result = await api(`/api/studies/${study.id}/findings`, {
          method: 'PATCH',
          body: {
            id: findingForm.id,
            label: findingForm.label,
            category: findingForm.category,
            note: findingForm.note,
          },
        });
        setFindings(result.records);
        saved = result.records.find((f) => f.id === findingForm.id);
      } else {
        const result = await api(`/api/studies/${study.id}/findings`, {
          method: 'POST',
          body: findingForm,
        });
        setFindings(result.records);
        saved = result.created;
        setMeasureDraft(null);
        setMode('scroll');
      }
      setModal(null);
      setSelectedFindingId(saved.id);
      setPanel('findings');
      if (saved.status === 'confirmed') await storeKeyImage(saved);
    } catch (err) {
      setFindingError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function reviewFinding(finding, status) {
    setSaving(true);
    try {
      const result = await api(`/api/studies/${study.id}/findings`, {
        method: 'PATCH',
        body: { id: finding.id, status },
      });
      setFindings(result.records);
      const updated = result.records.find((f) => f.id === finding.id);
      if (status === 'confirmed') await storeKeyImage(updated);
      else setSelectedFindingId(null);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function deleteFinding(finding) {
    if (!window.confirm(`Delete "${finding.label}"?`)) return;
    setSaving(true);
    try {
      const result = await api(`/api/studies/${study.id}/findings`, {
        method: 'DELETE',
        body: { id: finding.id },
      });
      setFindings(result.records);
      setSelectedFindingId(null);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  function selectFinding(finding) {
    setSelectedFindingId(finding.id);
    const target = series?.frames.findIndex((f) => f.id === finding.frameId);
    if (target >= 0) setIndex(target);
  }
  function detectFrames(scope) {
    const frames = series.frames;
    if (scope === 'slice') return [frame.id];
    if (scope === 'around')
      return frames
        .slice(Math.max(0, index - 7), Math.min(frames.length, index + 8))
        .map((f) => f.id);
    const count = Math.min(16, frames.length);
    return [
      ...new Set(
        Array.from(
          { length: count },
          (_, i) => frames[Math.round((i * (frames.length - 1)) / Math.max(1, count - 1))].id,
        ),
      ),
    ];
  }
  async function detect(scope) {
    setDetecting(true);
    setNotice(null);
    try {
      const result = await api(`/api/studies/${study.id}/analyze`, {
        method: 'POST',
        body: { seriesId, frameIds: detectFrames(scope), window: windowing },
      });
      setFindings(result.records);
      const first = result.records.find((f) => f.id === result.created[0]);
      if (first) selectFinding(first);
      setNotice({
        type: result.created.length ? 'warning' : 'success',
        message: `b.ai ${result.created.length ? `suggested ${result.created.length} possible abnormalit${result.created.length === 1 ? 'y' : 'ies'}` : 'found no abnormality'} in ${result.seconds}s.${result.summary ? ` ${result.summary}` : ''}${result.created.length ? ' Review each suggestion before reporting.' : ''}`,
      });
    } catch (e) {
      fail(e);
    } finally {
      setDetecting(false);
    }
  }
  function startImport() {
    setPlaying(false);
    setFiles([]);
    setUploadProgress(null);
    setImportSource('upload');
    setModal('import');
  }
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.replace('/login');
  }
  async function showArchive() {
    setImportSource('archive');
    setArchived(null);
    try {
      setArchived((await api('/api/orthanc/studies')).studies);
    } catch (e) {
      setArchived([]);
      fail(e);
    }
  }
  async function openArchived(orthancStudyId) {
    setOpeningArchive(orthancStudyId);
    setNotice(null);
    try {
      const result = await api('/api/orthanc/studies/import', {
        method: 'POST',
        body: { orthancStudyId },
      });
      await finishImport(result);
    } catch (e) {
      fail(e);
    } finally {
      setOpeningArchive(null);
    }
  }
  async function finishImport(result) {
    setModal(null);
    await refreshWorkspace();
    await openStudy(result.studies[0].id);
    const auto = result.autoLabels?.find((item) => item.studyId === result.studies[0].id);
    setNotice({
      type: result.skipped || (auto && auto.status !== 'queued') ? 'warning' : 'success',
      message: `Imported ${result.importedFrames} CT frames across ${result.studies.length} ${result.studies.length === 1 ? 'study' : 'studies'}.${result.archive ? ' Archived in Orthanc.' : ''}${result.skipped ? ` ${result.skipped} files skipped. ${result.warnings.join(' ')}` : ''}${auto?.status === 'queued' ? ' Automatic labels are generating in the background.' : auto ? ` ${auto.message}` : ''}`,
    });
  }
  async function upload() {
    if (!files.length) return;
    setUploadProgress(0);
    setNotice(null);
    try {
      const data = new FormData();
      for (const file of files) data.append('files', file, file.name);
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/studies/import');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status === 401) {
            window.location.replace('/login');
            return reject(new Error('Your session has ended. Sign in again.'));
          }
          try {
            const body = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error(body.error || 'Upload failed.'));
          } catch {
            reject(new Error('The upload server returned an unreadable response.'));
          }
        };
        xhr.onerror = () =>
          reject(
            new Error(
              'The upload connection was interrupted. Check your connection and try again.',
            ),
          );
        xhr.send(data);
      });
      await finishImport(result);
    } catch (e) {
      fail(e);
    } finally {
      setUploadProgress(null);
    }
  }
  function addLabel(pixel) {
    setPlaying(false);
    setLabelError('');
    setDraft({
      seriesId,
      frameId: frame.id,
      pixel,
      label: '',
      side: pixel[0] < frame.columns / 2 ? 'left' : 'right',
      color: COLORS.organ,
    });
    setModal('label');
  }
  function editLabel() {
    setPlaying(false);
    setLabelError('');
    setDraft({ ...selected });
    setModal('label');
  }
  async function submitLabel(e) {
    e.preventDefault();
    setSaving(true);
    const id = study.id;
    try {
      const result = await api(`/api/studies/${id}/annotations`, {
        method: draft.id ? 'PATCH' : 'POST',
        body: draft,
      });
      if (currentStudy.current === id) {
        applyAnnotations(result, id);
        setSelectedId(draft.id || result.records.at(-1).id);
        setShowLabels(true);
      }
      setModal(null);
    } catch (e) {
      setLabelError(e.message);
    } finally {
      setSaving(false);
    }
  }
  async function updateAnnotation(annotation, method, extra = {}) {
    const id = study.id;
    setSaving(true);
    try {
      const result = await api(`/api/studies/${id}/annotations`, {
        method,
        body: { id: annotation.id, ...extra },
      });
      if (currentStudy.current === id) {
        applyAnnotations(result, id);
        if (method === 'DELETE') setSelectedId(null);
      }
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function generate() {
    const id = study.id;
    setSaving(true);
    try {
      const job = await api(`/api/studies/${id}/jobs`, {
        method: 'POST',
        body: { seriesId, region },
      });
      if (currentStudy.current === id) setJobs((previous) => [job, ...previous]);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function exportLabels() {
    try {
      const bundle = await api(`/api/studies/${study.id}/annotations?export`);
      saveFile(JSON.stringify(bundle, null, 2), 'AliAtlas-annotations.json');
    } catch (e) {
      fail(e);
    }
  }
  async function importLabels(file) {
    if (!file) return;
    const id = study.id;
    setSaving(true);
    try {
      if (file.size > 20_000_000) throw new Error('Annotation files must be smaller than 20 MB.');
      const bundle = JSON.parse(await file.text()),
        result = await api(`/api/studies/${id}/annotations`, { method: 'PUT', body: bundle });
      applyAnnotations(result, id);
      setNotice({
        type: 'success',
        message: 'Labels imported. Imported labels are marked for review.',
      });
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
      if (annotationInput.current) annotationInput.current.value = '';
    }
  }
  async function removeStudy() {
    setSaving(true);
    try {
      await api(`/api/studies/${study.id}`, { method: 'DELETE' });
      sequence.current++;
      setStudy(null);
      setRecords([]);
      setJobs([]);
      setModal(null);
      const w = await refreshWorkspace();
      if (w.studies[0]) await openStudy(w.studies[0].id);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  function selectAnnotation(annotation) {
    setPlaying(false);
    const i = series.frames.findIndex((f) => f.id === annotation.frameId);
    if (i >= 0) setIndex(i);
    setSelectedId(annotation.id);
    setShowLabels(true);
  }
  const uploadBusy = uploadProgress !== null;
  return (
    <div className="atlas-app">
      <header className="app-header">
        <a className="brand" href="/" aria-label="AliAtlas home">
          <span className="brand-mark">
            <span>A</span>
            <i />
          </span>
          <span>
            AliAtlas<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <small>ANATOMY WORKSPACE</small>
        </a>
        <div className="header-actions">
          <span className="private-badge">
            <Icon name="lock" size={13} />
            {archive.enabled
              ? archive.ready
                ? 'Private · Orthanc archive'
                : 'Private · archive offline'
              : 'Private workspace'}
          </span>
          <button
            className="text-button help-button"
            onClick={() => {
              setPlaying(false);
              setModal('help');
            }}
          >
            <Icon name="book" size={16} />
            Quick guide
          </button>
          <div className="user-menu">
            <small title={user.email}>{user.email}</small>
            <div className="workspace-avatar" title={user.name} aria-hidden="true">
              {initials(user.name)}
            </div>
            <button className="text-button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className={`workspace-grid ${sideOpen ? '' : 'sidebar-hidden'}`}>
        <aside className="study-sidebar">
          <div className="sidebar-title">
            <span className="eyebrow">STUDY LIBRARY</span>
            <span className="count-badge">{studies.length}</span>
          </div>
          <button
            className="primary-button import-button"
            onClick={startImport}
            disabled={!initialized}
          >
            <Icon name="plus" size={17} />
            Import DICOM
          </button>
          <p className="sidebar-intro">Your scans. A clearer perspective.</p>
          <div className="study-list">
            {studies.map((item) => (
              <div
                className={`study-group ${study?.id === item.id ? 'current' : ''}`}
                key={item.id}
              >
                <button className="study-button" onClick={() => openStudy(item.id)}>
                  <span className="study-icon">
                    <Icon name="folder" size={18} />
                  </span>
                  <span>
                    <b>{item.title}</b>
                    <small>
                      {item.seriesCount} {item.seriesCount === 1 ? 'series' : 'series'} ·{' '}
                      {item.frameCount} images
                    </small>
                  </span>
                  <Icon name="chevron" size={13} />
                </button>
                {study?.id === item.id && (
                  <div className="series-list">
                    {study.series.map((s, i) => (
                      <button
                        key={s.id}
                        onClick={() => changeSeries(s.id)}
                        className={`series-button ${s.id === seriesId ? 'selected' : ''}`}
                      >
                        <span className="series-thumbnail">
                          <Icon name="layers" size={22} />
                          <small>{String(i + 1).padStart(2, '0')}</small>
                        </span>
                        <span>
                          <b>{s.description}</b>
                          <small>
                            {s.plane} · {s.frames.length} slices
                          </small>
                          <em>CT</em>
                        </span>
                        {s.id === seriesId && <span className="selection-dot" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!studies.length && (
              <div className="empty-library">
                <Icon name="folder" size={28} />
                <b>A place for your studies</b>
                <p>Imported CT scans will appear here, organized by series.</p>
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <div className="privacy-symbol">
              <Icon name="lock" size={17} />
            </div>
            <div>
              <b>Stored in your workspace</b>
              <p>Scans stay on your AliAtlas server.</p>
            </div>
          </div>
          <div className="sidebar-version">
            <span>ALIATLAS / V0.1</span>
            <span className="status-dot" />
            Teaching workspace
          </div>
        </aside>
        <main className="main-workspace">
          <div className="workspace-heading">
            <div className="workspace-title-row">
              <button
                className="icon-button sidebar-toggle"
                aria-label="Toggle study library"
                onClick={() => setSideOpen(!sideOpen)}
              >
                <Icon name="layers" />
              </button>
              <div>
                <div className="breadcrumb">
                  Workspace <Icon name="chevron" size={11} />
                  <span>{study ? study.title : 'CT anatomy atlas'}</span>
                </div>
                <h1>{series ? series.description : 'Anatomy, in perspective.'}</h1>
              </div>
            </div>
            <div className="workspace-heading-actions">
              {study && (
                <span className="saved-state">
                  <span className={saving ? 'spinner small' : 'status-dot'} />
                  {saving ? 'Saving' : 'Saved'}
                </span>
              )}
              <button
                className="secondary-button"
                disabled={!frame || !viewerReady}
                onClick={() => viewer.current?.exportPng()}
              >
                <Icon name="download" size={15} />
                <span>Export slice</span>
              </button>
            </div>
          </div>
          {notice && (
            <div
              className={`notice ${notice.type}`}
              role={notice.type === 'error' ? 'alert' : 'status'}
            >
              <Icon name={notice.type === 'success' ? 'check' : 'info'} size={16} />
              <span>{notice.message}</span>
              <button aria-label="Dismiss message" onClick={() => setNotice(null)}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          <div className="viewer-workspace">
            <div className="viewer-column">
              <div className="toolbar">
                <div className="toolbar-group">
                  <Tool
                    icon="scroll"
                    active={mode === 'scroll'}
                    disabled={!frame}
                    onClick={() => setMode('scroll')}
                    title="Scroll slices (S)"
                  >
                    Scroll
                  </Tool>
                  <Tool
                    icon="pan"
                    active={mode === 'pan'}
                    disabled={!frame}
                    onClick={() => setMode('pan')}
                    title="Pan image (P)"
                  >
                    Pan
                  </Tool>
                  <Tool
                    icon="window"
                    active={mode === 'window'}
                    disabled={!frame}
                    onClick={() => setMode('window')}
                    title="Drag to adjust window (W)"
                  >
                    Window
                  </Tool>
                  <span className="toolbar-divider" />
                  <Tool
                    icon="plus"
                    active={mode === 'label'}
                    disabled={!frame}
                    onClick={() => {
                      setPlaying(false);
                      setMode('label');
                      setShowLabels(true);
                    }}
                    title="Place a label (A)"
                  >
                    Add label
                  </Tool>
                  <Tool
                    icon="ruler"
                    active={mode === 'measure'}
                    disabled={!frame}
                    onClick={startMeasure}
                    title="Measure a lesion (M)"
                  >
                    Measure
                  </Tool>
                  <Tool
                    icon="window"
                    active={mode === 'roi'}
                    disabled={!frame}
                    onClick={() => {
                      setPlaying(false);
                      setMode('roi');
                      setPanel('findings');
                    }}
                    title="Measure density in HU (H)"
                  >
                    HU
                  </Tool>
                </div>
                <div className="toolbar-group viewer-options">
                  <button
                    className={`icon-button ${showLabels ? 'on' : ''}`}
                    disabled={!frame}
                    onClick={() => setShowLabels(!showLabels)}
                    aria-label="Toggle anatomical labels"
                    aria-pressed={showLabels}
                    title="Show labels (L)"
                  >
                    <Icon name="eye" size={17} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={!frame}
                    onClick={() => viewer.current?.fullscreen()?.catch(fail)}
                    aria-label="Fullscreen viewer"
                  >
                    <Icon name="expand" size={17} />
                  </button>
                </div>
              </div>
              <DicomViewer
                ref={viewer}
                studyId={study?.id}
                series={series}
                frame={frame}
                index={index}
                mode={mode}
                zoom={zoom}
                pan={pan}
                setPan={setPan}
                setZoom={setZoom}
                windowing={windowing}
                setWindowing={setWindowing}
                invert={invert}
                labels={visibleLabels}
                showLabels={showLabels}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                onAdd={addLabel}
                onSlice={changeSlice}
                onReady={setViewerReady}
                findings={frameFindings}
                selectedFindingId={selectedFindingId}
                onSelectFinding={(id) => {
                  setSelectedFindingId(id);
                  setPanel('findings');
                }}
                measureDraft={measureDraft}
                onMeasure={measured}
                onRoi={measuredRoi}
                approx={approx}
                phase={phase?.phase}
              />
              {mode === 'roi' && frame && (
                <div className="measure-hint" role="status">
                  <Icon name="window" size={14} />
                  <span>
                    Drag from the centre of a region outward to measure its density (HU)
                    {findings.some((f) => f.id === selectedFindingId && f.frameId === frame.id)
                      ? ` for ${findings.find((f) => f.id === selectedFindingId).label}`
                      : ''}
                  </span>
                </div>
              )}
              {mode === 'measure' && frame && (
                <div className="measure-hint" role="status">
                  <Icon name="ruler" size={14} />
                  {measureDraft?.frameId === frame.id ? (
                    <>
                      <span>
                        Long axis{' '}
                        {formatSize(
                          {
                            longMm: lineLength(frame, measureDraft.long).value,
                            unit: lineLength(frame, measureDraft.long).unit,
                          },
                          { approx },
                        )}
                        . Now drag the short axis, or
                      </span>
                      <button
                        className="text-button accent"
                        onClick={() => openFindingForm(measureDraft)}
                      >
                        save without it
                      </button>
                      <button className="text-button" onClick={() => setMeasureDraft(null)}>
                        Redo
                      </button>
                    </>
                  ) : (
                    <span>Drag across the lesion&apos;s longest diameter</span>
                  )}
                </div>
              )}
              {loading && (
                <div className="study-loading">
                  <span className="spinner" />
                  Opening study…
                </div>
              )}
              {!frame && !loading && (
                <div className="empty-import-action">
                  <button className="primary-button" onClick={startImport} disabled={!initialized}>
                    <Icon name="upload" size={17} />
                    Import your first study
                    <Icon name="arrow" size={16} />
                  </button>
                  <span>DICOM files, folders or ZIP archives</span>
                </div>
              )}
              <div className="display-controls">
                <div className="window-controls">
                  <Icon name="window" size={16} />
                  <label className="sr-only" htmlFor="window-preset">
                    Window preset
                  </label>
                  <select
                    id="window-preset"
                    value={preset}
                    disabled={!frame}
                    onChange={(e) => {
                      const p = PRESETS.find((p) => p.id === e.target.value);
                      if (p) setWindowing({ width: p.width, center: p.center });
                    }}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {preset === 'custom' && <option value="custom">Custom window</option>}
                  </select>
                  <button
                    className={`text-button invert-button ${invert ? 'on' : ''}`}
                    disabled={!frame}
                    onClick={() => setInvert(!invert)}
                    aria-pressed={invert}
                  >
                    Invert
                  </button>
                </div>
                <div className="zoom-controls">
                  <button
                    className="icon-button"
                    disabled={!frame}
                    onClick={() => setZoom(clamp(zoom / 1.2, 0.25, 8))}
                    aria-label="Zoom out"
                  >
                    <Icon name="minus" size={16} />
                  </button>
                  <span className="mono">{Math.round(zoom * 100)}%</span>
                  <button
                    className="icon-button"
                    disabled={!frame}
                    onClick={() => setZoom(clamp(zoom * 1.2, 0.25, 8))}
                    aria-label="Zoom in"
                  >
                    <Icon name="plus" size={16} />
                  </button>
                  <span className="toolbar-divider" />
                  <button
                    className="text-button"
                    disabled={!frame}
                    onClick={resetView}
                    title="Reset view (R)"
                  >
                    <Icon name="reset" size={14} />
                    Reset
                  </button>
                </div>
              </div>
              <div className="slice-controls">
                <button
                  className={`play-button ${playing ? 'playing' : ''}`}
                  disabled={!frame || series?.frames.length < 2}
                  aria-label={playing ? 'Pause slices' : 'Play slices'}
                  onClick={() => setPlaying(!playing)}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={15} />
                </button>
                <button
                  className="icon-button previous"
                  disabled={!frame || index === 0}
                  onClick={() => changeSlice(index - 1)}
                  aria-label="Previous slice"
                >
                  <Icon name="chevron" size={15} />
                </button>
                <div className="slice-track">
                  <div className="slice-track-label">
                    <span>
                      {series?.plane === 'Axial' && series?.geometryKnown
                        ? 'INFERIOR → SUPERIOR'
                        : 'SOURCE SLICES'}
                    </span>
                    <span>{frame ? `${index + 1} / ${series.frames.length}` : '— / —'}</span>
                  </div>
                  <input
                    aria-label="Slice number"
                    type="range"
                    min="0"
                    max={Math.max(0, (series?.frames.length || 1) - 1)}
                    value={frame ? index : 0}
                    disabled={!frame}
                    onChange={(e) => {
                      setPlaying(false);
                      changeSlice(Number(e.target.value));
                    }}
                  />
                </div>
                <button
                  className="icon-button"
                  disabled={!frame || index === series?.frames.length - 1}
                  onClick={() => changeSlice(index + 1)}
                  aria-label="Next slice"
                >
                  <Icon name="chevron" size={15} />
                </button>
              </div>
              <div className="viewer-status">
                <span>
                  <span className="status-dot muted" />
                  {frame ? `${frame.columns} × ${frame.rows}` : 'No study loaded'}
                  {frame?.spacing && ` · ${frame.spacing.map((n) => n.toFixed(2)).join(' × ')} mm`}
                </span>
                <span>
                  {frame ? `${labeledSlices} labeled slices` : 'Scroll to explore · Click to label'}
                </span>
              </div>
            </div>
            <aside className="structures-panel">
              <div className="panel-switch" role="tablist">
                <button
                  role="tab"
                  aria-selected={panel === 'structures'}
                  onClick={() => setPanel('structures')}
                >
                  Anatomy
                </button>
                <button
                  role="tab"
                  aria-selected={panel === 'findings'}
                  onClick={() => setPanel('findings')}
                >
                  Findings
                  {findings.some((f) => f.status === 'unreviewed') && <i className="dot-alert" />}
                </button>
              </div>
              {panel === 'findings' ? (
                <FindingsPanel
                  findings={findings}
                  series={series}
                  frame={frame}
                  vision={vision}
                  detecting={detecting}
                  busy={saving}
                  selectedId={selectedFindingId}
                  onSelect={selectFinding}
                  onReview={reviewFinding}
                  onEdit={(f) => {
                    setFindingError('');
                    setFindingForm({ ...f });
                    setModal('finding');
                  }}
                  onDelete={deleteFinding}
                  onDetect={detect}
                  onMeasure={startMeasure}
                  approx={approx}
                  phase={phase}
                  onPhase={setPhase}
                  onMarkExtent={markExtent}
                  onClear={clearFindingPart}
                  onReport={() => {
                    setPlaying(false);
                    setModal('report');
                  }}
                />
              ) : (
                <>
                  <div className="structures-heading">
                    <div>
                      <Icon name="tag" size={17} />
                      <h2>Structures</h2>
                    </div>
                    <span className="count-badge">{frameLabels.length}</span>
                  </div>
                  <div className="structure-tabs">
                    <button
                      className={scope === 'slice' ? 'active' : ''}
                      onClick={() => setScope('slice')}
                    >
                      This slice
                    </button>
                    <button
                      className={scope === 'series' ? 'active' : ''}
                      onClick={() => setScope('series')}
                    >
                      All slices
                    </button>
                  </div>
                  <div className="structure-search">
                    <Icon name="search" size={15} />
                    <input
                      aria-label="Search structures"
                      placeholder="Find a structure…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button aria-label="Clear search" onClick={() => setQuery('')}>
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                  <div className="category-filter">
                    <label htmlFor="category-filter">SHOW</label>
                    <select
                      id="category-filter"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="all">All structures</option>
                      <option value="organ">Organs & cavities</option>
                      <option value="bone">Bones</option>
                      <option value="vessel">Vessels</option>
                      <option value="muscle">Muscles</option>
                      <option value="gland">Glands</option>
                    </select>
                  </div>
                  <div className="structure-list">
                    {structureList.map((annotation) => (
                      <button
                        className={`structure-item ${annotation.id === selectedId ? 'selected' : ''}`}
                        key={annotation.id}
                        onClick={() => selectAnnotation(annotation)}
                      >
                        <span className="structure-dot" style={{ background: annotation.color }} />
                        <span>
                          <b>{annotation.label}</b>
                          <small>
                            {annotation.source === 'model'
                              ? 'AI label'
                              : annotation.source === 'imported'
                                ? 'Imported'
                                : 'Manual label'}
                            {scope === 'series'
                              ? ` · slice ${series.frames.findIndex((f) => f.id === annotation.frameId) + 1}`
                              : ''}
                          </small>
                        </span>
                        {annotation.reviewed ? (
                          <Icon name="check" size={12} />
                        ) : (
                          <span className="review-dot" title="Needs review" />
                        )}
                      </button>
                    ))}
                    {!structureList.length && (
                      <div className="structures-empty">
                        <span className="empty-tag">
                          <Icon name="tag" size={24} />
                        </span>
                        <b>
                          {query
                            ? 'No matching structures'
                            : frame
                              ? 'Make anatomy visible'
                              : 'Anatomy comes into focus here'}
                        </b>
                        <p>
                          {query
                            ? 'Try another name or category.'
                            : frame
                              ? 'Use Add label to identify a structure on this slice, or generate labels below.'
                              : 'Import a study to view and annotate its structures.'}
                        </p>
                        {frame && !query && (
                          <button
                            className="text-button accent"
                            onClick={() => {
                              setMode('label');
                              setShowLabels(true);
                            }}
                          >
                            Add your first label
                            <Icon name="plus" size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {selected && (
                    <div className="annotation-detail">
                      <div>
                        <span className="eyebrow">SELECTED STRUCTURE</span>
                        <button
                          className="icon-button"
                          aria-label="Deselect label"
                          onClick={() => setSelectedId(null)}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                      <b>{selected.label}</b>
                      <p>
                        {selected.source === 'model'
                          ? `${selected.model?.name || 'AI model'} · ${selected.reviewed ? 'Reviewed' : 'Needs review'}`
                          : selected.source === 'manual'
                            ? 'Manually placed on this slice'
                            : 'Imported · verify this placement'}
                      </p>
                      <div className="annotation-actions">
                        <button className="secondary-button" disabled={saving} onClick={editLabel}>
                          Edit
                        </button>
                        {!selected.reviewed && (
                          <button
                            className="secondary-button"
                            disabled={saving}
                            onClick={() => updateAnnotation(selected, 'PATCH', { reviewed: true })}
                          >
                            <Icon name="check" size={13} />
                            Reviewed
                          </button>
                        )}
                        <button
                          className="icon-button danger"
                          disabled={saving}
                          aria-label="Delete selected label"
                          onClick={() => updateAnnotation(selected, 'DELETE')}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="ai-section">
                    <div className="ai-heading">
                      <span>
                        <Icon name="sparkles" size={16} />
                        Anatomy assist
                      </span>
                      <span className={`ai-state ${ai.ready ? 'ready' : ''}`}>
                        {ai.ready ? 'READY' : 'OFFLINE'}
                      </span>
                    </div>
                    <label className="sr-only" htmlFor="body-region">
                      CT region
                    </label>
                    <select
                      id="body-region"
                      value={region}
                      disabled={busyJob}
                      onChange={(e) => setRegion(e.target.value)}
                    >
                      {REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="generate-button"
                      disabled={
                        !series || !ai.ready || !!series?.segmentationIssue || busyJob || saving
                      }
                      onClick={generate}
                    >
                      <Icon name="sparkles" size={15} />
                      {busyJob ? 'Processing anatomy…' : 'Generate anatomy labels'}
                    </button>
                    {activeJob && (busyJob || activeJob.steps) ? (
                      <JobTimer job={activeJob} />
                    ) : activeJob ? (
                      <p className={activeJob.status === 'failed' ? 'job-error' : ''}>
                        {activeJob.message}
                      </p>
                    ) : (
                      <p>
                        {!ai.ready
                          ? 'Automatic labeling is unavailable on this server. Manual labels are ready to use.'
                          : series?.segmentationIssue ||
                            'Generated labels are suggestions. Review their placement before teaching.'}
                      </p>
                    )}
                  </div>
                  <div className="annotation-file-actions">
                    <button
                      className="text-button"
                      disabled={!study || saving}
                      onClick={exportLabels}
                    >
                      <Icon name="download" size={13} />
                      Export labels
                    </button>
                    <button
                      className="text-button"
                      disabled={!study || saving}
                      onClick={() => annotationInput.current.click()}
                    >
                      <Icon name="upload" size={13} />
                      Import labels
                    </button>
                    <input
                      ref={annotationInput}
                      className="sr-only"
                      type="file"
                      accept="application/json,.json"
                      onChange={(e) => importLabels(e.target.files[0])}
                    />
                  </div>
                </>
              )}
            </aside>
          </div>
          <footer className="workspace-footer">
            <span>
              <Icon name="info" size={12} />
              For education and annotation · Not for clinical diagnosis
            </span>
            {study ? (
              <button
                className="text-button"
                onClick={() => {
                  setPlaying(false);
                  setModal('delete');
                }}
              >
                <Icon name="trash" size={12} />
                Remove study
              </button>
            ) : (
              <span>Designed for discovery.</span>
            )}
          </footer>
        </main>
      </div>
      {modal === 'import' && (
        <Modal
          title="Bring a study into focus"
          subtitle="Import your CT images to start exploring."
          onClose={() => setModal(null)}
          wide
          locked={uploadBusy || Boolean(openingArchive)}
        >
          {archive.enabled && (
            <div className="import-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={importSource === 'upload'}
                disabled={uploadBusy || Boolean(openingArchive)}
                onClick={() => setImportSource('upload')}
              >
                Upload files
              </button>
              <button
                role="tab"
                aria-selected={importSource === 'archive'}
                disabled={uploadBusy || Boolean(openingArchive)}
                onClick={showArchive}
              >
                From Orthanc archive
              </button>
            </div>
          )}
          {importSource === 'archive' ? (
            <>
              {archived === null ? (
                <p className="archive-empty" role="status">
                  <span className="spinner small" /> Loading archived studies…
                </p>
              ) : archived.length === 0 ? (
                <p className="archive-empty">
                  No archived studies yet. Studies you upload are stored in Orthanc automatically.
                </p>
              ) : (
                <ul className="archive-list">
                  {archived.map((item) => (
                    <li key={item.id}>
                      <div>
                        <b>{item.description || 'CT study'}</b>
                        <small>
                          {item.studyDate &&
                            `${item.studyDate.slice(0, 4)}-${item.studyDate.slice(4, 6)}-${item.studyDate.slice(6, 8)} · `}
                          {item.instances} {item.instances === 1 ? 'file' : 'files'} · archived{' '}
                          {new Date(item.archivedAt).toLocaleDateString()}
                          {!item.available && ' · missing from Orthanc'}
                        </small>
                      </div>
                      <button
                        className="secondary-button"
                        disabled={!item.available || Boolean(openingArchive)}
                        onClick={() => openArchived(item.id)}
                      >
                        {openingArchive === item.id ? (
                          <span className="spinner small" />
                        ) : (
                          <Icon name="folder" size={15} />
                        )}
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {notice?.type === 'error' && (
                <p className="form-error" role="alert">
                  {notice.message}
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="text-button"
                  disabled={Boolean(openingArchive)}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!uploadBusy) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (!uploadBusy) setFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <span className="upload-icon">
                  <Icon name="upload" size={30} />
                </span>
                <h3>
                  {files.length
                    ? `${files.length} ${files.length === 1 ? 'file' : 'files'} selected`
                    : 'Drop your DICOM files here'}
                </h3>
                <p>
                  {files.length
                    ? `${(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB ready to import`
                    : 'DICOM files or a ZIP archive · up to 512 MB'}
                </p>
                <div className="upload-choices">
                  <button
                    className="secondary-button"
                    disabled={uploadBusy}
                    onClick={() => fileInput.current.click()}
                  >
                    <Icon name="layers" size={15} />
                    Choose files
                  </button>
                  <button
                    className="secondary-button"
                    disabled={uploadBusy}
                    onClick={() => folderInput.current.click()}
                  >
                    <Icon name="folder" size={15} />
                    Choose folder
                  </button>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => setFiles(Array.from(e.target.files))}
                />
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  webkitdirectory=""
                  className="sr-only"
                  onChange={(e) => setFiles(Array.from(e.target.files))}
                />
              </div>
              <div className="upload-note">
                <Icon name="lock" size={16} />
                <p>
                  {archive.enabled
                    ? 'Images are stored in your Orthanc archive and opened in your private workspace. Removing a study from the workspace keeps the archived copy.'
                    : 'Images are uploaded to your AliAtlas server and kept in your private workspace. You can remove a study when you’re done.'}
                </p>
              </div>
              <div className="upload-steps">
                <span>
                  <b>01</b>Import CT
                </span>
                <Icon name="arrow" size={14} />
                <span>
                  <b>02</b>Select series
                </span>
                <Icon name="arrow" size={14} />
                <span>
                  <b>03</b>Explore & label
                </span>
              </div>
              {uploadBusy && (
                <div className="upload-progress" role="status">
                  <progress max="100" value={uploadProgress} />
                  <span>
                    {uploadProgress === 100
                      ? 'Extracting and organizing DICOM slices…'
                      : `Uploading ${uploadProgress}%`}
                  </span>
                </div>
              )}
              {notice?.type === 'error' && (
                <p className="form-error" role="alert">
                  {notice.message}
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="text-button"
                  disabled={uploadBusy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  disabled={
                    !files.length ||
                    uploadBusy ||
                    files.reduce((n, f) => n + f.size, 0) > 512 * 1024 * 1024
                  }
                  onClick={upload}
                >
                  {uploadBusy ? (
                    <span className="spinner small" />
                  ) : (
                    <Icon name="upload" size={16} />
                  )}
                  Import study
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === 'label' && draft && (
        <Modal
          title={draft.id ? 'Edit anatomical label' : 'Label a structure'}
          subtitle={`Anchored to ${series.plane.toLowerCase()} slice ${index + 1}.`}
          onClose={() => setModal(null)}
          locked={saving}
        >
          <form onSubmit={submitLabel}>
            <label className="field-label" htmlFor="label-name">
              Structure name
            </label>
            <input
              id="label-name"
              className="form-input"
              autoFocus
              required
              maxLength={80}
              list="anatomy-names"
              placeholder="e.g. Internal carotid artery"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <datalist id="anatomy-names">
              {MANUAL_LABELS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <div className="form-two-columns">
              <div>
                <label className="field-label" htmlFor="label-side">
                  Label placement
                </label>
                <select
                  id="label-side"
                  value={draft.side}
                  onChange={(e) => setDraft({ ...draft, side: e.target.value })}
                >
                  <option value="left">Left of image</option>
                  <option value="right">Right of image</option>
                </select>
              </div>
              <div>
                <span className="field-label">Color</span>
                <div className="color-picker">
                  {Object.entries(COLORS).map(([name, color]) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={`${name} color`}
                      aria-pressed={draft.color === color}
                      className={draft.color === color ? 'selected' : ''}
                      style={{ background: color }}
                      onClick={() => setDraft({ ...draft, color })}
                    >
                      {draft.color === color && <Icon name="check" size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p className="form-hint">
              This label appears only on the selected DICOM frame. Add labels to other slices as you
              explore.
            </p>
            {labelError && (
              <p className="form-error" role="alert">
                {labelError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="text-button"
                disabled={saving}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !draft.label.trim()}>
                {saving ? <span className="spinner small" /> : <Icon name="check" size={15} />}Save
                label
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'finding' && findingForm && (
        <Modal
          title={findingForm.id ? 'Edit finding' : 'Record a finding'}
          subtitle={findingSummary(findingForm)}
          onClose={() => setModal(null)}
          locked={saving}
        >
          <form onSubmit={saveFinding}>
            <label className="field-label" htmlFor="finding-name">
              Finding name
            </label>
            <input
              id="finding-name"
              className="form-input"
              autoFocus
              required
              maxLength={80}
              value={findingForm.label}
              onChange={(e) => setFindingForm({ ...findingForm, label: e.target.value })}
            />
            <div className="form-two-columns">
              <div>
                <label className="field-label" htmlFor="finding-category">
                  Category
                </label>
                <select
                  id="finding-category"
                  value={findingForm.category}
                  onChange={(e) => setFindingForm({ ...findingForm, category: e.target.value })}
                >
                  {FINDING_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="field-label finding-note-label" htmlFor="finding-note">
              Description (optional)
            </label>
            <textarea
              id="finding-note"
              className="form-input"
              rows={3}
              maxLength={1000}
              placeholder="e.g. Well-defined hypodense lesion in segment VI"
              value={findingForm.note}
              onChange={(e) => setFindingForm({ ...findingForm, note: e.target.value })}
            />
            {findingError && (
              <p className="form-error" role="alert">
                {findingError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="text-button"
                disabled={saving}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={saving}>
                {saving ? <span className="spinner small" /> : <Icon name="check" size={15} />}
                Save finding
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'report' && study && (
        <Modal title="CT report" subtitle={study.title} onClose={() => setModal(null)} wide>
          <ReportEditor
            study={study}
            findings={findings}
            api={api}
            onClose={() => setModal(null)}
            onError={fail}
          />
        </Modal>
      )}
      {modal === 'delete' && (
        <Modal
          title="Remove this study?"
          subtitle="The original CT files, labels and processing results will be deleted from this workspace."
          onClose={() => setModal(null)}
          locked={saving}
        >
          <div className="modal-actions">
            <button className="secondary-button" disabled={saving} onClick={() => setModal(null)}>
              Keep study
            </button>
            <button className="delete-button" disabled={saving} onClick={removeStudy}>
              Remove study
            </button>
          </div>
        </Modal>
      )}
      {modal === 'help' && (
        <Modal
          title="A closer look, one slice at a time"
          subtitle="Your guide to the anatomy workspace."
          onClose={() => setModal(null)}
          wide
        >
          <div className="guide-section">
            <h3>1. Import & select</h3>
            <p>
              Choose DICOM files, a complete folder, or a ZIP. Each CT series appears in your study
              library. Select the series you want to explore.
            </p>
            <h3>2. Explore the scan</h3>
            <p>
              Use your mouse wheel or the slice slider to move through images. Pan repositions the
              scan. Window adjusts brightness and contrast. Presets help you view soft tissue,
              brain, lung and bone.
            </p>
            <h3>3. Add anatomy</h3>
            <p>
              Select Add label and click a structure. Choose its name, color and label side. Labels
              stay attached to that slice as you pan and zoom. Anatomy assist can generate labels
              when a model worker is available; review each suggestion.
            </p>
            <h3>4. Take your work with you</h3>
            <p>
              Export the current slice as PNG, or export all study labels as JSON. Label files can
              be imported onto the same DICOM study using its original image identifiers.
            </p>
          </div>
          <div className="keyboard-grid">
            {[
              ['S', 'Scroll'],
              ['P', 'Pan'],
              ['W', 'Window'],
              ['A', 'Add label'],
              ['R', 'Reset view'],
              ['L', 'Toggle labels'],
              ['↑ / ↓', 'Change slice'],
              ['Space', 'Play / pause'],
            ].map(([key, action]) => (
              <span key={key}>
                <kbd>{key}</kbd>
                {action}
              </span>
            ))}
          </div>
          <div className="guide-note">
            <Icon name="info" size={18} />
            <p>
              This workspace displays source CT slices. A single image cannot provide a full 3D
              stack. Automatic labeling covers the structures supported by the installed model, and
              needs review.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
