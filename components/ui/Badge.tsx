import type { HTMLAttributes } from 'react'

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'purple' | 'slate'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone: Tone
}

export function Badge({ tone, className = '', ...props }: Readonly<BadgeProps>) {
  return <span className={`badge badge-${tone} ${className}`} {...props} />
}
