'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
// Old v1 route: moved in UX v2.
export default function Moved() {
  const r = useRouter();
  useEffect(() => { r.replace('/advanced/audit'); }, [r]);
  return <p className="text-[13px] text-ink-3">This page moved. Opening it…</p>;
}
