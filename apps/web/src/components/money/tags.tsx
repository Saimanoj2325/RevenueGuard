'use client';
import { StatusTag } from '@/components/ui';
import { useT } from '@/i18n';
import type { BillStatus, Risk } from '@/lib/v2types';

export function BillTag({ status }: { status: BillStatus }) {
  const t = useT();
  return <StatusTag tone={status === 'not_billed' ? 'red' : 'amber'}>{t(`st.${status}` as any)}</StatusTag>;
}
export function RiskTag({ risk, reason }: { risk: Risk; reason?: string }) {
  const t = useT();
  return <StatusTag tone={risk === 'good' ? 'green' : risk === 'watch' ? 'amber' : 'red'} title={reason} className="cursor-help">{t(`st.${risk}` as any)}</StatusTag>;
}
