// Measures the real cost of a frame: dirty cells and flush bytes per tick.
// usage: node scripts/bench.js [cols] [rows] [frames]

import { Screen } from '../src/screen.js';
import { App } from '../src/app.js';
import { SAMPLE_ANSWER } from '../src/content.js';

const cols = parseInt(process.argv[2] ?? '120', 10);
const rows = parseInt(process.argv[3] ?? '40', 10);
const frames = parseInt(process.argv[4] ?? '600', 10);

class CountingOut {
  constructor(w, h) {
    this.columns = w;
    this.rows = h;
    this.isTTY = true;
    this.bytes = 0;
    this.calls = 0;
  }
  write(s) {
    this.bytes += Buffer.byteLength(s, 'utf8');
    this.calls++;
    return true;
  }
  on() {}
}

const out = new CountingOut(cols, rows);
const app = new App({ noSplash: true });
app.s = new Screen(out);
app.seed();
app.push({ role: 'user', text: 'stream something long enough to scroll' });
app.beginStream(SAMPleOrSample(), 150);

function SAMPleOrSample() {
  return `${SAMPLE_ANSWER}\n\n${SAMPLE_ANSWER}`;
}

// warm one frame so the first full paint isn't counted as steady state
app.tick(1 / 30, 0, 0);
out.bytes = 0;
out.calls = 0;

const samples = [];
const t0 = process.hrtime.bigint();
for (let i = 1; i <= frames; i++) {
  const a = process.hrtime.bigint();
  const before = out.bytes;
  app.tick(1 / 30, i / 30, i);
  const b = process.hrtime.bigint();
  samples.push({ ms: Number(b - a) / 1e6, bytes: out.bytes - before });
}
const t1 = process.hrtime.bigint();

app.clock.stop();
for (const id of app.timers) clearTimeout(id);

const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
const bytes = samples.map((s) => s.bytes);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

console.log(`grid           ${cols}x${rows} = ${cols * rows} cells`);
console.log(`frames         ${frames} in ${(Number(t1 - t0) / 1e6).toFixed(1)}ms wall`);
console.log(`tick  avg      ${(sum(ms) / ms.length).toFixed(3)}ms`);
console.log(`tick  p50/p99  ${pct(ms, 0.5).toFixed(3)}ms / ${pct(ms, 0.99).toFixed(3)}ms`);
console.log(`tick  max      ${ms[ms.length - 1].toFixed(3)}ms   (16.6ms budget @60fps)`);
console.log(`write avg      ${Math.round(sum(bytes) / bytes.length)} bytes/frame`);
console.log(`write max      ${Math.max(...bytes)} bytes`);
const fullPaint = cols * rows * 20;
console.log(`vs full paint  ${((sum(bytes) / bytes.length / fullPaint) * 100).toFixed(2)}% of a naive repaint (~${fullPaint} B)`);
const overBudget = ms.filter((m) => m > 33.3).length;
console.log(`over budget    ${overBudget} frame(s)`);
process.exit(overBudget > frames * 0.01 ? 1 : 0);
