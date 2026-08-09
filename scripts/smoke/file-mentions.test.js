import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeFileMention, fileMentionMatches,
} from '../../src/file-mentions.js';
import { fileMentionSpans } from '../../src/file-mention-highlight.js';
import { setComposerInput } from '../../src/composer-state.js';
import { App } from '../../src/app.js';
import { Screen } from '../../src/screen.js';
import { FakeOut, ok, recordError } from './shared.js';

const root = mkdtempSync(join(tmpdir(), 'approx-mentions-'));
const aliasHolder = mkdtempSync(join(tmpdir(), 'approx-mentions-alias-'));
const linkedRoot = join(aliasHolder, 'workspace');
let testError = null;

try {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'alpha dir'));
  mkdirSync(join(root, 'node_modules', 'fixture-package'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# fixture\n', { encoding: 'utf8' });
  writeFileSync(join(root, 'src', 'app.js'), 'export {};\n', { encoding: 'utf8' });
  writeFileSync(join(root, 'alpha dir', 'note.txt'), 'note\n', { encoding: 'utf8' });
  writeFileSync(join(root, 'node_modules', 'fixture-package', 'dependency-only.js'), 'export {};\n', { encoding: 'utf8' });
  symlinkSync(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

  ok('file mentions require a token boundary', activeFileMention('mail@test.example') === null);
  ok('file mention highlighting preserves quoted, Markdown, and ordinary text', fileMentionSpans('read @src/app.js and `@README.md` and @"alpha dir/note.txt"')
    .map((span) => `${span.part ?? 'text'}:${span.text}`).join('|')
    === 'text:read |marker:@|path:src/app.js|text: and `|marker:@|path:README.md|text:` and |marker:@|path:"alpha dir/note.txt"');
  const parsed = activeFileMention('inspect @src/ap');
  ok('file mentions resolve the token at the caret', parsed?.raw === 'src/ap' && parsed.start === 8);

  const initial = await fileMentionMatches('inspect @', Infinity, root);
  ok('file mention list exposes parent navigation first', initial.matches[0]?.name === '..'
    && initial.matches[0]?.desc === 'PARENT FOLDER');
  ok('file mention list distinguishes folders and files', initial.matches.some((item) => item.name === 'src/' && item.desc === 'FOLDER')
    && initial.matches.some((item) => item.name === 'README.md' && item.desc === 'FILE'));
  const fuzzy = await fileMentionMatches('inspect @app', Infinity, root);
  ok('typed file mentions fuzzy-search nested project paths', fuzzy.matches.some((item) => item.name === 'src/app.js'
    && item.desc === 'FILE'));
  const dependencyFuzzy = await fileMentionMatches('inspect @dependency-only', Infinity, root);
  ok('bare file mention searches skip dependency trees', !dependencyFuzzy.matches.some((item) =>
    item.name.includes('node_modules')));

  const app = new App({ noSplash: true });
  app.s = new Screen(new FakeOut(82, 24));
  app.st.cwdPath = linkedRoot;
  setComposerInput(app.st, 'inspect @');
  await app.refreshFileMention();
  app.st.slashAnim.set(1, true);
  app.render(0.2);
  const rendered = app.s.ch.join('');
  ok('file mentions reuse the compact composer suggestion layer', rendered.includes('FILES')
    && rendered.includes('FOLDER') && !rendered.includes('OPEN FOLDER // /CD'));
  const composerMention = app.s.ch.findIndex((cell) => cell === '@');
  ok('composer uses a bright marker with a quieter underlined path', composerMention >= 0
    && app.s.fg[composerMention] === 0x526da8 && (app.s.at[composerMention] & 1) !== 0
    && app.s.bg[composerMention] !== app.s.bg[composerMention - 1]);

  const sent = app.push({ role: 'user', text: 'review @README.md', enter: 1 });
  app.render(0.2);
  const viewport = app.viewport();
  const transcriptMention = app.s.ch.findIndex((cell, index) => cell === '@'
    && Math.floor(index / app.s.w) >= viewport.y && Math.floor(index / app.s.w) < viewport.y + viewport.h
    && app.s.fg[index] === 0x526da8 && (app.s.at[index] & 1) !== 0);
  const transcriptPath = transcriptMention + 1;
  ok('sent references keep the marker and path hierarchy without a background', sent.role === 'user'
    && transcriptMention >= 0 && app.s.fg[transcriptPath] === 0x66759a
    && (app.s.at[transcriptPath] & 8) !== 0 && app.s.bg[transcriptPath] === app.s.bg[transcriptMention]);

  const assistantApp = new App({ noSplash: true });
  assistantApp.s = new Screen(new FakeOut(82, 24));
  assistantApp.push({ role: 'approx', text: 'See `@README.md` for the fixture.', enter: 1 });
  assistantApp.render(0.2);
  const assistantMention = assistantApp.s.ch.findIndex((cell, index) => cell === '@'
    && assistantApp.s.fg[index] === 0x526da8);
  const assistantPath = assistantMention + 1;
  ok('assistant references use the same marker and path hierarchy', assistantMention >= 0
    && assistantApp.s.fg[assistantPath] === 0x66759a
    && (assistantApp.s.at[assistantPath] & 8) !== 0);
  assistantApp.clock.stop();
  for (const id of assistantApp.timers) clearTimeout(id);

  app.st.fileMention.index = app.st.fileMention.matches.findIndex((item) => item.name === 'src/');
  await app.acceptFileMention();
  ok('entering a folder through a linked workspace keeps completion active', app.st.input === 'inspect @src/'
    && app.st.fileMention.matches.some((item) => item.name === 'app.js'));
  ok('folder contents retain parent navigation', app.st.fileMention.matches[0]?.name === '..');

  app.st.fileMention.index = 0;
  await app.acceptFileMention();
  ok('parent navigation returns to the previous token path', app.st.input === 'inspect @'
    && app.st.fileMention.matches.some((item) => item.name === 'src/'));

  app.st.fileMention.index = app.st.fileMention.matches.findIndex((item) => item.name === 'alpha dir/');
  await app.acceptFileMention();
  ok('folders with spaces use a quoted reference and keep the caret inside', app.st.input === 'inspect @"alpha dir/"'
    && app.st.inputCursor === [...app.st.input].length - 1);
  app.st.fileMention.index = app.st.fileMention.matches.findIndex((item) => item.name === 'note.txt');
  app.acceptFileMention();
  ok('file completion closes the quote and adds a separator', app.st.input === 'inspect @"alpha dir/note.txt" '
    && !app.fileMentionOpen());

  let delivered = '';
  app.backend = { prompt: (text) => { delivered = text; return Promise.resolve(); } };
  setComposerInput(app.st, 'review @README.md');
  app.submit();
  ok('file references reach Pi as unchanged prompt text', delivered === 'review @README.md');

  app.clock.stop();
  for (const id of app.timers) clearTimeout(id);
} catch (error) {
  testError = error;
}

recordError('file mentions', testError);
ok('file mention workflow stays clean', !testError);
rmSync(root, { recursive: true, force: true });
rmSync(aliasHolder, { recursive: true, force: true });
