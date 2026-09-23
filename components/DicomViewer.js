'use client';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  imageTransform,
  screenToPixel,
  pixelToScreen,
  windowPixel,
  orientationLabels,
  clamp,
} from '../lib/geometry.js';
import { layoutLabels, drawLabels, labelEdge, lineY } from '../lib/label-layout.js';
import { SliceLoader } from '../lib/slice-loader.js';
import { lineLength, formatSize } from '../lib/measure.js';
import { roiStats, formatHu } from '../lib/roi.js';
import { phaseInfo } from '../lib/contrast.js';
import Icon from './Icon.js';

const DicomViewer = forwardRef(function DicomViewer(
  {
    studyId,
    series,
    frame,
    index,
    mode,
    zoom,
    pan,
    setPan,
    setZoom,
    windowing,
    setWindowing,
    invert,
    labels,
    showLabels,
    selectedId,
    onSelect,
    onAdd,
    onSlice,
    onReady,
    findings = [],
    selectedFindingId,
    onSelectFinding,
    measureDraft,
    onMeasure,
    onRoi,
    approx = false,
    phase,
  },
  ref,
) {
  const host = useRef(null),
    canvas = useRef(null),
    loader = useRef(null),
    // The last drawn slice stays on screen until the next one is available, so
    // scrolling never flashes an empty viewport.
    shown = useRef(null),
    source = useRef({ canvas: null, key: '' }),
    drag = useRef(null),
    live = useRef({});
  const [size, setSize] = useState({ width: 800, height: 600 }),
    [, setVersion] = useState(0),
    [progress, setProgress] = useState({ loaded: 0, total: 0 }),
    [error, setError] = useState('');
  const transform = useMemo(
    () => (frame ? imageTransform(frame, size.width, size.height, zoom, pan) : null),
    [frame, size, zoom, pan],
  );
  const current = frame ? loader.current?.get(frame.id) : null;
  if (current && (shown.current?.frame !== frame || shown.current.pixels !== current))
    shown.current = { frame, pixels: current };
  const ready = Boolean(current);
  const display = shown.current;
  useEffect(() => {
    onReady?.(ready && !error);
  }, [ready, error, onReady]);
  const placed = useMemo(
    () =>
      ready && showLabels && transform
        ? layoutLabels(labels, transform, size.width, size.height, [
            transform.x,
            transform.x + frame.columns * transform.sx,
          ])
        : [],
    [ready, showLabels, labels, transform, size],
  );
  const directions = orientationLabels(frame);
  live.current = {
    onSlice,
    index,
    count: series?.frames.length || 0,
    zoom,
    setZoom,
    frameId: frame?.id,
  };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = host.current;
    const wheel = (e) => {
      if (!live.current.count) return;
      e.preventDefault();
      const current = live.current;
      if (e.ctrlKey || e.metaKey)
        current.setZoom(clamp(current.zoom * Math.exp(-e.deltaY * 0.002), 0.25, 8));
      else current.onSlice(clamp(current.index + Math.sign(e.deltaY), 0, current.count - 1));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    shown.current = null;
    source.current = { canvas: null, key: '' };
    setError('');
    if (!series) return;
    const instance = new SliceLoader({
      frames: series.frames,
      async fetchBatch(batch) {
        const response = await fetch(
          `/api/studies/${studyId}/slices?series=${series.id}&frames=${batch.map((f) => f.id).join(',')}`,
        );
        if (!response.ok)
          throw new Error((await response.json()).error || 'The CT slices could not be loaded.');
        return {
          buffer: await response.arrayBuffer(),
          format: response.headers.get('X-Pixel-Format'),
        };
      },
      onLoad() {
        setProgress({ loaded: instance.loaded, total: series.frames.length });
        setVersion((v) => v + 1);
      },
      onError(e, ids) {
        if (ids.includes(live.current.frameId)) setError(e.message);
      },
    });
    loader.current = instance;
    setProgress({ loaded: 0, total: series.frames.length });
    instance.focus(live.current.index || 0);
    return () => {
      instance.dispose();
      if (loader.current === instance) loader.current = null;
    };
    // Restart only for a different series; refreshed study objects keep the cache.
  }, [studyId, series?.id]);
  useEffect(() => {
    if (frame) {
      setError('');
      loader.current?.focus(index);
    }
  }, [frame?.id, index]);
  useEffect(() => {
    const surface = canvas.current,
      ratio = window.devicePixelRatio || 1;
    surface.width = Math.round(size.width * ratio);
    surface.height = Math.round(size.height * ratio);
    const ctx = surface.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#030709';
    ctx.fillRect(0, 0, size.width, size.height);
    if (!display || error) return;
    const { frame: drawn, pixels } = display;
    const view = imageTransform(drawn, size.width, size.height, zoom, pan);
    const inverted = drawn.inverted !== invert;
    // Windowing is recomputed only when the slice or window changes, not on pan/zoom.
    const key = `${drawn.id}|${windowing.center}|${windowing.width}|${inverted}`;
    if (source.current.key !== key) {
      const target = source.current.canvas || document.createElement('canvas');
      if (target.width !== drawn.columns || target.height !== drawn.rows) {
        target.width = drawn.columns;
        target.height = drawn.rows;
      }
      const context = target.getContext('2d'),
        image = context.createImageData(drawn.columns, drawn.rows),
        out = new Uint32Array(image.data.buffer);
      const gray = (v) => {
        const g = Math.round(windowPixel(v, windowing.center, windowing.width, inverted));
        return 0xff000000 | (g << 16) | (g << 8) | g;
      };
      if (pixels instanceof Int16Array) {
        const lut = new Uint32Array(65536);
        for (let v = -32768; v < 32768; v++) lut[v + 32768] = gray(v);
        for (let i = 0; i < pixels.length; i++) out[i] = lut[pixels[i] + 32768];
      } else for (let i = 0; i < pixels.length; i++) out[i] = gray(pixels[i]);
      context.putImageData(image, 0, 0);
      source.current = { canvas: target, key };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      source.current.canvas,
      view.x,
      view.y,
      drawn.columns * view.sx,
      drawn.rows * view.sy,
    );
  }, [display, size, zoom, pan, windowing, invert, error]);
  useImperativeHandle(
    ref,
    () => ({
      exportPng() {
        if (!ready || error) return;
        const output = document.createElement('canvas');
        output.width = size.width * 2;
        output.height = size.height * 2;
        const ctx = output.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(canvas.current, 0, 0, size.width, size.height);
        drawLabels(ctx, placed, selectedId);
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#acbcbf';
        ctx.fillText(
          `AliAtlas · ${series.plane} · Slice ${index + 1}/${series.frames.length}`,
          16,
          24,
        );
        ctx.fillText(
          `W ${Math.round(windowing.width)}  L ${Math.round(windowing.center)}`,
          size.width - 135,
          24,
        );
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#93a2a5';
        ctx.fillText('Educational workspace · Labels require review', 16, size.height - 16);
        output.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob),
            a = document.createElement('a');
          a.href = url;
          a.download = `AliAtlas-slice-${index + 1}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      },
      fullscreen() {
        if (document.fullscreenElement) return document.exitFullscreen();
        return host.current.requestFullscreen();
      },
      // Key image for a report: the displayed slice with this finding's calipers.
      captureFinding(finding) {
        if (!ready || error || finding.frameId !== frame?.id) return Promise.resolve(null);
        // Crop to the visible part of the scan, not the whole viewport with its margins.
        const left = Math.max(0, transform.x),
          top = Math.max(0, transform.y);
        const right = Math.min(size.width, transform.x + frame.columns * transform.sx),
          bottom = Math.min(size.height, transform.y + frame.rows * transform.sy);
        const width = right - left,
          height = bottom - top;
        if (width < 8 || height < 8) return Promise.resolve(null);
        const scale = Math.max(1, Math.min(3, 800 / width)),
          ratio = canvas.current.width / size.width;
        const output = document.createElement('canvas');
        output.width = Math.round(width * scale);
        output.height = Math.round(height * scale);
        const ctx = output.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(
          canvas.current,
          left * ratio,
          top * ratio,
          width * ratio,
          height * ratio,
          0,
          0,
          width,
          height,
        );
        ctx.translate(-left, -top);
        drawCalipers(ctx, transform, finding, true, [left, right], approx);
        ctx.translate(left, top);
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#acbcbf';
        ctx.fillText(
          `${series.plane} · Image ${index + 1}/${series.frames.length} · W ${Math.round(windowing.width)} L ${Math.round(windowing.center)}`,
          8,
          16,
        );
        return new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      },
    }),
    [ready, error, size, placed, selectedId, series, index, windowing, frame, transform, approx],
  );
  const insideImage = (pixel) =>
    pixel[0] >= 0 && pixel[0] <= frame.columns - 1 && pixel[1] >= 0 && pixel[1] <= frame.rows - 1;
  const toPixel = (e) => {
    const rect = host.current.getBoundingClientRect();
    return screenToPixel(transform, [e.clientX - rect.left, e.clientY - rect.top]);
  };
  const [measuring, setMeasuring] = useState(null);
  function pointerDown(e) {
    if (!frame || !ready || error || e.button !== 0) return;
    if (mode === 'label') {
      const pixel = toPixel(e);
      if (insideImage(pixel)) onAdd(pixel);
      return;
    }
    if (mode === 'measure' || mode === 'roi') {
      const pixel = toPixel(e);
      if (!insideImage(pixel)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setMeasuring([pixel, pixel]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      pan: [...pan],
      windowing: { ...windowing },
      index,
    };
  }
  function pointerMove(e) {
    if (measuring) {
      const [x, y] = toPixel(e);
      setMeasuring([measuring[0], [clamp(x, 0, frame.columns - 1), clamp(y, 0, frame.rows - 1)]]);
      return;
    }
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x,
      dy = e.clientY - drag.current.y;
    if (mode === 'pan') setPan([drag.current.pan[0] + dx, drag.current.pan[1] + dy]);
    if (mode === 'window')
      setWindowing({
        width: clamp(drag.current.windowing.width + dx * 4, 1, 10000),
        center: clamp(drag.current.windowing.center + dy * 2, -5000, 10000),
      });
    if (mode === 'scroll')
      onSlice(clamp(drag.current.index + Math.round(-dy / 5), 0, series.frames.length - 1));
  }
  return (
    <div
      className={`dicom-viewport mode-${mode}`}
      ref={host}
      tabIndex={0}
      aria-label="CT image viewport"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={() => {
        drag.current = null;
        if (measuring) {
          const [[x1, y1], [x2, y2]] = measuring;
          const length = Math.hypot(x2 - x1, y2 - y1);
          // Ignore clicks; a caliper or density circle needs a real drag.
          if (mode === 'roi' && length >= 1) {
            const roi = { center: measuring[0], radius: length };
            onRoi?.({
              ...roi,
              stats: current ? roiStats(current, frame, roi.center, roi.radius) : null,
            });
          } else if (mode === 'measure' && length >= 2) onMeasure?.(measuring);
          setMeasuring(null);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setMeasuring(null);
      }}
    >
      <canvas
        ref={canvas}
        aria-label={frame ? `CT ${series.plane} slice ${index + 1}` : 'Empty CT viewport'}
      />
      {frame ? (
        <>
          <div className="viewport-meta">
            <span>
              <b>{series.plane.toUpperCase()}</b>
              {phase && (
                <span className={`phase-badge ${phaseInfo(phase).enhanced ? 'enhanced' : ''}`}>
                  {phaseInfo(phase).name}
                </span>
              )}
              <span className="mono">
                {String(index + 1).padStart(3, '0')} <em>/ {series.frames.length}</em>
              </span>
            </span>
            <span className="mono">
              W {Math.round(windowing.width)} <em>·</em> L {Math.round(windowing.center)}
            </span>
          </div>
          {Object.entries(directions).map(([side, label]) => (
            <span key={side} className={`orientation orientation-${side}`}>
              {label}
            </span>
          ))}
          {ready && !error && (
            <svg className="label-overlay" viewBox={`0 0 ${size.width} ${size.height}`}>
              {placed.map((item) => (
                <g
                  key={item.id}
                  className={`anatomy-label ${item.id === selectedId ? 'selected' : ''}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(item.id);
                    }
                  }}
                >
                  <path
                    d={`M ${labelEdge(item)} ${item.y + item.height / 2} L ${item.anchor[0]} ${item.anchor[1]}`}
                    stroke={item.color}
                  />
                  <circle cx={item.anchor[0]} cy={item.anchor[1]} r="4" fill={item.color} />
                  <rect
                    x={item.x}
                    y={item.y}
                    width={item.width}
                    height={item.height}
                    rx="3"
                    stroke={item.color}
                    role="button"
                    tabIndex="0"
                    aria-label={`Select ${item.label}`}
                  />
                  <text fill={item.color}>
                    {item.lines.map((line, i) => (
                      <tspan key={i} x={item.x + 10} y={lineY(item, i)}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  <title>
                    {item.label} · {item.source}
                    {item.reviewed ? ' · reviewed' : ' · needs review'}
                  </title>
                </g>
              ))}
            </svg>
          )}
          {!display && !error && (
            <div className="viewport-message">
              <span className="spinner" />
              Loading CT slice
            </div>
          )}
          {progress.total > 1 && progress.loaded < progress.total && !error && (
            <div className="slice-buffer" role="status" aria-label="Loading slices">
              <i style={{ width: `${(progress.loaded / progress.total) * 100}%` }} />
              <span>
                Caching slices {progress.loaded}/{progress.total}
              </span>
            </div>
          )}
          {error && (
            <div className="viewport-message error" role="alert">
              <Icon name="info" size={24} />
              {error}
            </div>
          )}
          {ready && !error && transform && (
            <svg className="finding-overlay" viewBox={`0 0 ${size.width} ${size.height}`}>
              {findings
                .filter((f) => f.status !== 'rejected')
                .map((f) => (
                  <Calipers
                    key={f.id}
                    finding={f}
                    transform={transform}
                    selected={f.id === selectedFindingId}
                    onSelect={onSelectFinding}
                    approx={approx}
                  />
                ))}
              {measureDraft?.frameId === frame.id && (
                <Calipers
                  finding={{ ...measureDraft, label: 'New', ...draftSizes(frame, measureDraft) }}
                  transform={transform}
                  draft
                />
              )}
              {measuring && mode === 'measure' && (
                <Calipers
                  finding={{
                    label: '',
                    long: measuring,
                    ...draftSizes(frame, { long: measuring }),
                  }}
                  transform={transform}
                  draft
                  approx={approx}
                />
              )}
              {measuring && mode === 'roi' && current && (
                <RoiCircle
                  roi={liveRoi(measuring, current, frame)}
                  transform={transform}
                  color="#ffffff"
                />
              )}
            </svg>
          )}
          {mode === 'label' && ready && (
            <div className="mode-hint">
              <Icon name="tag" size={14} />
              Click a structure to place its label
            </div>
          )}
          {showLabels && labels.length > placed.length && ready && (
            <div className="label-limit">
              {placed.length} of {labels.length} labels shown · use the structures list to explore
            </div>
          )}
        </>
      ) : (
        <div className="viewer-empty">
          <div className="scan-emblem">
            <div className="scan-grid" />
            <Icon name="scan" size={46} />
            <span className="scan-line" />
          </div>
          <span className="eyebrow">YOUR ANATOMY WORKSPACE</span>
          <h2>Every slice tells a story.</h2>
          <p>
            Import a CT study to explore the anatomy.
            <br />
            Scroll through slices and bring structures into focus.
          </p>
          <div className="empty-capabilities">
            <span>
              <Icon name="layers" size={15} />
              DICOM series
            </span>
            <i />
            <span>
              <Icon name="tag" size={15} />
              Anatomical labels
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
const findingColor = (f, draft) =>
  draft ? '#ffffff' : f.status === 'unreviewed' ? '#ff9f6b' : '#f5c96a';
function draftSizes(frame, draft) {
  const long = lineLength(frame, draft.long),
    short = lineLength(frame, draft.short);
  return { longMm: long?.value ?? null, shortMm: short?.value ?? null, unit: long?.unit };
}
const liveRoi = (drag, pixels, frame) => {
  const radius = Math.hypot(drag[1][0] - drag[0][0], drag[1][1] - drag[0][1]);
  return {
    center: drag[0],
    radius,
    stats: radius >= 1 ? roiStats(pixels, frame, drag[0], radius) : null,
  };
};
function RoiCircle({ roi, transform, color, label }) {
  const [cx, cy] = pixelToScreen(transform, roi.center);
  // Pixels may be non-square, so a pixel-space circle is drawn as an ellipse on screen.
  const rx = roi.radius * transform.sx,
    ry = roi.radius * transform.sy;
  const text = `${label ? `${label} · ` : ''}${formatHu(roi.stats)}`;
  return (
    <g className="roi-circle">
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={cx} cy={cy} r="1.8" fill={color} />
      {roi.stats && (
        <text x={cx + rx + 6} y={cy + 4} fill={color}>
          {text}
        </text>
      )}
    </g>
  );
}
function Calipers({ finding, transform, selected, draft, onSelect, approx }) {
  const color = findingColor(finding, draft);
  if (!finding.long)
    return finding.roi ? (
      <g
        className={`calipers ${selected ? 'selected' : ''}`}
        onPointerDown={(e) => onSelect && e.stopPropagation()}
        onClick={() => onSelect?.(finding.id)}
      >
        <RoiCircle roi={finding.roi} transform={transform} color={color} label={finding.label} />
      </g>
    ) : null;
  const project = (line) => line?.map((p) => pixelToScreen(transform, p));
  const long = project(finding.long),
    short = project(finding.short);
  const tag = `${finding.label ? `${finding.label} · ` : ''}${formatSize(finding, { approx })}`;
  const anchor = long[0][0] > long[1][0] ? long[0] : long[1];
  const dashed = finding.status === 'unreviewed' && !draft;
  return (
    <g
      className={`calipers ${selected ? 'selected' : ''} ${draft ? 'draft' : ''}`}
      onPointerDown={(e) => onSelect && e.stopPropagation()}
      onClick={() => onSelect?.(finding.id)}
    >
      {finding.roi && !draft && <RoiCircle roi={finding.roi} transform={transform} color={color} />}
      {[long, short].filter(Boolean).map((line, i) => (
        <g key={i}>
          <line
            x1={line[0][0]}
            y1={line[0][1]}
            x2={line[1][0]}
            y2={line[1][1]}
            stroke={color}
            strokeWidth={selected ? 2.2 : 1.6}
            strokeDasharray={i === 1 || dashed ? '5 3' : undefined}
          />
          {line.map((p, j) => (
            <circle key={j} cx={p[0]} cy={p[1]} r={selected ? 3.5 : 2.6} fill={color} />
          ))}
        </g>
      ))}
      {finding.longMm != null && (
        <text x={anchor[0] + 8} y={anchor[1] - 8} fill={color}>
          {tag}
        </text>
      )}
    </g>
  );
}
// `bounds` is the visible [left, right] range, so the size label never runs off the image.
function drawCalipers(ctx, transform, finding, selected, bounds, approx) {
  const color = findingColor(finding);
  const project = (line) => line?.map((p) => pixelToScreen(transform, p));
  const lines = [project(finding.long), project(finding.short)];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (finding.roi) {
    const [cx, cy] = pixelToScreen(transform, finding.roi.center);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      finding.roi.radius * transform.sx,
      finding.roi.radius * transform.sy,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    if (!finding.long) {
      ctx.font = '600 13px Inter, Segoe UI, sans-serif';
      const tag = `${finding.label} · ${formatHu(finding.roi.stats)}`;
      const x = cx + finding.roi.radius * transform.sx + 6;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5, 10, 13, 0.85)';
      ctx.strokeText(tag, x, cy + 4);
      ctx.fillText(tag, x, cy + 4);
      return;
    }
  }
  lines.forEach((line, i) => {
    if (!line) return;
    ctx.lineWidth = selected ? 2.2 : 1.6;
    ctx.setLineDash(i === 1 ? [5, 3] : []);
    ctx.beginPath();
    ctx.moveTo(...line[0]);
    ctx.lineTo(...line[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of line) {
      ctx.beginPath();
      ctx.arc(...p, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const long = lines[0],
    right = long[0][0] > long[1][0] ? long[0] : long[1],
    left = right === long[0] ? long[1] : long[0];
  ctx.font = '600 13px Inter, Segoe UI, sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5, 10, 13, 0.85)';
  const tag = `${finding.label} · ${formatSize(finding, { approx })}`,
    width = ctx.measureText(tag).width;
  let x = right[0] + 8,
    y = right[1] - 8;
  if (bounds && x + width > bounds[1] - 4) {
    x = Math.max(bounds[0] + 4, left[0] - 8 - width);
    y = left[1] - 8;
  }
  ctx.strokeText(tag, x, y);
  ctx.fillText(tag, x, y);
}
export default DicomViewer;
