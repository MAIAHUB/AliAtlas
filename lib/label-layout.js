import { pixelToScreen, clamp } from './geometry.js';

export function layoutLabels(labels, transform, width, height) {
  const boxWidth = width > 800 ? 174 : width > 560 ? 136 : 110;
  const limit = Math.max(1, Math.floor((height - 125) / 36));
  const output = [];
  for (const side of ['left', 'right']) {
    const group = labels
      .filter((a) => a.side === side)
      .map((a) => ({ ...a, anchor: pixelToScreen(transform, a.pixel) }))
      .filter(
        (a) =>
          a.anchor[0] >= 0 && a.anchor[0] <= width && a.anchor[1] >= 0 && a.anchor[1] <= height,
      )
      .sort((a, b) => a.anchor[1] - b.anchor[1])
      .slice(0, limit);
    let last = 45;
    group.forEach((a, i) => {
      const y = clamp(a.anchor[1] - 14, last, height - 60 - (group.length - 1 - i) * 36);
      last = y + 36;
      const maxChars = Math.floor((boxWidth - 16) / 6.1);
      const words = a.label.split(' '),
        lines = [''];
      for (const word of words) {
        let n = lines.length - 1;
        if (lines[n] && lines[n].length + word.length + 1 > maxChars && lines.length < 2) {
          lines.push('');
          n++;
        }
        lines[n] += (lines[n] ? ' ' : '') + word;
      }
      if (lines[lines.length - 1].length > maxChars)
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, maxChars - 1) + '…';
      output.push({
        ...a,
        x: side === 'left' ? 14 : width - boxWidth - 14,
        y,
        width: boxWidth,
        height: 30,
        lines,
      });
    });
  }
  return output;
}

export function drawLabels(ctx, items, selectedId) {
  for (const item of items) {
    const edge = item.side === 'left' ? item.x + item.width : item.x;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.id === selectedId ? 1.5 : 0.8;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(edge, item.y + 15);
    ctx.lineTo(...item.anchor);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#080e12';
    ctx.beginPath();
    ctx.arc(...item.anchor, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = item.id === selectedId ? '#244039' : '#142029';
    ctx.fillRect(item.x, item.y, item.width, 30);
    ctx.fillStyle = item.color;
    ctx.font = '11px sans-serif';
    item.lines.forEach((line, i) =>
      ctx.fillText(line, item.x + 8, item.y + (item.lines.length === 1 ? 19 : 12 + i * 12)),
    );
  }
}
