'use client';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  imageTransform,
  screenToPixel,
  windowPixel,
  orientationLabels,
  clamp,
} from '../lib/geometry.js';
import { layoutLabels, drawLabels, labelEdge, lineY } from '../lib/label-layout.js';
import { SliceLoader } from '../lib/slice-loader.js';
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
    }),
    [ready, error, size, placed, selectedId, series, index, windowing],
  );
  function pointerDown(e) {
    if (!frame || !ready || error || e.button !== 0) return;
    const rect = host.current.getBoundingClientRect();
    if (mode === 'label') {
      const pixel = screenToPixel(transform, [e.clientX - rect.left, e.clientY - rect.top]);
      if (
        pixel[0] >= 0 &&
        pixel[0] <= frame.columns - 1 &&
        pixel[1] >= 0 &&
        pixel[1] <= frame.rows - 1
      )
        onAdd(pixel);
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
      }}
      onPointerCancel={() => {
        drag.current = null;
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
export default DicomViewer;
