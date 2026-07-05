import type { HTMLAttributes } from 'react'

export function Card({ className = '', ...props }: Readonly<HTMLAttributes<HTMLDivElement>>) {
  return <div className={`card ${className}`} {...props} />
}
