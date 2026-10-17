// Playwright walkthrough of the mock-mode build: plays the PO-184 story and screenshots key screens.
// Usage: serve `out/` (npm run build:static && npx serve out -l 4173), then
//   BASE=http://localhost:4173 SHOTS=/tmp/rg-shots node scripts/screenshots.mjs
// Requires `playwright` resolvable (npm i -D playwright && npx playwright install chromium).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.SHOTS || '/workspace/work/rg-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync(OUT, { recursive: true });

// PART=1|2 lets the walkthrough run in two shorter processes sharing one persistent profile (localStorage keeps the mock DB).
const PART = process.env.PART || 'all';
const PROFILE = process.env.PROFILE || '/tmp/rg-pw-profile';
const ctx = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const browser = { close: () => ctx.close() };
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const shot = async (name, opts = {}) => {
  if (ONLY && !ONLY.includes(name)) return;
  await page.waitForTimeout(opts.settle ?? 700);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false });
  console.log('shot', name);
};
const caseState = () => page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('rg-mock-db-v2') || '{}');
  return db.cases?.['RG-1042']?.case?.state ?? null;
});
const waitState = async (s, timeout = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await caseState()) === s) return; await page.waitForTimeout(400); }
  throw new Error('timeout waiting for ' + s + ' (now ' + (await caseState()) + ')');
};
const nav = async (label) => { await page.getByRole('link', { name: label, exact: true }).first().click(); await page.waitForTimeout(600); };

if (PART !== '2') {
// 1 login
await page.goto(BASE + '/login/');
await page.evaluate(() => localStorage.clear());
await page.goto(BASE + '/login/');
await page.waitForSelector('text=Sign in to the ledger');
await shot('01-login');

await page.getByRole('button', { name: /Aditi · Admin/ }).click();
await page.waitForURL(/\/cases/);
await page.waitForSelector('text=RG-1041');
await shot('02-cases-seeded');

// demo control room: play through scene 7 (jumps play 1..6 fast)
await nav('Demo control room');
await page.getByLabel('Play scene 0', { exact: true }).click();
await page.waitForTimeout(800);
await page.getByLabel('Play scene 7', { exact: true }).click();
await waitState('AWAITING_APPROVAL');
await page.waitForTimeout(1500);
await shot('03-demo-scene7');

// chaos: injection + nim_down + role block (scene 9)
await page.getByRole('button', { name: /Injection email/ }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /NIM down/ }).click();
await page.waitForTimeout(1200);
await page.getByLabel('Play scene 9', { exact: true }).click();
await page.waitForTimeout(2500);
await shot('04-demo-chaos-guardrails');

// case file tabs
await page.getByRole('link', { name: /open case file/ }).click();
await page.waitForSelector('text=Evidence board');
await page.waitForTimeout(1800);
await shot('05-case-board');
await page.getByRole('tab', { name: 'Orchestration' }).click();
await shot('06-case-orchestration', { settle: 1200 });
await shot('06b-case-orchestration-full', { full: true, settle: 200 });
await page.getByRole('tab', { name: 'Proposal & approval' }).click();
await shot('07-case-decision-60k', { settle: 1000 });

// hover a claim → board highlight
await page.getByRole('tab', { name: 'Evidence board' }).click();
await page.waitForTimeout(1200);
const claim = page.locator('li.tick-row').nth(1);
if (await claim.count()) { await claim.hover(); await shot('08-case-claim-hover', { settle: 900 }); }

// correction → stale approval → ₹70,000
await nav('Demo control room');
await page.getByRole('button', { name: /Correction WA/ }).click();
await page.waitForTimeout(3000);
await waitState('AWAITING_APPROVAL');
await page.waitForTimeout(1500);
await shot('09-demo-correction-70k');

}
if (PART !== '1') {
await page.goto(BASE + '/demo/');
await page.waitForTimeout(1200);
// login as finance and approve in the case file
await page.getByRole('button', { name: 'Sign out' }).click();
await page.waitForURL(/\/login/);
await page.getByRole('button', { name: /Meera · Finance/ }).click();
await page.waitForURL(/\/cases/);
await page.getByRole('link', { name: /RG-1042/ }).first().click();
await page.getByRole('tab', { name: 'Proposal & approval' }).click();
await page.waitForTimeout(1000);
await shot('10-case-decision-70k-expired-history', { full: true });
await page.getByRole('button', { name: 'Approve', exact: true }).click();
await waitState('CLOSED');
await page.waitForTimeout(800);
await page.getByRole('tab', { name: 'Execution & verifier' }).click();
await shot('11-case-execution-verified', { settle: 1000 });
await page.getByRole('tab', { name: 'Audit trail' }).click();
await shot('12-case-audit', { settle: 800 });
await page.getByRole('tab', { name: 'Evidence board' }).click();
await shot('13-case-board-closed', { settle: 1800 });

// queues
await nav('Approvals');
await shot('14-approvals');
await nav('Triage review');
await shot('15-triage');
// garbage output → escalation (as finance the demo route is refused; switch to ops)
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByRole('button', { name: /Ravi · Operator/ }).click();
await page.waitForURL(/\/cases/);
await nav('Demo control room');
await page.getByRole('button', { name: /Garbage output/ }).click();
await page.waitForTimeout(5500);
await nav('Escalations');
await shot('16-escalations');
await nav('Connectors');
await page.getByRole('button', { name: /Pair with QR code/ }).click();
await shot('17-connectors-qr', { settle: 1500 });
await nav('Audit log');
await shot('18-audit-log');
await nav('Eval & metrics');
await shot('19-metrics', { full: true, settle: 1500 });
await nav('Cases');
await shot('20-cases-after-story', { settle: 900 });

// mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await shot('21-mobile-cases', { full: true });
await page.getByRole('link', { name: /RG-1042/ }).first().click();
await page.waitForTimeout(1500);
await shot('22-mobile-case', { full: true });
await page.getByRole('button', { name: 'Open menu' }).click();
await shot('23-mobile-nav', { settle: 600 });

}
console.log('ERRORS', JSON.stringify(errors.slice(0, 30), null, 1));
await browser.close();
