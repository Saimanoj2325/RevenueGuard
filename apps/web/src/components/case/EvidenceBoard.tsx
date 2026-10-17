'use client';
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { ShieldX } from 'lucide-react';
import { memo, useEffect, useMemo } from 'react';
import { dateTime, human } from '@/lib/format';
import { useUi } from '@/lib/store';
import type { CaseDetail, EvidenceNode, Stage, StageStatus } from '@/lib/types';
import { SOURCE_META, SourceIcon, Stamp } from '@/components/legacy/ui';

const COLW = 320;
const CARD_W = 262;
const COLS: (Stage | 'context')[] = ['order', 'delivery', 'invoice', 'payment', 'context'];

function stageOfKind(n: EvidenceNode): Stage | 'context' {
  if (n.untrusted_flag) return 'context';
  switch (n.kind) {
    case 'email': case 'sales_order': case 'salesorder': case 'purchase_order': case 'document': case 'attachment': return 'order';
    case 'photo': case 'voice_note': case 'sheet_row': case 'message': case 'challan': case 'delivery_record': case 'chat_message': case 'correction_message': case 'media': return 'delivery';
    case 'invoice': case 'credit_note': case 'search': return 'invoice';
    case 'bank_txn': case 'payment': return 'payment';
    case 'search_result': { // API negative findings ("searched X, found nothing"), placed by the tool that ran
      const t = String(n.fields?.tool ?? '');
      if (/bank|payment/.test(t)) return 'payment';
      if (/zoho|alt_ids|credit/.test(t)) return 'invoice';
      if (/sheets|whatsapp/.test(t)) return 'delivery';
      return 'order';
    }
    default: return 'context';
  }
}
const rot = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return ((h % 25) / 10) - 1.2; };

type StageData = { stage: string; status: StageStatus | 'context'; note?: string; count: number };
type EvData = { n: EvidenceNode; hl: boolean; dim: boolean };

const H = (
  <>
    <Handle type="target" position={Position.Left} id="t-l" />
    <Handle type="target" position={Position.Top} id="t-t" />
    <Handle type="target" position={Position.Right} id="t-r" />
    <Handle type="source" position={Position.Right} id="s-r" />
    <Handle type="source" position={Position.Bottom} id="s-b" />
    <Handle type="source" position={Position.Left} id="s-l" />
  </>
);

const StageNode = memo(function StageNode({ data }: NodeProps<Node<StageData>>) {
  const missing = data.status === 'missing';
  const context = data.status === 'context';
  const tone = { found: '#1E5A3C', partial: '#9A6A12', conflict: '#B23A26', missing: '#B23A26', context: '#55534C' }[data.status];
  return (
    <div className={clsx('relative w-[262px] rounded-md px-3 py-2', missing ? 'border-2 border-dashed border-red/80 bg-red/5' : context ? 'border border-dashed border-rule bg-card' : 'border border-rule bg-card')}>
      {H}
      <div className="flex items-center justify-between">
        <span className="serif text-[17px] capitalize text-[#1A1A17]">{data.stage}</span>
        <span className="num text-[10.5px] font-semibold uppercase tracking-[0.16em]" style={{ color: tone }}>{context ? `${data.count} item${data.count === 1 ? '' : 's'}` : data.status}</span>
      </div>
      {data.note && <div className="mt-0.5 truncate text-[11.5px] text-ink-2">{data.note}</div>}
      {missing && (
        <svg className="absolute -bottom-[7px] left-0 w-full" height="8" viewBox="0 0 262 8" preserveAspectRatio="none" aria-hidden>
          <path d="M0 0 L10 7 L22 1 L33 8 L47 2 L58 7 L71 1 L84 8 L97 2 L110 7 L124 0 L137 8 L150 2 L163 7 L176 1 L190 8 L203 2 L216 7 L229 1 L243 8 L262 2" fill="none" stroke="#B23A26" strokeWidth="1.2" />
        </svg>
      )}
    </div>
  );
});

const EvidenceCard = memo(function EvidenceCard({ data }: NodeProps<Node<EvData>>) {
  const { n, hl, dim } = data;
  const meta = SOURCE_META[n.source] ?? SOURCE_META.drive;
  const untrusted = !!n.untrusted_flag;
  const fields = Object.entries(n.fields ?? {}).filter(([, v]) => typeof v !== 'object').slice(0, 4);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: -12 }}
      animate={{ opacity: dim ? 0.35 : 1, scale: hl ? 1.04 : 1, y: 0 }}
      transition={{ type: 'spring', damping: 20, stiffness: 220 }}
      style={{ rotate: rot(n.id), width: CARD_W }}
      className={clsx('paper relative cursor-default p-0',
        untrusted && 'outline outline-2 outline-red',
        hl && 'ring-4 ring-red/70 ring-offset-2 ring-offset-ink',
        n.ruled_out && 'saturate-50')}
      data-node-id={n.id}
    >
      {H}
      {/* pin */}
      <span className="absolute -top-[7px] left-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 rounded-full border border-black/30 shadow-[0_3px_4px_rgba(0,0,0,.45)]" style={{ background: untrusted ? '#B23A26' : n.ruled_out ? '#55534C' : '#9A6A12' }} />
      <div className="flex items-center gap-1.5 border-b border-rule px-2.5 py-1.5">
        <SourceIcon source={n.source} kind={n.kind} size={13} />
        <span className="num text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: untrusted ? '#B23A26' : '#5b5141' }}>{meta.label} · {human(n.kind)}</span>
        <span className="num ml-auto text-[9.5px] text-ink-3">{dateTime(n.ts)}</span>
      </div>
      {n.media_url && (
        <div className="relative mx-2.5 mt-2 overflow-hidden rounded-[3px] border border-rule bg-paper">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={n.media_url} alt={n.title} className={clsx('h-[104px] w-full object-cover', untrusted && 'blur-sm')} draggable={false} />
        </div>
      )}
      <div className="px-2.5 pb-2.5 pt-2">
        <div className={clsx('serif text-[14.5px] font-medium leading-snug', untrusted && 'text-[#B23A26]')}>{n.title}</div>
        {n.excerpt && (
          <p className={clsx('mt-1 text-[12px] leading-snug', untrusted ? 'num rounded-[3px] bg-red/10 px-1.5 py-1 text-[11px] text-[#B23A26] line-through decoration-red/50' : 'text-ink-3')}>
            {n.excerpt}
          </p>
        )}
        {fields.length > 0 && !untrusted && (
          <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5">
            {fields.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="num truncate text-[9px] uppercase tracking-wider text-ink-3">{human(k)}</dt>
                <dd className="num truncate text-[11.5px] text-ink">{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="num mt-2 truncate text-[9.5px] text-ink-3" title={n.source_id}>{n.source_id}</div>
      </div>
      {untrusted && (
        <div className="absolute -right-2 top-9 flex items-center gap-1">
          <Stamp color="#B7281F" className="bg-paper"><ShieldX size={11} /> quarantined</Stamp>
        </div>
      )}
      {n.ruled_out && <div className="absolute -right-1 top-10"><Stamp color="#55534C" className="bg-paper">ruled out</Stamp></div>}
    </motion.div>
  );
});

const nodeTypes = { stage: StageNode, evidence: EvidenceCard };

function Fit({ count }: { count: number }) {
  const rf = useReactFlow();
  useEffect(() => { const t = setTimeout(() => rf.fitView({ padding: 0.08, duration: 500, maxZoom: 1 }), 80); return () => clearTimeout(t); }, [count, rf]);
  return null;
}

function Board({ detail, height }: { detail: CaseDetail; height: number }) {
  const hover = useUi((s) => s.hoverNodes);
  const { nodes, edges } = useMemo(() => {
    const colOf = new Map<string, number>();
    for (const t of detail.timeline) for (const id of t.evidence_node_ids) if (!colOf.has(id)) colOf.set(id, COLS.indexOf(t.stage));
    const ev = detail.evidence.nodes;
    for (const n of ev) {
      if (n.untrusted_flag) colOf.set(n.id, 4);
      else if (!colOf.has(n.id)) colOf.set(n.id, COLS.indexOf(stageOfKind(n)));
    }
    const yAt = [118, 118, 118, 118, 118];
    const anyHl = hover.length > 0;
    const out: Node[] = [];
    const ctxCount = ev.filter((n) => colOf.get(n.id) === 4).length;
    COLS.forEach((s, i) => {
      if (s === 'context' && ctxCount === 0) return;
      const t = detail.timeline.find((x) => x.stage === s);
      out.push({
        id: `stage:${s}`, type: 'stage', position: { x: i * COLW, y: 0 }, draggable: false, selectable: false,
        data: { stage: s === 'context' ? 'context & quarantine' : s, status: s === 'context' ? 'context' : t?.status ?? 'missing', note: t?.note, count: ctxCount } satisfies StageData,
      });
    });
    const sorted = [...ev].sort((a, b) => Number(!!a.untrusted_flag) - Number(!!b.untrusted_flag) || a.ts.localeCompare(b.ts));
    for (const n of sorted) {
      const c = colOf.get(n.id) ?? 4;
      out.push({
        id: n.id, type: 'evidence', position: { x: c * COLW, y: yAt[c] }, draggable: true,
        data: { n, hl: hover.includes(n.id), dim: anyHl && !hover.includes(n.id) } satisfies EvData,
      });
      const nf = Object.values(n.fields ?? {}).filter((v) => typeof v !== 'object').slice(0, 4).length;
      const est = 30 + (n.media_url ? 114 : 0) + Math.ceil(n.title.length / 26) * 20 + Math.ceil((n.excerpt?.length ?? 0) / 38) * 17
        + (n.untrusted_flag ? 10 : Math.ceil(nf / 2) * 30) + 44;
      yAt[c] += est + 40;
    }
    const idSet = new Set(ev.map((n) => n.id));
    const es: Edge[] = [];
    // spine
    for (let i = 0; i < 3; i++) {
      const a = detail.timeline.find((x) => x.stage === COLS[i]);
      const b = detail.timeline.find((x) => x.stage === COLS[i + 1]);
      const broken = !a || !b || a.status === 'missing' || b.status === 'missing';
      es.push({
        id: `spine:${i}`, source: `stage:${COLS[i]}`, target: `stage:${COLS[i + 1]}`, sourceHandle: 's-r', targetHandle: 't-l',
        animated: broken, label: broken ? 'gap' : undefined,
        style: { stroke: broken ? '#B23A26' : '#9A6A12', strokeWidth: broken ? 1.6 : 2.4, strokeDasharray: broken ? '6 6' : undefined, opacity: broken ? 0.8 : 1 },
      });
    }
    // pin strings from stage to first card in each column
    COLS.forEach((s, i) => {
      const first = sorted.find((n) => colOf.get(n.id) === i);
      if (first) es.push({ id: `pin:${s}`, source: `stage:${s}`, target: first.id, sourceHandle: 's-b', targetHandle: 't-t', style: { stroke: '#4a5164', strokeWidth: 1, strokeDasharray: '2 4' } });
    });
    // red threads
    detail.evidence.edges.forEach((e, i) => {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      const cf = colOf.get(e.from) ?? 0, ct = colOf.get(e.to) ?? 0;
      const [sh, th] = ct > cf ? ['s-r', 't-l'] : ct < cf ? ['s-l', 't-r'] : ['s-b', 't-t'];
      const quarantine = e.label === 'quarantined';
      const hl = hover.includes(e.from) || hover.includes(e.to);
      es.push({
        id: `ev:${i}`, source: e.from, target: e.to, sourceHandle: sh, targetHandle: th, label: e.label, type: 'default',
        animated: quarantine,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#B23A26', width: 14, height: 14 },
        style: { stroke: quarantine ? '#7a1f2b' : '#B23A26', strokeWidth: hl ? 3 : 1.8, strokeDasharray: quarantine || e.label?.startsWith('ruled') ? '4 4' : undefined, filter: hl ? 'drop-shadow(0 0 4px #B23A26)' : undefined },
      });
    });
    return { nodes: out, edges: es };
  }, [detail, hover]);

  return (
    <div style={{ height: `clamp(420px, 72vh, ${height}px)` }} className="relative w-full overflow-hidden rounded-lg border border-rule bg-[#F5F2EA]">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.6}
        proOptions={{ hideAttribution: true }} nodesConnectable={false} elementsSelectable={false} panOnScroll={false} zoomOnScroll
        aria-label="Evidence board">
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#F5F2EA" />
        <Controls showInteractive={false} position="bottom-right" />
        <Fit count={nodes.length} />
      </ReactFlow>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-3 text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1.5"><span className="h-[2px] w-5 bg-red" />-red (corroborates)</span>
        <span className="flex items-center gap-1.5"><span className="h-[2px] w-5 border-t-2 border-dashed border-red" />gap / ruled out</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red" />untrusted</span>
      </div>
    </div>
  );
}

export function EvidenceBoard(props: { detail: CaseDetail; height?: number }) {
  return (
    <ReactFlowProvider>
      <Board detail={props.detail} height={props.height ?? 640} />
    </ReactFlowProvider>
  );
}
