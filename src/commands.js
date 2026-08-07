// Command registry. Each command mutates app state; none of them talk to a network.

export function buildCommands(app) {
  return [
    { name: 'help', desc: 'Show keys and commands', key: '?', run: () => app.showHelp() },
    { name: 'clear', desc: 'Start a clean context', key: '^l', run: () => app.clearTranscript() },
    { name: 'new', desc: 'Start a new conversation', key: '', run: () => app.newConversation() },
    { name: 'cd', desc: 'Open another project folder', key: '', run: (arg) => app.commandCd(arg) },
    { name: 'mode', desc: 'Switch Go / Plan mode', key: '⇧tab', choices: true, run: (arg) => app.commandMode(arg) },
    { name: 'model', desc: 'Switch model', key: '', choices: true, run: (arg) => app.commandModel(arg) },
    { name: 'effort', desc: 'Switch reasoning effort', key: '', choices: true, run: (arg) => app.commandEffort(arg) },
    { name: 'markdown', desc: 'Render Markdown on/off', key: '', choices: true, run: (arg) => app.commandMarkdown(arg) },
    { name: 'compact', desc: 'Compact context now', key: '', run: (arg) => app.compactContext(arg) },
    { name: 'tool', desc: 'Simulate a tool call', key: '', run: () => app.fakeTool() },
    { name: 'settings', desc: 'Open the settings page', key: '^o', run: () => app.openSettings() },
    { name: 'history', desc: 'Return to a saved conversation', key: '^s', palette: true, run: () => app.openSessions() },
    { name: 'jump', desc: 'Quick-jump to a message', key: '^g', palette: true, run: () => app.openJump() },
    { name: 'theme', desc: 'Cycle accent color', key: '^t', palette: true, run: () => app.cycleAccent() },
    { name: 'grain', desc: 'Toggle paper grain', key: '', palette: true, run: () => app.toggleGrain() },
    { name: 'motion', desc: 'Toggle reduced motion', key: '', palette: true, run: () => app.toggleMotion() },
    { name: 'fps', desc: 'Toggle the frame meter', key: '', palette: true, run: () => app.toggleFps() },
    { name: 'top', desc: 'Jump to the top', key: 'g', palette: true, run: () => app.scrollTo(0) },
    { name: 'bottom', desc: 'Jump to the newest', key: 'G', palette: true, run: () => app.scrollToBottom() },
    { name: 'stats', desc: 'Print session stats', key: '', palette: true, run: () => app.showStats() },
    { name: 'about', desc: 'About Approx', key: '', run: () => app.showAbout() },
    { name: 'quit', desc: 'Exit Approx', key: '^c', run: () => app.quit() },
  ];
}

export const SLASH = (app) =>
  buildCommands(app).map(({ name, desc, choices }) => ({ name: `/${name}`, desc, terminal: !choices }));

/** Contextual slash suggestions, including values after model/effort/markdown. */
export function slashSuggestions(app, input) {
  const raw = String(input ?? '');
  const valueMatch = /^\/(model|effort|markdown|mode)\s+(.*)$/i.exec(raw);
  if (!valueMatch) {
    const q = raw.slice(1).toLowerCase();
    return SLASH(app).filter((item) => item.name.slice(1).startsWith(q));
  }

  const command = valueMatch[1].toLowerCase();
  const query = valueMatch[2].trim().toLowerCase();
  let values = [];
  if (command === 'model') {
    values = app.st.modelOptions.map((model) => ({
      value: model.label,
      desc: model.provider ? `${model.provider}/${model.id}` : model.id,
    }));
  } else if (command === 'effort') {
    values = app.st.effortOptions.map((value) => ({ value, desc: 'reasoning effort' }));
  } else if (command === 'mode') {
    values = ['go', 'plan'].map((value) => ({ value, desc: `${value === 'go' ? 'execute' : 'design'} mode` }));
  } else {
    values = ['on', 'off'].map((value) => ({ value, desc: 'Markdown rendering' }));
  }

  return values
    .filter((item) => !query || item.value.toLowerCase().includes(query))
    .map((item) => ({
      name: `/${command} ${item.value}`,
      desc: item.desc,
      terminal: true,
    }));
}
