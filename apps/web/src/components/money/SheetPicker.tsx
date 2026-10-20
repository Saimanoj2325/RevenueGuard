'use client';
import clsx from 'clsx';
import { Check, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, StatusTag, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { isDemo } from '@/lib/config';
import type { SheetColumn } from '@/lib/v2types';

const MEANINGS: [string, string][] = [['po_ref', 'PO number'], ['customer', 'Customer'], ['item', 'Item'], ['qty_ordered', 'Ordered quantity'], ['qty_delivered', 'Delivered quantity'], ['qty_pending', 'Pending quantity'], ['delivery_date', 'Delivery date'], ['ignore', 'Ignore']];
/** Accepts a full Google Sheets link or a bare ID and returns the ID. */
export function sheetIdOf(input: string): string {
  const t = input.trim();
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || t.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : t;
}

/** Paste a Google Sheet link, AI guesses what each column means, the user confirms. Used in Setup (step 3) and on Connections. */
export function SheetPicker({ onDone, eyebrow, doneLabel = 'Looks right, continue', initialId = '', initialTab = 'Oct' }: { onDone: () => void; eyebrow?: string; doneLabel?: string; initialId?: string; initialTab?: string }) {
  const [id, setId] = useState(initialId || (isDemo() ? '1YqDispatchRegister2026' : ''));
  const [tab, setTab] = useState(initialTab);
  const [cols, setCols] = useState<SheetColumn[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<{ title?: string; rows?: number }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function read() {
    setBusy(true); setErr(null);
    try { const r = await api.proposeMapping(sheetIdOf(id), tab.trim()); setCols(r.columns); setMeta({ title: r.title, rows: r.rows }); setMap(Object.fromEntries(r.columns.map((c) => [c.header, c.meaning]))); }
    catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr(null);
    try { await api.saveSheetConfig(sheetIdOf(id), `${tab.trim()}!A1:Z1000`, map); onDone(); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  const sample = (m: string) => cols?.find((c) => map[c.header] === m)?.sample.split(',')[0].trim();
  return (
    <div>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h2 className="mt-1 text-[22px] font-semibold tracking-[-0.015em] sm:text-[26px]">{cols ? 'We read your sheet. Check the columns.' : 'Which sheet has your deliveries?'}</h2>
      {!cols ? (
        <div className="mt-4 max-w-[560px] space-y-3">
          <label className="block text-[13px] text-ink-2">Google Sheet link or ID<input className="input mt-1" value={id} onChange={(e) => setId(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></label>
          <label className="block text-[13px] text-ink-2">Tab name<input className="input mt-1 max-w-[200px]" value={tab} onChange={(e) => setTab(e.target.value)} /></label>
          <button className="btn" disabled={!id || busy} onClick={read}>{busy ? 'Reading…' : 'Read my sheet'}</button>
          <p className="text-[12.5px] text-ink-3">We read the header and the first 20 rows, guess each column from its name first, then its values. You confirm.</p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[14px] text-ink-2"><FileSpreadsheet size={14} className="mr-1 inline" /><b>{meta.title}</b> · tab &quot;{tab}&quot; · {meta.rows} rows. We guessed what each column means from its name and values. Fix any that look wrong.</p>
          <div className="card mt-4 overflow-x-auto">
            <table className="tbl min-w-[640px]">
              <thead><tr><th>Your column</th><th>Sample values</th><th>Means</th><th>Our guess</th></tr></thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.header}>
                    <td><span className="mono rounded-sm border border-rule-2 bg-paper px-2 py-0.5 text-[12.5px]">{c.header}</span></td>
                    <td className="text-[13px] text-ink-3">{c.sample}</td>
                    <td><select className={clsx('select max-w-[220px] py-1.5 text-[13.5px]', c.confidence === 'check' && 'border-amber')} value={map[c.header]} onChange={(e) => setMap({ ...map, [c.header]: e.target.value })}>{MEANINGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                    <td>{map[c.header] === 'ignore' ? <span className="text-[13px] text-ink-3">Ignore</span> : <StatusTag tone={c.confidence === 'sure' ? 'green' : 'amber'}>{c.confidence === 'sure' ? 'Sure' : 'Please check'}</StatusTag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-md border border-green/25 bg-green-bg/70 px-4 py-3 text-[13.5px]"><Check size={15} className="mt-0.5 text-green" /><span><b>Preview with these columns:</b> {[sample('po_ref'), sample('customer'), sample('qty_ordered') && `${sample('qty_ordered')} ordered`, sample('qty_delivered') && `${sample('qty_delivered')} delivered`, sample('qty_pending') && `${sample('qty_pending')} pending`, sample('delivery_date')].filter(Boolean).join(' · ')}</span></div>
          <div className="mt-4 flex flex-wrap gap-2"><button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : doneLabel}</button><button className="btn-ghost" onClick={() => setCols(null)}>Use a different tab</button></div>
        </>
      )}
      {err && <ErrorState error={err} className="mt-3" />}
    </div>
  );
}
