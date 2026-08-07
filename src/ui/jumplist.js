// Quick-jump sidebar. Unlike the transcript it indexes logical turns: all tool
// work and intermediate assistant notes inside one user turn become one WORK row.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, MARK, HEAVY, LIGHT } from '../glyphs.js';
import { T, ROLE, mix } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { panel, rule } from '../draw.js';
import { ellipsize } from '../wrap.js';

export const JUMP_ROWS = 12;
const JUMP_W = 34;

/** One-line preview of a message for the list. */
export function jumpLabel(msg) {
  if ((msg.role === 'tool' || msg.role === 'toolgroup' || msg.role === 'work' || msg.role === 'workgroup') && msg.title) {
    return String(msg.title);
  }
  const flat = String(msg.text ?? '')
    .replace(/^```.*$/gm, '')
    .replace(/^#\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat || msg.title || (msg.name ? `${msg.name}()` : msg.role);
}

/**
 * Build a navigation-only timeline: YOU → WORK → final APPROX. A message ending
 * in toolUse is always a work note. For old histories without stopReason metadata,
 * any assistant message before the turn's last tool is treated as a work note.
 */
export function logicalTimeline(msgs) {
  const out = [];
  for (let start = 0; start < msgs.length;) {
    const first = msgs[start];
    if (!isUser(first)) { start++; continue; }
    out.push({ msg: first, index: start, rawEndIndex: start + 1, kind: 'message' });

    let end = start + 1;
    while (end < msgs.length && msgs[end]?.role !== 'user') end++;
    const turn = msgs.slice(start + 1, end);
    let lastWorkOffset = -1;
    for (let i = 0; i < turn.length; i++) {
      if (isTool(turn[i])) lastWorkOffset = i;
    }

    const tools = [];
    const notes = [];
    const finals = [];
    let firstWorkIndex = -1;
    let lastWorkIndex = -1;
    for (let i = 0; i < turn.length; i++) {
      const msg = turn[i];
      const rawIndex = start + 1 + i;
      if (isTool(msg)) {
        if (firstWorkIndex < 0) firstWorkIndex = rawIndex;
        lastWorkIndex = rawIndex;
        if (msg.role === 'workgroup') {
          notes.push(...(msg.notes ?? []));
          for (const group of msg.tools ?? []) {
            const base = tools.length;
            tools.push(...(group.tools ?? []).map((tool, childIndex) => ({
              tool,
              parent: msg,
              group,
              index: rawIndex,
              childIndex: base + childIndex,
            })));
          }
        } else if (msg.role === 'toolgroup') {
          const base = tools.length;
          tools.push(...(msg.tools ?? []).map((tool, childIndex) => ({
            tool,
            parent: msg,
            index: rawIndex,
            childIndex: base + childIndex,
          })));
        } else tools.push({ tool: msg, parent: null, index: rawIndex, childIndex: -1 });
        continue;
      }
      if (!isApprox(msg)) continue;
      const toolUse = String(msg.stopReason ?? '').toLowerCase() === 'tooluse';
      const historicProgress = msg.stopReason == null && i <= lastWorkOffset;
      if (toolUse || historicProgress) {
        notes.push(msg);
        if (firstWorkIndex < 0) firstWorkIndex = rawIndex;
        lastWorkIndex = rawIndex;
      } else {
        finals.push({
          msg: msg.role === 'assistant' ? { ...msg, role: 'approx' } : msg,
          index: rawIndex,
          rawEndIndex: rawIndex + 1,
          kind: 'message',
        });
      }
    }

    if (tools.length || notes.length) {
      const title = workTitle(tools);
      const counts = [
        tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'}` : '',
        notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ');
      const searchText = tools.map(({ tool }) => `${tool.title ?? ''} ${tool.name ?? ''} ${tool.meta ?? ''}`).join(' ');
      out.push({
        kind: 'work',
        index: Math.max(start + 1, firstWorkIndex),
        rawEndIndex: Math.max(start + 2, lastWorkIndex + 1),
        children: tools.map(({ tool, index, childIndex, parent, group }) => ({
          kind: 'tool',
          index,
          childIndex,
          parent: parent ?? null,
          group: group ?? null,
          msg: { ...tool, role: 'tool' },
        })),
        msg: {
          role: 'work',
          title,
          text: counts ? `${title} · ${counts}` : title,
          searchText,
          children: tools.map(({ tool, index, childIndex, parent, group }) => ({
            kind: 'tool',
            index,
            childIndex,
            parent: parent ?? null,
            group: group ?? null,
            msg: { ...tool, role: 'tool' },
          })),
        },
      });
    }
    out.push(...finals);
    start = end;
  }
  return out;
}

function isUser(msg) {
  return msg?.role === 'user';
}

function isApprox(msg) {
  return msg?.role === 'approx' || msg?.role === 'assistant';
}

function isTool(msg) {
  return msg?.role === 'tool' || msg?.role === 'toolgroup' || msg?.role === 'workgroup';
}

function workTitle(tools) {
  const archived = tools.find(({ parent }) => parent?.role === 'workgroup')?.parent;
  if (archived?.title) return String(archived.title);
  const group = tools.find(({ parent }) => parent?.modelTitle && parent.title)?.parent
    ?? tools.find(({ tool }) => tool?.modelGroupTitle && tool.groupTitle)?.tool;
  if (group?.groupTitle) return String(group.groupTitle);
  if (group?.title) return String(group.title);
  const named = tools.find(({ tool }) => tool?.modelTitle && tool.title)?.tool;
  if (named?.title) return String(named.title);
  const parent = tools.find(({ parent }) => parent?.title)?.parent;
  if (parent?.title) return String(parent.title);
  const names = new Set(tools.map(({ tool }) => String(tool?.name ?? '').toLowerCase()));
  if (names.size && [...names].every((name) => ['read', 'find', 'grep', 'ls', 'glob'].includes(name))) return 'Inspect project context';
  if (names.size && [...names].every((name) => ['write', 'edit', 'apply_patch'].includes(name))) return 'Update project files';
  if (names.size && [...names].every((name) => ['bash', 'shell', 'shell_command'].includes(name))) return 'Run project commands';
  return 'Work through task';
}

/** Filter the logical timeline. Returns [{msg, index, kind}] newest-last. */
export function jumpResults(msgs, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const item of logicalTimeline(msgs)) {
    const m = item.msg;
    if (!q) { out.push(item); continue; }
    const hay = `${ROLE[m.role]?.tag ?? ''} ${jumpLabel(m)} ${m.searchText ?? ''}`.toLowerCase();
    if (hay.includes(q)) out.push(item);
  }
  return out;
}

/** Shared geometry for rendering and wide-glyph boundary regression tests. */
export function jumpLayout(w, h, resultCount, p = 1) {
  const rows = Math.min(JUMP_ROWS, Math.max(1, resultCount), Math.max(1, h - 4));
  const ph = Math.min(h, rows + 4);
  const pw = Math.max(2, Math.min(JUMP_W, w - 6));
  const slide = Math.round((1 - ease.outBack(clamp(p, 0, 1))) * (pw + 4));
  const px = 1 - slide;
  const py = Math.max(0, Math.min(Math.max(2, Math.floor((h - ph) / 2) - 2), h - ph));
  return { rows, ph, pw, px, py };
}

export function drawJumpList(s, st, t) {
  const { w, h } = s;
  const p = clamp(st.jumpAnim.v, 0, 1);
  if (p <= 0.001) return;

  const results = st.jumpResults;
  const { rows, ph, pw, px, py } = jumpLayout(w, h, results.length, p);

  // scrim behind, grain-safe
  const k = p * 0.32;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      s.bg[i] = mix(s.bg[i] === -1 ? T.bg : s.bg[i], T.shadow, k);
    }
  }
  // panel() owns both wide-glyph-safe fill and one offset hard shadow. Keeping
  // the footprint there avoids the old pale safety plate reading as a 2nd shadow.
  panel(s, px, py, pw, ph, { bg: T.cream, border: T.fg, style: HEAVY, shadow: true, shadowOff: 2 });

  // title + count
  const heading = st.jumpDepth && st.jumpParent ? 'WORK' : 'JUMP';
  s.fillRect(px + 1, py, Math.min(pw - 2, heading.length + 2), 1, ' ', T.bg, T.fg);
  s.text(px + 2, py, heading, T.bg, T.fg, ATTR_BOLD);
  const cnt = ` ${results.length} `;
  s.text(px + pw - strWidth(cnt) - 2, py, cnt, mix(T.cream, T.dim, 1), T.cream, ATTR_DIM);

  // query row
  const qy = py + 1;
  s.fillRect(px + 1, qy, pw - 2, 1, ' ', T.fg, T.crust);
  s.put(px + 2, qy, MARK.caret, T.accent, T.crust, ATTR_BOLD);
  const shownQuery = ellipsize(st.jumpQuery, pw - 8);
  const shownQueryW = s.text(px + 4, qy, shownQuery, T.ink, T.crust);
  const queryCaretX = Math.min(px + pw - 3, px + 4 + shownQueryW);
  s.put(queryCaretX, qy, BLOCK.full, T.accent, T.crust);
  s.setCursorAnchor(queryCaretX, qy);
  rule(s, px + 1, py + 2, pw - 2, mix(T.crust, T.sand, 0.8), 0, T.cream);

  const scroll = clamp(st.jumpScroll, 0, Math.max(0, results.length - rows));
  const view = results.slice(scroll, scroll + rows);
  for (let i = 0; i < view.length; i++) {
    const it = view[i];
    const idx = scroll + i;
    const sel = idx === st.jumpIndex;
    const ry = py + 3 + i;
    const rp = clamp((p * (rows + 2) - i) / 1.5, 0, 1);
    if (rp <= 0.02) continue;
    const role = ROLE[it.msg.role] ?? ROLE.approx;

    const rowBg = sel ? T.fg : T.cream;
    const rowFg = sel ? T.milk : T.ink;
    s.fillRect(px + 1, ry, pw - 2, 1, ' ', rowFg, mix(T.cream, rowBg, rp));
    // role stripe on the left, always its role colour so the list reads as a minimap
    s.put(px + 1, ry, BLOCK.full, mix(T.cream, role.rail, rp));
    if (sel) s.put(px + 2, ry, MARK.tri_r, mix(rowBg, T.accent, rp), rowBg, ATTR_BOLD);

    const tag = role.tag;
    s.text(px + 3, ry, tag, mix(T.cream, sel ? T.milk : role.color, rp), mix(T.cream, rowBg, rp), ATTR_BOLD, 6);
    const preview = ellipsize(jumpLabel(it.msg), pw - 12);
    const pcol = sel ? mix(T.fg, T.milk, 0.7) : T.slate;
    s.text(px + 10, ry, preview, mix(T.cream, pcol, rp), mix(T.cream, rowBg, rp), sel ? 0 : ATTR_DIM);
  }

  if (!results.length) {
    s.text(px + 3, py + 3, 'no messages', mix(T.cream, T.dim, p), T.cream, ATTR_DIM);
  }

  // scroll pip
  if (results.length > rows) {
    const track = rows;
    const pos = Math.round((st.jumpIndex / Math.max(1, results.length - 1)) * (track - 1));
    for (let i = 0; i < track; i++) {
      s.put(px + pw - 2, py + 3 + i, i === pos ? BLOCK.full : BLOCK.l1, mix(T.cream, i === pos ? T.accent : T.sand, p));
    }
  }

  // footer
  const fy = py + ph - 1;
  const foot = st.jumpDepth ? ' ← work  ↑↓ ↵ jump  esc ' : ' ←→ tools  ↑↓ ↵ jump  esc ';
  if (strWidth(foot) + 2 < pw) s.text(px + 2, fy, foot, mix(T.cream, T.dim, p), T.cream, ATTR_DIM);
}
