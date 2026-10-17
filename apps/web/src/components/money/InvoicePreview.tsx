'use client';
import { inr } from '@/lib/format';
import type { GstPreview } from '@/lib/v2types';

const n2 = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

/** GST invoice preview: GSTINs, HSN, CGST+SGST (same state) or IGST, round-off, total in words. */
export function InvoicePreview({ g, customer, poRef }: { g: GstPreview; customer: string; poRef: string }) {
  const taxable = g.lines.reduce((s, l) => s + l.taxable, 0);
  return (
    <div className="text-[13.5px]">
      <div className="text-[12.5px] text-ink-3">Bill to</div>
      <div className="font-semibold">{customer}</div>
      <div className="mono text-[11.5px] text-ink-2">GSTIN {g.buyer_gstin} · {g.place_of_supply.replace(/^\d+ - /, '')}</div>
      <table className="mt-4 w-full">
        <thead><tr className="border-b border-rule-2 text-[12px] text-ink-3"><th className="pb-2 text-left font-medium">Item</th><th className="pb-2 text-right font-medium">Qty</th><th className="pb-2 text-right font-medium">Amount</th></tr></thead>
        <tbody>
          {g.lines.map((l, i) => (
            <tr key={i} className="border-b border-rule">
              <td className="py-3"><div>{l.item}</div><div className="text-[12px] text-ink-3">HSN {l.hsn} · Ref {poRef}</div></td>
              <td className="num py-3 text-right">{l.qty} × {l.rate.toLocaleString('en-IN')}</td>
              <td className="num py-3 text-right">{inr(l.taxable)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1.5 border-b border-ink py-3">
        {g.igst ? <Row k="IGST 18%" v={n2(g.igst)} /> : <><Row k="CGST 9%" v={n2(g.cgst)} /><Row k="SGST 9%" v={n2(g.sgst)} /></>}
        {g.round_off !== 0 && <Row k="Round off" v={(g.round_off > 0 ? '+' : '') + g.round_off.toFixed(2)} />}
      </div>
      <div className="flex items-baseline justify-between pt-3">
        <span className="text-[16px] font-semibold">Total</span>
        <span className="serif text-[30px] leading-none">{inr(g.total)}</span>
      </div>
      <div className="mt-1 text-right text-[11.5px] text-ink-3">{g.total_words}</div>
      <p className="mt-3 text-[12.5px] text-ink-3">{g.igst ? 'Different state, so IGST.' : 'Same state, so CGST + SGST.'} Taxable {inr(taxable)}. {g.irn_note ?? 'No e-invoice (IRN) needed at your turnover.'}</p>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between text-ink-2"><span>{k}</span><span className="num">{v}</span></div>;
