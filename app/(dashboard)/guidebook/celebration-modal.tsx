'use client'

const TIER_COPY: Record<4 | 5 | 6, { title: string; body: string }> = {
  4: {
    title: 'Guidebook Unlocked! 🎉',
    body:  'You\'ve filled 4 sponsor slots — your guest guidebook is now live and self-funding.',
  },
  5: {
    title: 'Almost There! 🌟',
    body:  '5 sponsors onboard. One more slot and your guidebook is fully sponsored.',
  },
  6: {
    title: 'Fully Sponsored! 🏆',
    body:  'All 6 slots are filled. Your guidebook is completely self-funded.',
  },
}

interface CelebrationModalProps {
  tier:    4 | 5 | 6
  onClose: () => void
}

export function CelebrationModal({ tier, onClose }: CelebrationModalProps) {
  const copy = TIER_COPY[tier]

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: '16px',
      }}
      role="button"
      tabIndex={0}
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose() } }}
    >
      <div
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)', padding: '32px',
          maxWidth: '420px', width: '100%', textAlign: 'center',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--accent-gold)', margin: '0 0 12px' }}>
          {copy.title}
        </h2>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: '0 0 24px', lineHeight: 1.5 }}>
          {copy.body}
        </p>
        <button
          onClick={onClose}
          style={{
            padding: '10px 24px', borderRadius: 'var(--radius)',
            border: 'none', background: 'var(--accent-gold)',
            color: 'var(--text-inverse)', cursor: 'pointer',
            fontSize: '13px', fontWeight: '600',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
