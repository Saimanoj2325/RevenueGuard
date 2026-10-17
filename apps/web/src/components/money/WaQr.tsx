'use client';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { isDemo } from '@/lib/config';
import { useWs } from '@/lib/store';
import { plainError } from '../ui';

/** WhatsApp QR pairing (Linked devices). Uses GET /connectors/whatsapp/qr and the wa.qr socket event. */
export function WaQr({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = useWs((s) => s.waQr);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.whatsappQr();
        if (stop) return;
        if (r.state === 'open' || (!r.qr && r.state !== 'qr')) { onPaired(); return; }
        setQr(r.qr);
      } catch (e: any) { setErr(plainError(e?.message)); }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [onPaired]);
  const src = live ?? qr;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30" onClick={onClose}>
      <div className="w-[340px] rounded-md border border-rule-2 bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between font-semibold">Link WhatsApp <button onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <p className="mt-1 text-[13px] text-ink-2">On the business phone: WhatsApp › Settings › Linked devices › Link a device. Scan this code.</p>
        <div className="mt-4 grid aspect-square place-items-center border border-rule bg-white">
          {src ? <img src={src.startsWith('data:') || src.startsWith('http') ? src : `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(src)}`} alt="WhatsApp QR code" className="h-[240px] w-[240px]" /> : <span className="text-[13px] text-ink-3">Getting a code…</span>}
        </div>
        <p className="mt-2 text-[12px] text-ink-3">The code changes every few seconds. Nothing is read until you pick which chats to watch.</p>
        {isDemo() && <button className="btn-ghost btn-sm mt-3 w-full" onClick={async () => { await api.mockConnect('whatsapp'); setTimeout(onPaired, 1800); }}>Demo: pretend I scanned it</button>}
        {err && <div className="mt-2 text-[12.5px] text-red">{err}</div>}
      </div>
    </div>
  );
}
