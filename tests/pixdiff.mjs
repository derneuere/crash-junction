// Pixel-diff two PNGs by decoding them in a headless browser canvas (no native
// PNG dep). Usage: node tests/pixdiff.mjs <a.png> <b.png>
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const [a, b] = process.argv.slice(2);
async function launch() {
  for (const t of [{ channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await puppeteer.launch({ ...t, headless: true, args: ['--enable-unsafe-swiftshader'] }); } catch {}
  }
  throw new Error('no browser');
}
const toDataUrl = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const browser = await launch();
const page = await browser.newPage();
const res = await page.evaluate(async (ua, ub) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const ia = await load(ua), ib = await load(ub);
  if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
  const cv = document.createElement('canvas'); cv.width = ia.width; cv.height = ia.height;
  const cx = cv.getContext('2d');
  cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, cv.width, cv.height).data;
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, cv.width, cv.height).data;
  let changed = 0, maxd = 0, sumd = 0, over2 = 0, over8 = 0;
  for (let i = 0; i < da.length; i += 4) {
    let pd = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(da[i + k] - db[i + k]); pd = Math.max(pd, d); }
    if (pd > 0) { changed++; maxd = Math.max(maxd, pd); sumd += pd; if (pd > 2) over2++; if (pd > 8) over8++; }
  }
  const px = cv.width * cv.height;
  return { px, changed, pct: (100 * changed / px).toFixed(3), maxd, meanOverChanged: changed ? (sumd / changed).toFixed(2) : 0, over2, over8 };
}, toDataUrl(a), toDataUrl(b));
console.log(JSON.stringify(res));
await browser.close();
process.exit(0);
