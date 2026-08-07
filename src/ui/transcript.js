// Scrolling transcript. Each message enters with a slide + gutter-bar wipe;
// the streaming message reveals character by character with a live caret.

import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, DASH, MARK, HEAVY, LIGHT, SPIN_BRAILLE } from '../glyphs.js';
import { T, ROLE, mix } from '../theme.js';
import { ease, clamp, norm } from '../anim.js';
import { rule, vrule, panel, textReveal, bar } from '../draw.js';
import { wrapText, ellipsize } from '../wrap.js';
import { markdownLayout } from '../markdown.js';

const GUTTER = 3; // bar + gap

/** Lay a message out into renderable lines. Cached on the message object. */
export function layout(msg, w) {
  if (msg.role === 'system' && msg.subtype === 'changeset') return changesetLayout(msg, w);
  if (msg.role === 'workgroup') return workGroupLayout(msg, w);
  if (msg.role === 'toolgroup') return toolGroupLayout(msg, w);
  const markdown = msg.markdown !== false;
  if (msg._lw === w && msg._md === markdown && msg._lines) return msg._lines;
  const body = w - GUTTER;
  const lines = [];
  if (msg.role === 'tool') {
    lines.push({ kind: 'toolhead', text: msg.title ?? msg.name ?? 'tool', meta: msg.meta });
    for (const l of wrapText(msg.text, body - 2)) lines.push({ kind: 'toolbody', text: l });
  } else {
    const parsed = markdownLayout(msg.text, body, markdown);
    for (const line of parsed) lines.push(msg.role === 'system' ? { ...line, kind: 'sys' } : line);
  }
  msg._lines = lines;
  msg._lw = w;
  msg._md = markdown;
  return lines;
}

/**
 * Clear cached layouts, including the nested tool nodes inside an archived turn.
 * History messages are mostly immutable, but live tool updates and a resize can
 * change any of these nodes after the parent group has already been measured.
 */
export function invalidateLayoutTree(messages) {
  const visit = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    msg._lines = null;
    msg._lw = -1;
    msg._md = null;
    msg._layoutMode = -1;
    for (const note of msg.notes ?? []) visit(note);
    for (const group of msg.tools ?? []) visit(group);
  };
  for (const msg of messages ?? []) visit(msg);
}

export function visibleLines(msg, w) {
  const lines = layout(msg, w);
  if (msg.role === 'system' && msg.subtype === 'changeset') {
    const p = clamp(msg.expandAnim?.v ?? (msg.expanded ? 1 : 0), 0, 1);
    const rows = Math.ceil(Math.max(0, lines.length - 1) * ease.outCubic(p));
    return lines.slice(0, 1 + rows);
  }
  if (msg.role === 'workgroup') {
    const outerP = clamp(msg.expandAnim?.v ?? (msg.expanded ? 1 : 0), 0, 1);
    if (outerP <= 0.001) return lines.slice(0, 1);
    const nested = [lines[0]];
    for (const line of lines.slice(1)) {
      nested.push(line);
      if (line.kind !== 'worktoolhead') continue;
      const children = visibleToolGroupChildren(line.group, w, true);
      nested.push(...children);
    }
    const outerRows = Math.ceil(Math.max(0, nested.length - 1) * ease.outCubic(outerP));
    return nested.slice(0, 1 + outerRows);
  }
  if (msg.role === 'toolgroup') {
    const outerP = clamp(msg.expandAnim?.v ?? (msg.expanded ? 1 : 0), 0, 1);
    if (outerP <= 0.001) return lines.slice(0, 1);
    const nested = [lines[0], ...visibleToolGroupChildren(msg, w)];
    const outerRows = Math.ceil(Math.max(0, nested.length - 1) * ease.outCubic(outerP));
    return nested.slice(0, 1 + outerRows);
  }
  if (msg.role !== 'tool') return lines;
  const p = clamp(msg.expandAnim?.v ?? (msg.expanded ? 1 : 0), 0, 1);
  const body = Math.ceil(Math.max(0, lines.length - 1) * ease.outCubic(p));
  return lines.slice(0, 1 + body);
}

function changesetLayout(message, w) {
  const open = layoutMode(message) === 1;
  if (message._lw === w && message._layoutMode === (open ? 1 : 0) && message._lines) return message._lines;
  const lines = [{ kind: 'changesethead', text: message.title || 'FILE CHANGES', changeset: message }];
  if (open) {
    for (const file of message.files ?? []) {
      lines.push({ kind: 'changefilehead', text: file.displayPath || file.path, file });
      if (file.binary) {
        lines.push({ kind: 'changediff', text: 'binary content changed', file,
          diffKind: 'meta', oldLine: null, newLine: null });
        continue;
      }
      for (const row of file.diff ?? []) {
        lines.push({
          kind: 'changediff',
          text: row.text,
          file,
          diffKind: row.kind,
          oldLine: row.oldLine,
          newLine: row.newLine,
        });
      }
    }
  }
  message._lines = lines;
  message._lw = w;
  message._layoutMode = open ? 1 : 0;
  return lines;
}

function toolGroupLayout(group, w) {
  const open = layoutMode(group) === 1;
  if (group._lw === w && group._layoutMode === (open ? 1 : 0) && group._lines) return group._lines;
  const body = Math.max(4, w - GUTTER);
  const lines = [{ kind: 'toolgrouphead', text: group.title || 'Grouped tool work', group }];
  if (!open) {
    group._lines = lines;
    group._lw = w;
    group._layoutMode = 0;
    return lines;
  }
  const tools = group.tools ?? [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    lines.push({
      kind: 'toolchildhead',
      text: tool.title ?? tool.name ?? 'tool',
      meta: tool.meta,
      tool,
      last: i === tools.length - 1,
    });
    if (tool.text) {
      for (const text of wrapText(tool.text, Math.max(2, body - 5))) {
        lines.push({ kind: 'toolchildbody', text, tool, last: i === tools.length - 1 });
      }
    }
  }
  group._lines = lines;
  group._lw = w;
  group._layoutMode = 1;
  return lines;
}

function workGroupLayout(group, w) {
  const open = layoutMode(group) === 1;
  if (group._lw === w && group._layoutMode === (open ? 1 : 0) && group._lines) return group._lines;
  const body = Math.max(4, w - GUTTER);
  const lines = [{ kind: 'workgrouphead', text: group.title || 'Work', group }];
  if (!open) {
    group._lines = lines;
    group._lw = w;
    group._layoutMode = 0;
    return lines;
  }
  for (const note of group.notes ?? []) {
    const text = compactWorkNote(note?.text);
    const wrapped = wrapText(text, Math.max(2, body - 11));
    for (let i = 0; i < (wrapped.length ? wrapped.length : 1); i++) {
      const line = wrapped[i] ?? '';
      lines.push({ kind: 'worknote', text: `${i === 0 ? 'Note · ' : '       '}${line}`, note });
    }
  }
  for (const toolGroup of group.tools ?? []) {
    const title = String(toolGroup.title || '').trim();
    const label = /^tool calls\b/i.test(title) ? title : `Tool Calls${title ? ` · ${title}` : ''}`;
    lines.push({ kind: 'worktoolhead', text: label, group: toolGroup });
  }
  group._lines = lines;
  group._lw = w;
  group._layoutMode = 1;
  return lines;
}

/** Keep collapsed groups to their one visible header line until they open. */
function layoutMode(msg) {
  return msg.expanded || (msg.expandAnim?.v ?? 0) > 0.001 ? 1 : 0;
}

function compactWorkNote(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim() || 'progress';
}

function visibleToolGroupChildren(group, w, nested = false) {
  const lines = toolGroupLayout(group, w).slice(1);
  const visible = [];
  for (let i = 0; i < lines.length;) {
    const head = lines[i++];
    visible.push(nested ? { ...head, workNested: true } : head);
    const body = [];
    while (i < lines.length && lines[i].kind === 'toolchildbody' && lines[i].tool === head.tool) body.push(lines[i++]);
    const childP = clamp(head.tool?.expandAnim?.v ?? (head.tool?.expanded ? 1 : 0), 0, 1);
    const childRows = Math.ceil(body.length * ease.outCubic(childP));
    for (const line of body.slice(0, childRows)) visible.push(nested ? { ...line, workNested: true } : line);
  }
  const outerP = clamp(group.expandAnim?.v ?? (group.expanded ? 1 : 0), 0, 1);
  return visible.slice(0, Math.ceil(visible.length * ease.outCubic(outerP)));
}

/** Total rows a message occupies, including its trailing gap. */
export function msgHeight(msg, w) {
  return visibleLines(msg, w).length + 2; // header row + blank spacer
}

export function totalHeight(msgs, w) {
  let n = 0;
  for (const m of msgs) n += msgHeight(m, w);
  return n;
}

/**
 * Render the transcript into the viewport.
 * `scroll` is rows from the top of the full document.
 */
export function drawTranscript(s, msgs, x, y, w, h, scroll, t) {
  let cursor = -scroll;
  let codeMode = false;

  for (const msg of msgs) {
    const mh = msgHeight(msg, w);
    if (cursor + mh <= 0) {
      cursor += mh;
      continue;
    }
    if (cursor >= h) break;
    drawMessage(s, msg, x, y + cursor, w, { top: y, bottom: y + h - 1 }, t);
    cursor += mh;
  }

  // top / bottom fade so content dissolves into the chrome instead of clipping hard
  edgeFade(s, x, y, w, h, scroll > 0, cursor > h);
  return cursor;
}

function edgeFade(s, x, y, w, h, above, below) {
  if (above) {
    for (let i = 0; i < w; i++) {
      s.tint(x + i, y, mix(T.bg, T.dim, 0.35));
      s.tint(x + i, y + 1, mix(T.bg, T.dim, 0.7));
    }
  }
  if (below) {
    for (let i = 0; i < w; i++) {
      s.tint(x + i, y + h - 1, mix(T.bg, T.dim, 0.35));
      s.tint(x + i, y + h - 2, mix(T.bg, T.dim, 0.7));
    }
  }
}

function drawMessage(s, msg, x, y, w, clip, t) {
  const role = ROLE[msg.role] ?? ROLE.approx;
  const allLines = layout(msg, w);
  const lines = visibleLines(msg, w);

  // entrance: slide in from the left + fade, springy but short
  const p = ease.outQuint(clamp(msg.enter ?? 1, 0, 1));
  const dx = Math.round((1 - p) * 4);
  const fade = p;
  const selected = ease.outCubic(clamp(msg._selectAnim?.v ?? 0, 0, 1));

  const rowVisible = (ry) => ry >= clip.top && ry <= clip.bottom;

  // --- header row: role tag ---
  if (rowVisible(y)) {
    let hx = x + dx;
    const tagBg = mix(T.bg, role.bar, fade);
    const tagFg = mix(T.bg, T.bg, 1);
    const tag = msg.subtype === 'changeset' ? 'SYSTEM' : role.tag;
    s.put(hx, y, BLOCK.full, tagBg);
    hx += 1;
    hx += s.text(hx + 1, y, tag, mix(T.bg, role.color, fade), DEFAULT, ATTR_BOLD) + 1;
    let right = x + w - 1;
    if (msg.time) {
      s.textRight(right, y, msg.time, mix(T.bg, T.sand, fade * 0.9), DEFAULT, ATTR_DIM);
      right -= strWidth(msg.time) + 2;
    }
    if (msg.redoAvailable) {
      const badge = ' REDO ';
      const bw = strWidth(badge);
      const bx = right - bw + 1;
      const badgeBg = mix(T.bg, T.accent, 0.16 + 0.08 * Math.sin(t * 3.4));
      s.text(bx, y, badge, T.accent, badgeBg, ATTR_BOLD);
      msg._redoHit = { x1: bx, x2: right, y };
      right = bx - 2;
    } else {
      msg._redoHit = null;
    }
    // hairline from the tag to the timestamp
    const from = hx + 1;
    const to = right;
    for (let i = from; i < to; i++) {
      const frameFade = selected * (0.7 + 0.3 * (1 - (i - from) / Math.max(1, to - from)));
      s.put(i, y, selected > 0.02 ? HEAVY.h : LIGHT.h,
        mix(T.bg, selected > 0.02 ? T.accent : T.rule,
          Math.max(fade * 0.5 * (1 - (i - from) / Math.max(1, to - from)), frameFade * 0.42)));
    }
  }

  // --- body ---
  const streamHead = msg.streaming ? msg.streamChars ?? 0 : Infinity;
  let consumed = 0;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const ry = y + 1 + i;
    const ln = lines[i];
    const lineLen = strWidth(ln.text);

    // gutter bar — wipes downward as the message enters
    const barP = clamp((p * lines.length + 1.2 - i) / 1.6, 0, 1);
    if (rowVisible(ry) && barP > 0.05) {
      s.put(x + dx, ry, BLOCK.l2, mix(T.bg, role.bar, barP * 0.55 * fade));
    }

    if (!rowVisible(ry)) {
      consumed += lineLen;
      continue;
    }

    const bx = x + GUTTER + dx;
    const bw = w - GUTTER - dx;

    // characters available to this line under the streaming head
    const avail = streamHead - consumed;
    if (avail <= 0 && msg.streaming) break;
    let revealCols = avail >= lineLen ? lineLen : Math.max(0, avail);
    if (msg.role === 'tool' && i > 0) {
      const ep = clamp(msg.expandAnim?.v ?? (msg.expanded ? 1 : 0), 0, 1);
      const sweep = clamp(ep * Math.max(1, allLines.length - 1) - (i - 1), 0, 1);
      revealCols = Math.min(revealCols, Math.round(lineLen * ease.outQuint(sweep)));
    }
    const shown = revealCols >= lineLen ? ln.text : sliceCols(ln.text, revealCols);

    switch (ln.kind) {
      case 'fence':
        inCode = !inCode;
        drawFenceRule(s, bx, ry, bw, ln.text, fade, inCode);
        break;
      case 'h': {
        drawInline(s, bx, ry, ln, revealCols, fade, bw, T.fg, DEFAULT, ATTR_BOLD);
        break;
      }
      case 'li':
        s.text(bx, ry, `${' '.repeat(ln.indent ?? 0)}${ln.marker ?? MARK.bullet}`, mix(T.bg, T.accent, fade));
        drawInline(s, bx + (ln.indent ?? 0) + strWidth(ln.marker ?? MARK.bullet) + 1, ry,
          ln, revealCols, fade, bw - (ln.indent ?? 0) - 2, T.fg);
        break;
      case 'licont':
        drawInline(s, bx + (ln.indent ?? 0) + strWidth(ln.marker ?? MARK.bullet) + 1, ry,
          ln, revealCols, fade, bw - (ln.indent ?? 0) - 2, T.fg);
        break;
      case 'quote':
        s.put(bx, ry, LIGHT.v, mix(T.bg, T.accent2, fade));
        drawInline(s, bx + 2, ry, ln, revealCols, fade, bw - 2, T.slate, DEFAULT, ATTR_ITALIC);
        break;
      case 'hr':
        rule(s, bx, ry, bw, mix(T.bg, T.rule, fade), 0);
        break;
      case 'tableRule': {
        const color = ln.tableEdge === 'middle' ? T.accent2 : T.rule;
        s.text(bx, ry, shown, mix(T.bg, color, fade), DEFAULT, ln.tableEdge === 'middle' ? ATTR_BOLD : 0, bw);
        break;
      }
      case 'tableHead':
      case 'tableRow': {
        const rowBg = ln.kind === 'tableHead'
          ? mix(T.bg, T.inset, fade * 0.72)
          : ln.stripe
            ? mix(T.bg, T.panel, fade * 0.48)
            : T.bg;
        s.fillRect(bx, ry, Math.min(bw, lineLen), 1, ' ', T.fg, rowBg);
        drawInline(s, bx, ry, ln, revealCols, fade, bw, T.fg, rowBg, ln.kind === 'tableHead' ? ATTR_BOLD : 0);
        break;
      }
      case 'blank':
        break;
      case 'code':
        {
          const codeBg = mix(T.bg, T.panel, fade * 0.28);
          s.fillRect(bx, ry, bw, 1, ' ', T.fg, codeBg);
          s.text(bx + 1, ry, shown, mix(T.bg, T.ink, fade), codeBg, 0, bw - 2);
        }
        break;
      case 'sys':
        drawInline(s, bx, ry, ln, revealCols, fade, bw, T.dim, DEFAULT, ATTR_ITALIC);
        break;
      case 'toolhead':
        drawToolHead(s, bx, ry, bw, ln, fade, msg, t);
        break;
      case 'workgrouphead':
        drawWorkGroupHead(s, bx, ry, bw, ln, fade, msg, t);
        break;
      case 'changesethead':
        drawChangesetHead(s, bx, ry, bw, ln, fade, msg);
        break;
      case 'changefilehead':
        drawChangeFileHead(s, bx, ry, bw, ln, fade);
        break;
      case 'changediff':
        drawChangeDiff(s, bx, ry, bw, ln, fade);
        break;
      case 'worknote':
        s.put(bx, ry, LIGHT.v, mix(T.bg, T.rule, fade * 0.75));
        drawInline(s, bx + 2, ry, ln, revealCols, fade, bw - 2, T.slate, DEFAULT, ATTR_DIM);
        break;
      case 'worktoolhead':
        drawToolGroupHead(s, bx + 2, ry, Math.max(1, bw - 2), ln, fade, ln.group, t);
        break;
      case 'toolgrouphead':
        drawToolGroupHead(s, bx, ry, bw, ln, fade, msg, t);
        break;
      case 'toolchildhead':
        drawToolChildHead(s, bx + (ln.workNested ? 4 : 0), ry, Math.max(1, bw - (ln.workNested ? 4 : 0)), ln, fade, t);
        break;
      case 'toolchildbody':
        drawToolChildBody(s, bx + (ln.workNested ? 4 : 0), ry, Math.max(1, bw - (ln.workNested ? 4 : 0)), ln, shown, fade);
        break;
      case 'toolbody':
        s.put(bx, ry, LIGHT.v, mix(T.bg, T.accent2, fade * 0.5));
        s.text(bx + 2, ry, shown, mix(T.bg, T.slate, fade), DEFAULT, 0, bw - 2);
        break;
      default:
        if (inCode) {
          const codeBg = mix(T.bg, T.panel, fade * 0.28);
          s.fillRect(bx, ry, bw, 1, ' ', T.fg, codeBg);
          s.text(bx + 1, ry, shown, mix(T.bg, T.ink, fade), codeBg, 0, bw - 2);
        } else {
          drawInline(s, bx, ry, ln, revealCols, fade, bw, T.fg);
        }
    }

    // streaming caret at the head
    const liveHead = msg._live && i === lines.length - 1 && avail >= lineLen;
    if (msg.streaming && ((avail < lineLen && avail >= 0) || liveHead)) {
      const cxp = bx + strWidth(shown);
      const blink = Math.floor(t * 7) % 2 === 0;
      if (cxp < bx + bw) s.put(cxp, ry, blink ? BLOCK.full : BLOCK.l4, T.accent);
    }
    consumed += lineLen;
  }

  // First click marks an editable user turn with a restrained, slightly heavier
  // top/bottom frame. It occupies the existing header and spacer rows, so neither
  // wrapping nor the rail jumps when selection animates in.
  if (selected > 0.01) {
    const by = y + 1 + lines.length;
    if (rowVisible(by)) {
      const col = mix(T.bg, T.accent, 0.18 + selected * 0.28);
      for (let i = x + GUTTER; i < x + w; i++) s.put(i, by, HEAVY.h, col);
    }
  }
}

function drawFenceRule(s, x, y, w, lang, fade, opening) {
  const col = mix(T.bg, T.sand, fade);
  const label = opening ? (lang || 'code').toUpperCase() : '';
  let lx = x;
  if (label) {
    lx += s.text(x, y, ` ${label} `, mix(T.bg, T.bg, 1), mix(T.bg, T.slate, fade), ATTR_BOLD);
  }
  for (let i = lx; i < x + w; i++) s.put(i, y, HEAVY.h, col);
}

function drawToolHead(s, x, y, w, ln, fade, msg, t) {
  const running = msg.running;
  const icon = running ? SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length] : MARK.check;
  const iconCol = running ? T.accent : T.ok;
  let hx = x;
  s.put(hx, y, msg.expanded ? '▾' : '▸', mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD);
  hx += 2;
  s.put(hx, y, icon, mix(T.bg, iconCol, fade), DEFAULT, ATTR_BOLD);
  hx += 2;
  hx += s.text(hx, y, ln.text, mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD, w - 4);
  if (ln.meta) {
    hx += s.text(hx, y, `  ${ln.meta}`, mix(T.bg, T.dim, fade), DEFAULT, ATTR_DIM, w - (hx - x));
  }
  if (running && msg.progress != null) {
    const bwid = 10;
    bar(s, x + w - bwid - 1, y, bwid, msg.progress, mix(T.bg, T.accent, fade), mix(T.bg, T.inset, fade));
  }
}

function drawWorkGroupHead(s, x, y, w, ln, fade, group, t) {
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  const tools = (group.tools ?? []).reduce((sum, item) => sum + (item.tools?.length ?? 0), 0);
  const notes = group.notes?.length ?? 0;
  const stat = `${notes} note${notes === 1 ? '' : 's'} · ${tools} tool${tools === 1 ? '' : 's'}`;
  const icon = group.expanded ? '▾' : '▸';
  s.put(x, y, icon, mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD);
  s.put(x + 2, y, group.expanded ? MARK.check : '·', mix(T.bg, group.expanded ? T.ok : T.accent, fade), DEFAULT, ATTR_BOLD);
  let hx = x + 4;
  const room = Math.max(1, w - 4 - strWidth(stat));
  hx += s.text(hx, y, ln.text, mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD, room);
  s.textRight(x + w - 1, y, stat, mix(T.bg, T.dim, fade), DEFAULT, ATTR_DIM);
}

function drawChangesetHead(s, x, y, w, ln, fade, message) {
  const summary = message.summary ?? { files: message.files?.length ?? 0, added: 0, removed: 0 };
  const stat = `${summary.files} file${summary.files === 1 ? '' : 's'}  +${summary.added} -${summary.removed}`;
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  s.put(x, y, message.expanded ? '▾' : '▸', mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD);
  s.put(x + 2, y, MARK.diamond, mix(T.bg, T.plum, fade), DEFAULT, ATTR_BOLD);
  const room = Math.max(1, w - 5 - strWidth(stat));
  s.text(x + 4, y, ellipsize(ln.text, room), mix(T.bg, T.fg, fade), DEFAULT, ATTR_BOLD, room);
  if (w > strWidth(stat) + 6) {
    const statX = x + w - strWidth(stat);
    let sx = statX;
    sx += s.text(sx, y, `${summary.files} file${summary.files === 1 ? '' : 's'}  `,
      mix(T.bg, T.dim, fade), DEFAULT, ATTR_DIM);
    sx += s.text(sx, y, `+${summary.added}`, mix(T.bg, T.ok, fade), DEFAULT, ATTR_BOLD);
    s.text(sx, y, ` -${summary.removed}`, mix(T.bg, T.accent, fade), DEFAULT, ATTR_BOLD);
  }
}

function drawChangeFileHead(s, x, y, w, ln, fade) {
  const file = ln.file;
  const added = file.kind === 'added';
  const deleted = file.kind === 'deleted';
  const color = added ? T.ok : deleted ? T.accent : T.accent2;
  const rail = deleted ? DASH.v : added ? HEAVY.v : LIGHT.v;
  const bg = mix(T.bg, color, 0.06 * fade);
  s.fillRect(x, y, w, 1, ' ', T.fg, bg);
  s.put(x, y, rail, mix(bg, color, fade), bg, ATTR_BOLD);
  const badge = added ? 'NEW' : deleted ? 'DEL' : 'MOD';
  s.text(x + 2, y, badge, mix(bg, color, fade), bg, ATTR_BOLD, Math.max(0, w - 2));
  const stat = file.binary ? 'BIN' : `+${file.added} -${file.removed}`;
  const pathX = x + 6;
  const room = Math.max(1, w - 7 - strWidth(stat));
  if (pathX < x + w) s.text(pathX, y, ellipsize(ln.text, room), mix(bg, T.fg, fade), bg, ATTR_BOLD, room);
  if (w > 12) s.textRight(x + w - 1, y, stat, mix(bg, color, fade), bg, ATTR_BOLD);
}

function drawChangeDiff(s, x, y, w, ln, fade) {
  const kind = ln.diffKind;
  const fileKind = ln.file?.kind;
  const added = kind === 'add';
  const deleted = kind === 'del';
  const color = added ? T.ok : deleted ? T.accent : kind === 'hunk' ? T.accent2 : kind === 'meta' ? T.dim : T.slate;
  const bg = added ? mix(T.bg, T.ok, 0.08 * fade) : deleted ? mix(T.bg, T.accent, 0.07 * fade) : T.bg;
  s.fillRect(x, y, w, 1, ' ', T.fg, bg);
  const rail = deleted || fileKind === 'deleted' ? DASH.v : added || fileKind === 'added' ? HEAVY.v : LIGHT.v;
  const railColor = deleted || fileKind === 'deleted' ? T.accent : added || fileKind === 'added' ? T.ok : T.accent2;
  s.put(x, y, rail, mix(bg, railColor, fade * 0.9), bg, ATTR_BOLD);
  const numberW = w < 42 ? 3 : 4;
  let tx = x + 2;
  s.text(tx, y, ln.oldLine == null ? ' '.repeat(numberW) : String(ln.oldLine).padStart(numberW),
    mix(bg, T.dim, fade * 0.72), bg, ATTR_DIM, numberW);
  tx += numberW + 1;
  s.text(tx, y, ln.newLine == null ? ' '.repeat(numberW) : String(ln.newLine).padStart(numberW),
    mix(bg, T.dim, fade * 0.72), bg, ATTR_DIM, numberW);
  tx += numberW + 1;
  const prefix = added ? '+' : deleted ? '-' : kind === 'hunk' ? '@' : ' ';
  s.put(tx++, y, prefix, mix(bg, color, fade), bg, ATTR_BOLD);
  if (tx < x + w) s.text(tx, y, ellipsize(ln.text, x + w - tx), mix(bg, color, fade), bg,
    kind === 'hunk' ? ATTR_BOLD : 0, x + w - tx);
}

function drawToolGroupHead(s, x, y, w, ln, fade, group, t) {
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  const tools = group.tools ?? [];
  const running = tools.filter((tool) => tool.running).length;
  const failed = tools.filter((tool) => tool.isError || tool.meta === 'error').length;
  const done = tools.length - running;
  const icon = running ? SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length] : failed ? MARK.cross : MARK.check;
  const iconCol = running ? T.accent : failed ? T.warn : T.ok;
  const stat = failed ? `${done}/${tools.length} · ${failed} err` : `${done}/${tools.length}`;
  let hx = x;
  s.put(hx, y, group.expanded ? '▾' : '▸', mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD);
  hx += 2;
  s.put(hx, y, icon, mix(T.bg, iconCol, fade), DEFAULT, ATTR_BOLD);
  hx += 2;
  const titleRoom = Math.max(1, w - (hx - x) - strWidth(stat) - 3);
  hx += s.text(hx, y, ln.text, mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD, titleRoom);
  s.textRight(x + w - 1, y, stat, mix(T.bg, failed ? T.warn : T.dim, fade), DEFAULT, ATTR_DIM);
}

function drawToolChildHead(s, x, y, w, ln, fade, t) {
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  const tool = ln.tool;
  const running = !!tool?.running;
  const failed = !!tool?.isError || tool?.meta === 'error';
  const icon = running ? SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length] : failed ? MARK.cross : MARK.check;
  const iconCol = running ? T.accent : failed ? T.warn : T.ok;
  const branch = ln.last ? '└' : '├';
  s.put(x, y, branch, mix(T.bg, T.rule, fade));
  s.put(x + 2, y, tool?.expanded ? '▾' : '▸', mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD);
  s.put(x + 4, y, icon, mix(T.bg, iconCol, fade));
  let hx = x + 6;
  hx += s.text(hx, y, ln.text, mix(T.bg, T.accent2, fade), DEFAULT, ATTR_BOLD, Math.max(1, w - 6));
  if (ln.meta && hx < x + w - 2) {
    s.text(hx, y, `  ${ln.meta}`, mix(T.bg, T.dim, fade), DEFAULT, ATTR_DIM, x + w - hx);
  }
}

function drawToolChildBody(s, x, y, w, ln, shown, fade) {
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  s.put(x, y, ln.last ? ' ' : LIGHT.v, mix(T.bg, T.rule, fade * 0.75));
  s.put(x + 2, y, LIGHT.v, mix(T.bg, T.accent2, fade * 0.5));
  s.text(x + 4, y, shown, mix(T.bg, T.slate, fade), DEFAULT, 0, Math.max(0, w - 4));
}

function drawInline(s, x, y, ln, cols, fade, maxW, baseFg, baseBg = DEFAULT, baseAttrs = 0) {
  const runs = ln.runs?.length ? ln.runs : [{ text: ln.text, attrs: 0 }];
  let cx = x;
  let room = Math.max(0, Math.min(maxW, cols));
  for (const run of runs) {
    if (room <= 0) break;
    // A style-run boundary must never reuse the reserved tail of a CJK/fullwidth
    // glyph. Reusing it makes Screen.put repair the tail by erasing the glyph's
    // head — most visibly the opening `（` immediately before inline code.
    const cell = y * s.w + cx;
    if (s.ch?.[cell] === '') {
      cx++;
      room--;
      if (room <= 0) break;
    }
    const text = sliceCols(run.text, room);
    if (!strWidth(text)) continue;
    const fg = run.code ? T.accent2
      : run.tableBorder ? (run.tableStrong ? T.accent2 : T.rule)
        : run.link ? T.accent2 : run.strike ? T.dim : baseFg;
    // Inline code is differentiated by ink colour and weight, not a dark chip.
    // A full-width code background used to become a black rectangle when an
    // undefined inset colour reached the ANSI compositor.
    const bg = run.code ? (baseBg === DEFAULT ? T.bg : baseBg) : baseBg;
    const attrs = baseAttrs | (run.attrs ?? 0) | (run.code ? ATTR_BOLD : 0) | (run.strike ? ATTR_DIM : 0);
    const drawn = s.text(cx, y, text, mix(T.bg, fg, fade), bg, attrs, room);
    cx += drawn;
    room -= drawn;
  }
  return cx - x;
}

/** Slice a string to at most n display columns. */
function sliceCols(str, n) {
  if (n <= 0) return '';
  let out = '';
  let cw = 0;
  for (const g of str) {
    const gw = strWidth(g) || 1;
    if (cw + gw > n) break;
    out += g;
    cw += gw;
  }
  return out;
}
