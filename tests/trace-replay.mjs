// Replay diagnosis: play a fixture from tests/replays/ headless with tracing
// hooks on Game.onCollide / markCrashed / mode.resolveContact plus 0.25 s
// player offTrack/speed samples, and dump the event trace as JSON lines.
// This is how a crash report turns into a diagnosis: the trace names every
// judged contact, its ContactOutcome, and who wrecked when.
//
//   node tests/trace-replay.mjs <fixture.json>

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5177;
if (!process.argv[2]) {
  console.error('usage: node tests/trace-replay.mjs <fixture.json in tests/replays/>');
  process.exit(1);
}
const FIXTURE = path.join(root, 'tests', 'replays', process.argv[2]).replace(/\\/g, '/');

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  let browser;
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const target of candidates) {
    try {
      browser = await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
      break;
    } catch {
      // next candidate
    }
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('dialog', (d) => {
    console.error('[dialog]', d.message());
    d.dismiss().catch(() => {});
  });

  await page.evaluateOnNewDocument(() => {
    window.__trace = [];
    let g0;
    Object.defineProperty(window, '__game', {
      configurable: true,
      get() {
        return g0;
      },
      set(g) {
        g0 = g;
        const trace = window.__trace;
        g.events.on('flash', (t) => trace.push({ t: +g.simTime.toFixed(3), e: 'flash', text: t }));
        g.events.on('state', (s) => trace.push({ t: +g.simTime.toFixed(3), e: 'state', s }));
        const proto = Object.getPrototypeOf(g);
        if (proto.__diag) return;
        proto.__diag = true;
        const desc = (a) => (a ? (a.isPlayer ? 'player' : `${a.kind}#${a.body.id}`) : null);

        const origCollide = proto.onCollide;
        proto.onCollide = function (self, e) {
          const impact = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 0;
          const scenery = this.phys.noCrashIds.has(e.body.id);
          if (impact > 2.2 && !scenery) {
            const oa = this.byBody.get(e.body.id);
            const before = {
              sc: self.crashed, sd: +self.destabilized.toFixed(2),
              oc: oa?.crashed ?? null, od: oa ? +oa.destabilized.toFixed(2) : null,
            };
            window.__lastOut = null;
            origCollide.call(this, self, e);
            const out = window.__lastOut;
            const compactOut = out
              ? Object.fromEntries(Object.entries(out).filter(([, v]) => v !== false && v !== 0))
              : null;
            trace.push({
              t: +this.simTime.toFixed(3), e: 'hit',
              self: desc(self), other: oa ? desc(oa) : `wall#${e.body.id}`,
              impact: +impact.toFixed(2),
              before,
              after: {
                sc: self.crashed, sd: +self.destabilized.toFixed(2),
                oc: oa?.crashed ?? null, od: oa ? +oa.destabilized.toFixed(2) : null,
              },
              out: compactOut,
              selfP: [+self.body.position.x.toFixed(2), +self.body.position.y.toFixed(2), +self.body.position.z.toFixed(2)],
              selfV: [+self.body.velocity.x.toFixed(2), +self.body.velocity.y.toFixed(2), +self.body.velocity.z.toFixed(2)],
            });
          } else {
            origCollide.call(this, self, e);
          }
        };

        const origMark = proto.markCrashed;
        proto.markCrashed = function (a) {
          if (!a.crashed) {
            trace.push({
              t: +this.simTime.toFixed(3), e: 'markCrashed', who: desc(a),
              p: [+a.body.position.x.toFixed(2), +a.body.position.y.toFixed(2), +a.body.position.z.toFixed(2)],
              v: [+a.body.velocity.x.toFixed(2), +a.body.velocity.y.toFixed(2), +a.body.velocity.z.toFixed(2)],
            });
          }
          origMark.call(this, a);
        };

        // capture the resolved ContactOutcome of each judged contact, wrap
        // the cam-over rescue, and sample player offTrack/speed at 0.25 s
        const origAdvance = proto.advance;
        proto.advance = function (dt, hidden, cmds) {
          if (this.mode && !this.mode.__wrapped) {
            this.mode.__wrapped = true;
            const orig = this.mode.resolveContact.bind(this.mode);
            this.mode.resolveContact = (ctx) => {
              const out = orig(ctx);
              window.__lastOut = out;
              return out;
            };
            if (this.mode.onTakedownCamOver) {
              const origOver = this.mode.onTakedownCamOver.bind(this.mode);
              const game = this;
              this.mode.onTakedownCamOver = () => {
                const p = game.player;
                trace.push({
                  t: +game.simTime.toFixed(3), e: 'camOver',
                  off: +game.mode.playerOffTrackDistance().toFixed(1),
                  speed: +Math.hypot(p.body.velocity.x, p.body.velocity.z).toFixed(1),
                  crashed: p.crashed,
                });
                origOver();
                trace.push({
                  t: +game.simTime.toFixed(3), e: 'camOverDone',
                  off: +game.mode.playerOffTrackDistance().toFixed(1),
                  p: [+p.body.position.x.toFixed(1), +p.body.position.z.toFixed(1)],
                });
              };
            }
          }
          origAdvance.call(this, dt, hidden, cmds);
          if (this.player && this.mode?.playerOffTrackDistance && (window.__lastSample ?? 0) + 0.25 <= this.simTime) {
            window.__lastSample = this.simTime;
            const p = this.player;
            trace.push({
              t: +this.simTime.toFixed(2), e: 'sample',
              off: +this.mode.playerOffTrackDistance().toFixed(1),
              speed: +Math.hypot(p.body.velocity.x, p.body.velocity.z).toFixed(1),
              p: [+p.body.position.x.toFixed(1), +p.body.position.z.toFixed(1)],
              alt: +(p.body.position.y - this.heightAt(p.body.position.x, p.body.position.z)).toFixed(2),
              vy: +p.body.velocity.y.toFixed(2),
              cam: this.takedownCamT > 0,
              popped: p.popped,
            });
          }
        };
      },
    });
  });

  await page.goto(`http://localhost:${PORT}/?replay=${encodeURIComponent('/@fs/' + FIXTURE)}&verify=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__replayResult !== undefined, { timeout: 120_000, polling: 250 });
  const { result, trace } = await page.evaluate(() => ({ result: window.__replayResult, trace: window.__trace }));
  console.log('RESULT ' + JSON.stringify(result));
  for (const ev of trace) console.log(JSON.stringify(ev));
  await browser.close();
} finally {
  vite.kill();
}
