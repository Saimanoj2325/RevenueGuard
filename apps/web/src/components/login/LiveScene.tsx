'use client';
import { useEffect, useRef, useState } from 'react';
import s from './live.module.css';

/**
 * Looping, scripted replay of the PO-184 story for the sign-in page.
 * Pure presentation: no API calls. Mirrors docs/mockups/live/live.html.
 */

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

// phase -> ms since loop start
const AT = [0, 600, 1800, 2600, 3700, 5000, 6400, 7800, 9000, 10200, 11400, 13000, 15200, 15800, 17200, 18600, 20200, 24500];
const LOOP_MS = 26500;

type Tone = 'ink' | 'red' | 'amber' | 'green';
type Feed = { p: number; tm: string; ag: string; text: React.ReactNode; tone?: Tone; tag?: [string, string] };
const FEED: Feed[] = [
  { p: 1, tm: '9:18 PM', ag: 'Intake', text: 'Photo received from Ravi (dispatch)' },
  { p: 4, tm: '9:18 PM', ag: 'Reading photo', text: <>Read challan DC-5521: <b>60 × Model X</b>, PO-184</>, tag: ['delivery challan · 96%', s.tGreen] },
  { p: 5, tm: '9:18 PM', ag: 'Voice note', text: '"60 boxes gaye, baaki next week" → 60 sent, 40 pending' },
  { p: 6, tm: '9:19 PM', ag: 'Matching', text: <>Matched to <b>PO-184</b> · Example Customer</>, tag: ['by PO number', s.tGrey] },
  { p: 7, tm: '9:19 PM', ag: 'Proof', text: 'Found PO email (100 units, ₹1,00,000) and dispatch sheet row' },
  { p: 8, tm: '9:19 PM', ag: 'Checking Zoho', text: 'No invoice in Zoho for PO-184. Also searched PO184 and amount', tone: 'red' },
  { p: 9, tm: '9:21 PM', ag: 'Intake', text: <>Correction from Ravi: <b>70</b> delivered, not 60</>, tone: 'amber' },
  { p: 10, tm: '9:21 PM', ag: 'Check', text: 'Count changed 60 → 70. Old ₹60,000 draft cancelled', tone: 'amber', tag: ['old approval cancelled', s.tAmber] },
  { p: 11, tm: '9:23 PM', ag: 'Draft invoice', text: <>70 × ₹1,000 + 18% GST = <b>₹82,600</b></> },
  { p: 13, tm: '9:24 PM', ag: 'Meera · Finance', text: 'Approved ₹82,600 on WhatsApp', tone: 'green' },
  { p: 14, tm: '9:24 PM', ag: 'Invoice', text: <>Invoice <b>INV-2231</b> created in Zoho Books</>, tag: ['created once', s.tGrey] },
  { p: 15, tm: '9:24 PM', ag: 'Verified', text: 'Read back from Zoho: ₹82,600 matches ✓', tone: 'green' },
  { p: 16, tm: '9:24 PM', ag: 'RevenueGuard', text: 'Recovered ₹82,600 that was not billed', tone: 'green' },
];
const TONE: Record<Tone, string> = { ink: '#1A1A17', red: '#B23A26', amber: '#9A6A12', green: '#1E5A3C' };

const CAPTION: Record<number, string> = {
  1: 'A challan photo arrives on WhatsApp', 2: 'A challan photo arrives on WhatsApp', 3: 'Reading the PO, customer and quantity',
  5: 'Voice note understood, in Hinglish', 6: 'Matched to the right order by PO number', 7: 'Collecting proof from email and the sheet',
  8: 'Nothing billed yet: money is leaking', 9: 'Ravi corrects the count: it re-checks', 10: 'Ravi corrects the count: it re-checks',
  11: 'Invoice drafted. It waits for a person', 12: 'Invoice drafted. It waits for a person',
  13: 'Approved. Created once, then read back', 14: 'Approved. Created once, then read back', 15: 'Approved. Created once, then read back',
  16: 'Money you would have missed, now billed',
};

const STEPS = ['Received', 'Read', 'Matched', 'Checked', 'Your OK', 'Invoice', 'Verified', 'Paid'];
function stepState(i: number, p: number): [string, string] {
  // returns [className, subtitle]
  const sub = ['9:18 PM', 'photo + voice', 'PO-184', p >= 10 ? '70 of 100' : '', 'by Meera', 'INV-2231', 'matches', 'due 14 Nov'];
  const doneAt = [4, 5, 6, 10, 13, 14, 15, 99];
  const nowAt = [1, 4, 5, 6, 99, 13, 14, 15];
  if (i === 4 && p >= 11 && p < 13) return [s.wait, 'waiting'];
  if (i === 6 && p >= 15) return [s.good, sub[i]];
  if (p >= doneAt[i]) return [s.done, sub[i]];
  if (p >= nowAt[i]) return [s.now, i === 7 ? sub[i] : ''];
  return ['', ''];
}

function useCount(target: number, ms = 900) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const f = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const val = start + (target - start) * (1 - Math.pow(1 - k, 3));
      setV(val);
      from.current = val;
      if (k < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Figure({ value, ms }: { value: number; ms?: number }) {
  const v = useCount(value, ms);
  const [k, setK] = useState(0);
  useEffect(() => setK((x) => x + 1), [value]);
  return <div className={s.big}><span key={k} className={k > 1 ? s.flash : undefined}>{inr(v)}</span></div>;
}

export default function LiveScene() {
  const [p, setP] = useState(0);
  const [loop, setLoop] = useState(0);
  useEffect(() => {
    const ids = AT.map((t, i) => setTimeout(() => setP(i), t));
    ids.push(setTimeout(() => { setP(0); setLoop((l) => l + 1); }, LOOP_MS));
    return () => ids.forEach(clearTimeout);
  }, [loop]);

  // derived numbers
  const nb = p >= 10 && p < 14 ? 482000 : 412000;
  const wy = p >= 11 && p < 13 ? 82600 : 0;
  const rc = p >= 16 ? 422600 : 340000;
  const dv = p >= 10 ? 1105000 : 1035000;
  const bl = p >= 14 ? 705600 : 623000;
  const fillPct = (() => { let last = 0; STEPS.forEach((_, i) => { if (stepState(i, p)[0]) last = i; }); return (last / 7) * 88; })();

  // fly chip geometry
  const flowRef = useRef<HTMLDivElement>(null);
  const dRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState<React.CSSProperties | null>(null);
  useEffect(() => {
    if (p !== 14) { if (p < 14) setChip(null); return; }
    const d = dRef.current, b = bRef.current, f = flowRef.current;
    if (!d || !b || !f) return;
    setChip({ ['--x0' as any]: `${d.offsetLeft - 4}px`, ['--y0' as any]: `${d.offsetTop + 8}px`, ['--x1' as any]: `${b.offsetLeft - 4}px`, ['--y1' as any]: `${b.offsetTop - 44}px` });
  }, [p]);

  const now = p >= 15 ? ['Done. Watching for payment. Reminder plan starts on 14 Nov.', '#E4EEE6']
    : p >= 13 ? ['Creating invoice in Zoho…', '#F5F2EA']
    : p >= 11 ? ['Waiting for Meera to approve ₹70,000 + GST. Sent on WhatsApp.', '#F4EBD6']
    : p >= 7 ? ['Checking Zoho for an invoice…', '#F5F2EA']
    : p >= 1 ? ['New photo from Ravi. Reading it…', '#F5F2EA']
    : ['Waiting for new messages…', '#F5F2EA'];
  const ctag = p >= 15 ? ['Billed', s.tGreen] : p >= 6 ? ['Working', s.tAmber] : ['Watching', s.tGrey];
  const caption = CAPTION[p];

  return (
    <div className={s.scene}>
      <div>
        <div className={s.h}><span>WhatsApp · Dispatch</span></div>
        <div className={s.phone}><div className={s.scr}>
          <div className={s.wh}><div className={s.av}>R</div><div><b style={{ fontSize: 13 }}>Ravi (dispatch)</b><div style={{ fontSize: 11, color: '#777' }}>online</div></div></div>
          <div className={s.msgs}>
            <div className={cx(s.b, p >= 1 && s.show)}>
              <div className={s.ch}>
                <div key={`scan${loop}`} className={cx(s.scan, p >= 2 && s.scanGo)} />
                DEMO MANUFACTURING PVT LTD<br />DELIVERY CHALLAN<br />
                <span className={cx(s.hl, p >= 3 && s.hlOn)}>Challan No: DC-5521</span><br />Date: 12-10-2026<br />
                <span className={cx(s.hl, p >= 3 && s.hlOn)} style={{ transitionDelay: '.3s' }}>PO Ref: PO-184</span><br />
                <span className={cx(s.hl, p >= 3 && s.hlOn)} style={{ transitionDelay: '.6s' }}>Customer: Example Customer</span><br />Item: Model X<br />
                <span className={cx(s.hl, p >= 3 && s.hlOn)} style={{ transitionDelay: '.9s' }}>Qty Dispatched: 60</span><br />Vehicle: TS09 UB 4411
              </div>
              <div className={s.t}>9:18 PM</div>
            </div>
            <div className={cx(s.b, p >= 4 && s.show)}><b style={{ color: '#1E5A3C' }}>▶ 0:04</b>&nbsp; &quot;60 boxes gaye, baaki next week&quot;<div className={s.t}>9:18 PM</div></div>
            <div className={cx(s.b, s.me, p >= 6 && s.show)}><b>RevenueGuard</b>: Got it ✓ Added to PO-184 (Example Customer).<div className={s.t}>9:19 PM</div></div>
            <div className={cx(s.b, p >= 9 && s.show)}>Correction: 70 delivered, not 60<div className={s.t}>9:21 PM</div></div>
          </div>
          <div style={{ background: '#F7F5F2', padding: '9px 12px 18px' }}><div style={{ background: '#fff', borderRadius: 18, padding: '8px 12px', color: '#999', fontSize: 12 }}>Message</div></div>
        </div></div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
        <div className={s.strip}>
          <div><div className={s.lab} style={{ color: '#B23A26' }}>DELIVERED, NOT BILLED</div><Figure value={nb} /><div className={s.small}>{p >= 10 && p < 14 ? '7 deliveries' : '6 deliveries'}</div></div>
          <div><div className={s.lab} style={{ color: '#9A6A12' }}>WAITING FOR YOU</div><Figure value={wy} /><div className={s.small}>{wy ? '1 invoice' : 'nothing to approve'}</div></div>
          <div><div className={s.lab} style={{ color: '#1E5A3C' }}>RECOVERED THIS MONTH</div><Figure value={rc} ms={1400} /><div className={s.small}>would have been missed</div></div>
        </div>

        <div className={s.card}>
          <div className={s.cardHead}><b>Case RG-1042 · PO-184 · Example Customer</b><span className={cx(s.tag, ctag[1])}>{ctag[0]}</span></div>
          <div className={s.jr}>
            <div className={s.line} /><div className={s.fill} style={{ width: `${fillPct}%` }} />
            {STEPS.map((name, i) => {
              const [cls, sub] = stepState(i, p);
              const tick = cls === s.done || cls === s.good;
              return (
                <div key={name} className={cx(s.st, cls)}>
                  <div className={s.dot}>{tick ? '✓' : ''}</div>
                  <div className={s.sn}>{name}</div><div className={s.ss}>{sub}</div>
                </div>
              );
            })}
          </div>
          <div className={s.nowBar} style={{ background: now[1] }}>
            <span className={s.dotGrey} /><span>{now[0]}</span>
            <span className={cx(s.apBtn, p === 12 && s.tap)} style={{ opacity: p >= 11 && p < 13 ? 1 : 0 }}>✓ Approve ₹82,600</span>
          </div>
        </div>

        <div className={s.card}>
          <div style={{ padding: '13px 18px 0', fontSize: 14 }}><b>Money flow</b><span className={s.small}> · October orders</span></div>
          <div className={s.flow} ref={flowRef}>
            <div className={s.col}><div className={s.cv}>₹12,40,000</div><div className={s.bar} style={{ height: 150 }} /><div className={s.cl}>Ordered</div></div>
            <div className={s.col}><div className={s.cv}>{inr(useCount(dv))}</div><div ref={dRef} className={s.bar} style={{ height: p >= 10 ? 134 : 125 }} /><div className={s.cl}>Delivered</div></div>
            <div className={s.col}><div className={s.cv}>{inr(useCount(bl))}</div><div ref={bRef} className={s.bar} style={{ height: p >= 14 ? 85 : 75 }} /><div className={s.cl}>Billed</div></div>
            <div className={s.col}><div className={s.cv}>₹4,07,500</div><div className={cx(s.bar, s.green)} style={{ height: 49 }} /><div className={s.cl}>Paid</div></div>
            {chip && p >= 14 && p < 16 && <div key={`chip${loop}`} className={s.chip} style={chip}>+₹82,600</div>}
          </div>
          <div className={s.gap}>{inr(nb)} delivered but not billed</div>
        </div>

        {caption && <div className={s.cap}>{caption}</div>}
      </div>

      <div>
        <div className={s.h}><span>What&apos;s happening now</span><span className={s.live}><span className={s.pulse} />Live</span></div>
        <div className={cx(s.card, s.feed)}>
          {FEED.filter((f) => f.p <= p).reverse().map((f) => (
            <div key={`${loop}-${f.p}`} className={s.fi}>
              <span className={s.tm}>{f.tm}</span>
              <div>
                <div className={s.ag}>{f.ag}</div>
                <div style={{ color: TONE[f.tone ?? 'ink'] }}>{f.text}</div>
                {f.tag && <span className={cx(s.ftag, f.tag[1])}>{f.tag[0]}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
