import { pixelToScreen, clamp } from './geometry.js';

export const LABEL_FONT = { size: 13, lineHeight: 16, charWidth: 7.3, padX: 10 };
const GAP = 6,
  EDGE = 10,
  IMAGE_GAP = 18;

function wrap(label, maxChars) {
  const lines = [''];
  for (const word of label.split(' ')) {
    let n = lines.length - 1;
    if (lines[n] && lines[n].length + word.length + 1 > maxChars && lines.length < 2) {
      lines.push('');
      n++;
    }
    lines[n] += (lines[n] ? ' ' : '') + word;
  }
  if (lines[lines.length - 1].length > maxChars)
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, maxChars - 1) + '…';
  return lines;
}

// Places labels in a column on each side, beside the image rather than at the
// viewport edge, so leader lines stay short. `image` is [left, right] in screen px.
export function layoutLabels(labels, transform, width, height, image) {
  const preferred = width > 800 ? 196 : width > 560 ? 152 : 118;
  const [imageLeft, imageRight] = image || [EDGE + preferred, width - EDGE - preferred];
  // Narrow the columns to the free space beside the image before overlapping it.
  const space = Math.min(imageLeft, width - imageRight) - EDGE;
  const boxWidth = clamp(space - 8, 118, preferred);
  const gap = clamp(space - boxWidth, 0, IMAGE_GAP);
  const maxChars = Math.floor((boxWidth - LABEL_FONT.padX * 2) / LABEL_FONT.charWidth);
  const columnX = {
    left: clamp(imageLeft - boxWidth - gap, EDGE, width - boxWidth - EDGE),
    right: clamp(imageRight + gap, EDGE, width - boxWidth - EDGE),
  };
  const top = 42,
    bottom = height - 50;
  const output = [];
  for (const side of ['left', 'right']) {
    const group = labels
      .filter((a) => a.side === side)
      .map((a) => {
        const lines = wrap(a.label, maxChars);
        return {
          ...a,
          anchor: pixelToScreen(transform, a.pixel),
          lines,
          height: lines.length === 1 ? 30 : 30 + LABEL_FONT.lineHeight,
        };
      })
      .filter(
        (a) =>
          a.anchor[0] >= 0 && a.anchor[0] <= width && a.anchor[1] >= 0 && a.anchor[1] <= height,
      )
      .sort((a, b) => a.anchor[1] - b.anchor[1]);
    // Keep as many as fit, preferring the order the user sees top to bottom.
    const shown = [];
    let used = 0;
    for (const a of group) {
      if (used + a.height > bottom - top) break;
      shown.push(a);
      used += a.height + GAP;
    }
    // Place each box near its anchor, pushing down to avoid overlap, then pull
    // back up from the bottom so the column never runs off the viewport.
    let cursor = top;
    const ys = shown.map((a) => {
      const y = Math.max(cursor, a.anchor[1] - a.height / 2);
      cursor = y + a.height + GAP;
      return y;
    });
    let limit = bottom;
    for (let i = shown.length - 1; i >= 0; i--) {
      ys[i] = Math.min(ys[i], limit - shown[i].height);
      limit = ys[i] - GAP;
    }
    shown.forEach((a, i) =>
      output.push({ ...a, x: columnX[side], y: Math.max(top, ys[i]), width: boxWidth }),
    );
  }
  return output;
}

export const labelEdge = (item) => (item.side === 'left' ? item.x + item.width : item.x);
export const lineY = (item, i) =>
  item.y + item.height / 2 + (i - (item.lines.length - 1) / 2) * LABEL_FONT.lineHeight + 4.5;

// Canvas rendering used for PNG export; mirrors the on-screen SVG styling.
export function drawLabels(ctx, items, selectedId) {
  for (const item of items) {
    const selected = item.id === selectedId;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(labelEdge(item), item.y + item.height / 2);
    ctx.lineTo(...item.anchor);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = item.color;
    ctx.strokeStyle = '#050a0d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(...item.anchor, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = selected ? 'rgba(30, 58, 50, 0.96)' : 'rgba(9, 16, 21, 0.92)';
    ctx.fillRect(item.x, item.y, item.width, item.height);
    ctx.strokeStyle = item.color;
    ctx.globalAlpha = selected ? 1 : 0.45;
    ctx.lineWidth = 1;
    ctx.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = item.color;
    ctx.font = `600 ${LABEL_FONT.size}px Inter, 'Segoe UI', sans-serif`;
    item.lines.forEach((line, i) => ctx.fillText(line, item.x + LABEL_FONT.padX, lineY(item, i)));
  }
}
