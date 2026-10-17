'use client';
import clsx from 'clsx';
import { FileSpreadsheet, FileText, Image as ImageIcon, Landmark, Mail, MessageCircle, Mic, ReceiptText, X, PenLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { dateIN, timeIN } from '@/lib/format';
import type { EvidenceNode } from '@/lib/types';
import type { Proof, ProofKind } from '@/lib/v2types';
import { ErrorState, Skeleton } from './States';

export const PROOF_ICON: Record<ProofKind, any> = {
  email: Mail, whatsapp: MessageCircle, photo: ImageIcon, voice: Mic, sheet: FileSpreadsheet, zoho: ReceiptText, pdf: FileText, bank: Landmark, manual: PenLine,
};

const SHORT: Partial<Record<ProofKind, string>> = { email: 'PO', photo: 'Challan', voice: 'Voice', sheet: 'Sheet', zoho: 'Zoho', pdf: 'PDF', bank: 'Bank', whatsapp: 'WhatsApp', manual: 'Manual' };

interface ProofView { caseRef: string; proof: Proof }
export const useProofView = create<{ open: ProofView | null; show: (v: ProofView) => void; close: () => void }>()((set) => ({
  open: null, show: (v) => set({ open: v }), close: () => set({ open: null }),
}));

/** Source icon + label. Opens the source (the evidence record it came from). */
export function ProofChip({ proof, caseRef, className, short }: { proof: Proof; caseRef?: string | null; className?: string; short?: boolean }) {
  const Icon = PROOF_ICON[proof.kind] ?? FileText;
  const show = useProofView((s) => s.show);
  const can = !!caseRef;
  return (
    <button type="button" disabled={!can} onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (caseRef) show({ caseRef, proof }); }}
      className={clsx('chip max-w-full', can && 'hover:border-ink-3 hover:text-ink', className)} title={can ? 'Open the source' : proof.label}>
      <Icon size={12} strokeWidth={1.8} className="shrink-0" /><span className="truncate">{short ? SHORT[proof.kind] ?? proof.label : proof.label}</span>
    </button>
  );
}

export function ProofList({ proofs, caseRef, max = 4, short }: { proofs: Proof[]; caseRef?: string | null; max?: number; short?: boolean }) {
  const shown = proofs.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((p, i) => <ProofChip key={i} proof={p} caseRef={caseRef} short={short} />)}
      {proofs.length > max && <span className="chip">+{proofs.length - max}</span>}
    </div>
  );
}

/** Modal that shows the source record for a proof chip. Mounted once in the Shell. */
export function ProofDrawer() {
  const { open, close } = useProofView();
  const [node, setNode] = useState<EvidenceNode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    setNode(null); setErr(null); setLoading(true);
    api.case(open.caseRef).then((d) => {
      const nodes = d.evidence.nodes;
      const want = open.proof.node_id;
      const n = (want && nodes.find((x) => x.id === want)) || nodes.find((x) => x.title?.includes(open.proof.label.split(' ')[0])) || null;
      setNode(n);
    }).catch((e) => setErr(e?.message ?? String(e))).finally(() => setLoading(false));
  }, [open]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!open) return null;
  const Icon = PROOF_ICON[open.proof.kind] ?? FileText;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/30 sm:items-center" onClick={close} role="dialog" aria-modal="true" aria-label="Source">
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-t-md border border-rule-2 bg-card sm:rounded-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-rule px-4 py-3">
          <Icon size={15} strokeWidth={1.8} className="text-ink-2" />
          <div className="min-w-0 flex-1 truncate font-semibold">{open.proof.label}</div>
          <span className="mono text-[11px] text-ink-3">{open.caseRef}</span>
          <button onClick={close} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>
        <div className="p-4">
          {loading && <Skeleton lines={3} />}
          {err && <ErrorState error={err} />}
          {!loading && !err && !node && <div className="text-[13.5px] text-ink-2">This proof is summarised from the case record. Open the case to see every source.</div>}
          {node && (
            <div className="space-y-3 text-[13.5px]">
              <div className="font-medium">{node.title}</div>
              <div className="text-[12px] text-ink-3">{dateIN(node.ts)} · {timeIN(node.ts)} · from {node.source === 'media' ? 'WhatsApp' : node.source}</div>
              {node.untrusted_flag && <div className="tag t-red">Kept aside: looked like instructions, not data</div>}
              {node.media_url && <img src={node.media_url} alt={node.title} className="max-h-[280px] w-full rounded border border-rule object-contain" />}
              {node.excerpt && <blockquote className="border-l-2 border-rule-2 bg-paper px-3 py-2 text-ink-2">{node.excerpt}</blockquote>}
              {node.derived_text && <div className="text-[12.5px] text-ink-2"><span className="text-ink-3">Read as: </span>{node.derived_text}</div>}
              {node.fields && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                  {Object.entries(node.fields).filter(([, v]) => typeof v !== 'object').slice(0, 8).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-ink-3">{k.replace(/_/g, ' ')}</dt><dd className="mono break-all">{String(v)}</dd></div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
