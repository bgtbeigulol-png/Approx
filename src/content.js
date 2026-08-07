// Canned content: help text and renderer samples. No network anywhere.

export const HELP = `# Keys
- ↵ send · ⇧↵ or ^j newline · esc interrupt or close
- ^p command palette · / inline commands
- /new new conversation · /clear clear the active context · /model and /effort switch runtime options
- /markdown on|off toggle Markdown rendering (on by default)
- ←→ move cursor · ↑↓ prompt history · wheel scroll · pgup/pgdn page · home/end line or transcript ends
- click a user turn to select · double-click to edit/retry · drag to copy
- ^e select/edit latest user turn · alt+↑↓ choose turn · alt+r one-step redo
- ^g jump timeline · ←→ enter/leave a WORK tool list · ↵ jump to the selected row
- ^s saved conversations · ^l clear context · ^u unfold tool group, then focused call · ^t cycle accent · ^r redraw · ^c quit

# Notes
Approx owns both the terminal experience and its live agent session.
The scripted mode remains available for renderer development. Everything renders
through a diffing cell compositor, so animation costs only changed cells.`;

export const ABOUT = `# Approx
A brutalist terminal interface on condensed-milk paper.

Heavy rules, hard shadows, one hot accent. Sub-cell bars and eighth-block
ramps do the smooth work; the frames stay blunt on purpose.

Models, tools, context, and sessions stay behind the Approx interface.`;

export const SAMPLE_ANSWER = `Here is the shape of it.

The compositor keeps two parallel cell buffers and writes only the runs that
differ between frames. That keeps a 60fps animated header affordable even over
a slow connection, because a shimmer touching twelve cells costs twelve cells.

- glyph, fg, bg, and attrs per cell
- contiguous same-style runs collapse into one SGR write
- wide characters reserve their trailing column

\`\`\`js
for (const cell of frame) {
  if (cell.same(prev)) continue;
  out += move(cell) + style(cell) + cell.ch;
}
\`\`\`

The animation layer is springs and easings over wall-clock delta, not frame
counts, so a stalled render never desynchronizes the motion.`;

export const STATS_TEMPLATE = (st) => `# Session
- turns: ${st.turns}
- messages: ${st.msgs.length}
- frames: ${st.frames}
- avg dirty cells: ${st.avgDirty}
- uptime: ${st.uptime}s
- terminal: ${st.w}×${st.h}`;

export const GREETING = `Approx is up. This is a shell, not a model: the interface is
live, the answers are scripted.

Try \`^p\` for the palette, or just type and press ↵ to watch a reply stream in.`;
