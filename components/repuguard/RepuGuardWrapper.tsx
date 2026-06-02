"use client";

import dynamic from 'next/dynamic';

// This is where you disable SSR
const RepuGuardSandbox = dynamic(
  () => import('@/components/repuguard/RepuGuardSandbox'),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 bg-[#0a1628] border border-[#0e2040] rounded-2xl animate-pulse" />
    ),
  }
);

export default function RepuGuardWrapper() {
  return <RepuGuardSandbox />;
}
