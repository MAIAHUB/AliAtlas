'use client';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  imageTransform,
  screenToPixel,
  windowPixel,
  orientationLabels,
  clamp,
} from '../lib/geometry.js';
import { layoutLabels, drawLabels } from '../lib/label-layout.js';
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
    cache = useRef(new Map()),
    drag = useRef(null),
    live = useRef({});
  const [size, setSize] = useState({ width: 800, height: 600 }),
    [loaded, setLoaded] = useState(null),
    [error, setError] = useState('');
  const transform = useMemo(
    () => (frame ? imageTransform(frame, size.width, size.height, zoom, pan) : null),
    [frame, size, zoom, pan],
  );
  const ready = Boolean(frame && loaded?.frameId === frame.id);
  useEffect(() => {
    onReady?.(ready && !error);
  }, [ready, error, onReady]);
  const placed = useMemo(
    () =>
      ready && showLabels && transform
        ? layoutLabels(labels, transform, size.width, size.height)
        : [],
    [ready, showLabels, labels, transform, size],
  );
  const directions = orientationLabels(frame);
  live.current = { onSlice, index, count: series?.frames.length || 0, zoom, setZoom };
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
    cache.current.clear();
    setLoaded(null);
  }, [studyId, series?.id]);
  useEffect(() => {
    if (!frame) return;
    const controller = new AbortController(),
      key = `${studyId}/${series.id}/${frame.id}`;
    setError('');
    if (cache.current.has(key)) {
      setLoaded({ frameId: frame.id, pixels: cache.current.get(key) });
      return;
    }
    (async () => {
      const response = await fetch(
        `/api/studies/${studyId}/pixels?series=${series.id}&frame=${frame.id}`,
        { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error((await response.json()).error || 'The CT slice could not be loaded.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== frame.rows * frame.columns * 4)
        throw new Error('The pixel response is incomplete.');
      const view = new DataView(bytes),
        pixels = new Float32Array(frame.rows * frame.columns);
      for (let i = 0; i < pixels.length; i++) pixels[i] = view.getFloat32(i * 4, true);
      if (controller.signal.aborted) return;
      cache.current.set(key, pixels);
      while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value);
      setLoaded({ frameId: frame.id, pixels });
    })().catch((e) => {
      if (e.name !== 'AbortError') setError(e.message);
    });
    return () => controller.abort();
  }, [studyId, series?.id, frame?.id]);
  useEffect(() => {
    const surface = canvas.current,
      ratio = window.devicePixelRatio || 1;
    surface.width = Math.round(size.width * ratio);
    surface.height = Math.round(size.height * ratio);
    const ctx = surface.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#030709';
    ctx.fillRect(0, 0, size.width, size.height);
    if (!ready || !frame || !transform || error) return;
    const source = document.createElement('canvas');
    source.width = frame.columns;
    source.height = frame.rows;
    const sourceContext = source.getContext('2d'),
      pixels = sourceContext.createImageData(frame.columns, frame.rows);
    for (let i = 0; i < loaded.pixels.length; i++) {
      const v = windowPixel(
        loaded.pixels[i],
        windowing.center,
        windowing.width,
        frame.inverted !== invert,
      );
      pixels.data[i * 4] = v;
      pixels.data[i * 4 + 1] = v;
      pixels.data[i * 4 + 2] = v;
      pixels.data[i * 4 + 3] = 255;
    }
    sourceContext.putImageData(pixels, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      source,
      transform.x,
      transform.y,
      frame.columns * transform.sx,
      frame.rows * transform.sy,
    );
  }, [loaded, ready, frame, transform, size, windowing, invert, error]);
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
                    d={`M ${item.side === 'left' ? item.x + item.width : item.x} ${item.y + 15} L ${item.anchor[0]} ${item.anchor[1]}`}
                    stroke={item.color}
                  />
                  <circle
                    cx={item.anchor[0]}
                    cy={item.anchor[1]}
                    r="3.5"
                    fill="#030709"
                    stroke={item.color}
                  />
                  <rect
                    x={item.x}
                    y={item.y}
                    width={item.width}
                    height="30"
                    rx="2"
                    role="button"
                    tabIndex="0"
                    aria-label={`Select ${item.label}`}
                  />
                  <text x={item.x + 8} fill={item.color}>
                    {item.lines.map((line, i) => (
                      <tspan
                        key={i}
                        x={item.x + 8}
                        y={item.y + (item.lines.length === 1 ? 19 : 12 + i * 12)}
                      >
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
          {!ready && !error && (
            <div className="viewport-message">
              <span className="spinner" />
              Loading CT slice
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
