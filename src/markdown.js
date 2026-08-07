// Small terminal-first Markdown layout. It deliberately keeps the supported
// surface focused on things that remain legible in a cell grid: headings,
// lists, quotes, rules, fenced code, tables, emphasis, inline code, and links.

import { ATTR_BOLD, ATTR_ITALIC, ATTR_UNDER, charWidth, strWidth } from './ansi.js';
import { wrapText } from './wrap.js';

/** Turn Markdown source into width-bounded render lines. */
export function markdownLayout(source, width, enabled = true) {
  const w = Math.max(2, width);
  if (!enabled) return plainLayout(source, w);

  const lines = [];
  let inCode = false;

  const sourceLines = String(source ?? '').split('\n');
  for (let sourceIndex = 0; sourceIndex < sourceLines.length; sourceIndex++) {
    const raw = sourceLines[sourceIndex];
    const fence = /^\s*```\s*([^`]*)$/.exec(raw);
    if (fence) {
      inCode = !inCode;
      lines.push({ kind: 'fence', text: fence[1].trim(), opening: inCode });
      continue;
    }

    if (inCode) {
      for (const text of wrapText(raw, Math.max(2, w - 2))) {
        lines.push({ kind: 'code', text });
      }
      continue;
    }

    // GFM-style table: a pipe row followed immediately by a delimiter row.
    // Parse it before horizontal rules, because a delimiter is mostly hyphens.
    const header = splitTableRow(raw);
    const delimiter = sourceIndex + 1 < sourceLines.length
      ? splitTableRow(sourceLines[sourceIndex + 1])
      : null;
    const aligns = delimiter?.map(tableAlignment);
    if (header?.length && delimiter?.length === header.length && aligns.every(Boolean)) {
      const rows = [];
      let next = sourceIndex + 2;
      while (next < sourceLines.length) {
        const row = splitTableRow(sourceLines[next]);
        if (!row) break;
        rows.push(Array.from({ length: header.length }, (_, i) => row[i] ?? ''));
        next++;
      }
      pushTable(lines, header, rows, aligns, w);
      sourceIndex = next - 1;
      continue;
    }

    if (!raw.trim()) {
      lines.push({ kind: 'blank', text: '' });
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      lines.push({ kind: 'hr', text: '' });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      pushStyled(lines, heading[2], w, 'h', { level: heading[1].length });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      pushStyled(lines, quote[1], Math.max(2, w - 2), 'quote');
      continue;
    }

    const item = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(raw);
    if (item) {
      const indent = Math.min(6, Math.floor(item[1].length / 2) * 2);
      const marker = /^\d/.test(item[2]) ? item[2] : '•';
      const room = Math.max(2, w - indent - strWidth(marker) - 1);
      const wrapped = wrapInline(item[3], room);
      wrapped.forEach((line, i) => lines.push({
        ...line,
        kind: i ? 'licont' : 'li',
        marker,
        indent,
      }));
      continue;
    }

    pushStyled(lines, raw, w, 'p');
  }

  return lines.length ? lines : [{ kind: 'blank', text: '' }];
}

function plainLayout(source, width) {
  const out = [];
  for (const raw of String(source ?? '').split('\n')) {
    for (const text of wrapText(raw, width)) out.push({ kind: 'p', text });
  }
  return out.length ? out : [{ kind: 'p', text: '' }];
}

function pushStyled(out, raw, width, kind, extra = {}) {
  for (const line of wrapInline(raw, width)) out.push({ ...line, kind, ...extra });
}

/** Parse inline Markdown and wrap it without losing style boundaries. */
export function wrapInline(source, width) {
  const units = inlineUnits(String(source ?? ''));
  const tokens = [];
  let token = [];
  let tokenType = '';

  const flush = () => {
    if (token.length) tokens.push(token);
    token = [];
    tokenType = '';
  };

  for (const unit of units) {
    const type = /^\s$/.test(unit.ch) ? 'space' : unit.width === 2 ? 'wide' : 'word';
    if (type === 'wide') {
      flush();
      tokens.push([unit]);
    } else if (tokenType && type !== tokenType) {
      flush();
      tokenType = type;
      token.push(unit);
    } else {
      tokenType = type;
      token.push(unit);
    }
  }
  flush();

  const rows = [];
  let row = [];
  let rowW = 0;
  const land = () => {
    while (row.length && /^\s$/.test(row[row.length - 1].ch)) row.pop();
    rows.push(makeLine(row));
    row = [];
    rowW = 0;
  };

  for (const tk of tokens) {
    const tw = tk.reduce((n, u) => n + u.width, 0);
    const space = tk.every((u) => /^\s$/.test(u.ch));
    if (space && rowW === 0) continue;
    if (rowW + tw <= width) {
      row.push(...tk);
      rowW += tw;
      continue;
    }
    if (row.length) land();
    if (space) continue;

    for (const unit of tk) {
      if (rowW + unit.width > width && row.length) land();
      row.push(unit);
      rowW += unit.width;
    }
  }
  if (row.length || !rows.length) land();
  return rows;
}

function makeLine(units) {
  const runs = [];
  for (const unit of units) {
    const prev = runs[runs.length - 1];
    if (prev && sameStyle(prev, unit)) prev.text += unit.ch;
    else runs.push({
      text: unit.ch,
      attrs: unit.attrs,
      code: unit.code,
      strike: unit.strike,
      link: unit.link,
    });
  }
  return { text: units.map((u) => u.ch).join(''), runs };
}

function sameStyle(a, b) {
  return a.attrs === b.attrs && a.code === b.code && a.strike === b.strike && a.link === b.link
    && a.tableBorder === b.tableBorder && a.tableStrong === b.tableStrong;
}

/** Split unescaped, non-code pipes while retaining Markdown inside each cell. */
function splitTableRow(raw) {
  const text = String(raw ?? '').trim();
  if (!text.includes('|')) return null;
  const cells = [];
  let cell = '';
  let inCode = false;
  let sawPipe = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      cell += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cell += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      sawPipe = true;
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  if (!sawPipe) return null;
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells.length ? cells : null;
}

function tableAlignment(cell) {
  const match = /^(:)?-{3,}(:)?$/.exec(String(cell ?? '').trim());
  if (!match) return null;
  if (match[1] && match[2]) return 'center';
  if (match[2]) return 'right';
  return 'left';
}

/** Expand a logical Markdown table into width-safe physical terminal rows. */
function pushTable(out, header, rows, aligns, width) {
  const columns = header.length;
  // At extreme widths, a grid would leave every cell one column wide. A stacked
  // record remains readable and still removes the Markdown table punctuation.
  if (width < columns * 4 + 1) {
    const labels = header.map((cell, i) => plainCell(cell) || `column ${i + 1}`);
    const records = rows.length ? rows : [header];
    for (let rowIndex = 0; rowIndex < records.length; rowIndex++) {
      for (let col = 0; col < columns; col++) {
        pushStyled(out, `${labels[col]}: ${records[rowIndex][col] ?? ''}`, width, 'p', { tableStack: true });
      }
      if (rowIndex < records.length - 1) out.push({ kind: 'blank', text: '' });
    }
    return;
  }

  const allRows = [header, ...rows];
  const plainRows = allRows.map((row) => row.map(plainCell));
  const natural = Array.from({ length: columns }, (_, col) => Math.max(1, ...plainRows.map((row) => strWidth(row[col] ?? ''))));
  const headerWidths = plainRows[0].map((cell) => Math.max(1, strWidth(cell)));
  const padding = width >= columns * 6 + 1 ? 1 : 0;
  const overhead = columns + 1 + columns * padding * 2;
  const contentBudget = Math.max(columns, width - overhead);
  const widths = fitTableColumns(natural, headerWidths, contentBudget);

  out.push({ kind: 'tableRule', text: tableRule(widths, padding, 'top'), tableEdge: 'top' });
  pushTableRow(out, header, widths, aligns, padding, { header: true, stripe: false });
  out.push({ kind: 'tableRule', text: tableRule(widths, padding, 'middle'), tableEdge: 'middle' });
  rows.forEach((row, index) => pushTableRow(out, row, widths, aligns, padding, {
    header: false,
    stripe: index % 2 === 1,
  }));
  out.push({ kind: 'tableRule', text: tableRule(widths, padding, 'bottom'), tableEdge: 'bottom' });
}

function plainCell(source) {
  return wrapInline(source, 1000000).map((line) => line.text).join('');
}

function fitTableColumns(natural, headerWidths, budget) {
  const widths = natural.map(() => 1);
  let room = Math.max(0, budget - widths.length);
  // Give every short field (filenames, dates, IDs) a chance to stay intact before
  // long prose columns claim the rest. Header width still matters above that cap.
  const minimum = natural.map((want, i) => Math.min(want, Math.max(10, headerWidths[i])));
  room = growColumns(widths, minimum, room);
  growColumns(widths, natural, room);
  return widths;
}

function growColumns(widths, targets, initialRoom) {
  let room = initialRoom;
  while (room > 0) {
    let best = -1;
    let pressure = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] >= targets[i]) continue;
      const next = targets[i] / widths[i];
      if (next > pressure) {
        pressure = next;
        best = i;
      }
    }
    if (best < 0) break;
    widths[best]++;
    room--;
  }
  return room;
}

function tableRule(widths, padding, edge) {
  const chars = edge === 'top'
    ? ['┌', '┬', '┐']
    : edge === 'bottom'
      ? ['└', '┴', '┘']
      : ['├', '┼', '┤'];
  return chars[0] + widths.map((w) => '─'.repeat(w + padding * 2)).join(chars[1]) + chars[2];
}

function pushTableRow(out, cells, widths, aligns, padding, { header, stripe }) {
  const wrapped = widths.map((colWidth, i) => wrapInline(cells[i] ?? '', colWidth));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  for (let lineIndex = 0; lineIndex < height; lineIndex++) {
    const runs = [];
    appendTableRun(runs, '│', { tableBorder: true, tableStrong: header });
    for (let col = 0; col < widths.length; col++) {
      const line = wrapped[col][lineIndex] ?? { text: '', runs: [] };
      const gap = Math.max(0, widths[col] - strWidth(line.text));
      const left = aligns[col] === 'right' ? gap : aligns[col] === 'center' ? Math.floor(gap / 2) : 0;
      const right = gap - left;
      appendTableRun(runs, ' '.repeat(padding + left));
      for (const run of line.runs ?? []) appendTableRun(runs, run.text, run);
      appendTableRun(runs, ' '.repeat(right + padding));
      appendTableRun(runs, '│', { tableBorder: true, tableStrong: header });
    }
    out.push({
      kind: header ? 'tableHead' : 'tableRow',
      text: runs.map((run) => run.text).join(''),
      runs,
      header,
      stripe,
    });
  }
}

function appendTableRun(runs, text, style = {}) {
  if (!text) return;
  const next = {
    text,
    attrs: style.attrs ?? 0,
    code: !!style.code,
    strike: !!style.strike,
    link: !!style.link,
    tableBorder: !!style.tableBorder,
    tableStrong: !!style.tableStrong,
  };
  const prev = runs[runs.length - 1];
  if (prev && sameStyle(prev, next)) prev.text += text;
  else runs.push(next);
}

function inlineUnits(source) {
  const out = [];
  let attrs = 0;
  let code = false;
  let strike = false;
  let italicMarker = '';

  const emit = (text, extra = {}) => {
    for (const ch of text) {
      const width = charWidth(ch.codePointAt(0));
      if (width === 0 && out.length) {
        out[out.length - 1].ch += ch;
        continue;
      }
      out.push({ ch, width: width || 1, attrs, code, strike, link: false, ...extra });
    }
  };

  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && i + 1 < source.length) {
      emit(source[i + 1]);
      i += 2;
      continue;
    }
    if (source[i] === '`' && (code || source.indexOf('`', i + 1) > i + 1)) {
      code = !code;
      i++;
      continue;
    }
    if (!code && source.startsWith('**', i)
      && ((attrs & ATTR_BOLD) || source.indexOf('**', i + 2) > i + 2)) {
      attrs ^= ATTR_BOLD;
      i += 2;
      continue;
    }
    if (!code && source.startsWith('~~', i)
      && (strike || source.indexOf('~~', i + 2) > i + 2)) {
      strike = !strike;
      i += 2;
      continue;
    }
    if (!code && (source[i] === '*' || source[i] === '_')) {
      const marker = source[i];
      const prev = source[i - 1] ?? '';
      const next = source[i + 1] ?? '';
      const insideWord = marker === '_' && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next);
      if (italicMarker === marker || (!italicMarker && !insideWord && source.indexOf(marker, i + 1) > i + 1)) {
        italicMarker = italicMarker ? '' : marker;
        attrs ^= ATTR_ITALIC;
        i++;
        continue;
      }
    }
    if (!code && source[i] === '[') {
      const close = source.indexOf('](', i + 1);
      const end = close >= 0 ? source.indexOf(')', close + 2) : -1;
      if (close >= 0 && end >= 0) {
        emit(source.slice(i + 1, close), { attrs: attrs | ATTR_UNDER, link: true });
        i = end + 1;
        continue;
      }
    }
    emit(source[i]);
    i++;
  }
  return out;
}
