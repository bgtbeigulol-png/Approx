import { clamp } from './anim.js';
import { strWidth } from './ansi.js';
import { layout } from './ui/transcript.js';

export function totalChars(message, width) {
  let count = 0;
  for (const line of layout(message, width)) count += strWidth(line.text);
  return count;
}

/** Clamp a terminal selection to the transcript viewport and expand it by row. */
export function selectionRanges(selection, viewport) {
  const pin = (point) => ({
    x: clamp(point.x, viewport.x, viewport.x + viewport.w - 1),
    y: clamp(point.y, viewport.y, viewport.y + viewport.h - 1),
  });
  const a = pin(selection.anchor);
  const b = pin(selection.focus);
  const forward = a.y < b.y || (a.y === b.y && a.x <= b.x);
  const start = forward ? a : b;
  const end = forward ? b : a;
  const ranges = [];
  for (let y = start.y; y <= end.y; y++) {
    ranges.push({
      y,
      x1: y === start.y ? start.x : viewport.x,
      x2: y === end.y ? end.x : viewport.x + viewport.w - 1,
    });
  }
  return ranges;
}
