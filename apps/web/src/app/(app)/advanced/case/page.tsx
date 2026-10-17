'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CaseFile } from '@/components/case/CaseFile';
import { Empty, Skeleton } from '@/components/legacy/ui';

// Case file lives at /case?id=RG-1042 (query param, so the static export works for any case id).
function Inner() {
  const id = useSearchParams().get('id');
  if (!id) return <Empty title="No case selected" hint="Open a case from the docket." />;
  return <CaseFile id={id} key={id} />;
}

export default function CasePage() {
  return <Suspense fallback={<Skeleton className="h-40" />}><Inner /></Suspense>;
}
