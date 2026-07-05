import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'cta' | 'secondary' | 'danger' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

const variantClass: Record<Variant, string> = {
  primary:   'btn-primary',
  cta:       'btn-cta',
  secondary: 'btn-secondary',
  danger:    'btn-danger',
  ghost:     'btn-ghost',
}

export function Button({ variant = 'primary', className = '', ...props }: Readonly<ButtonProps>) {
  return <button className={`${variantClass[variant]} ${className}`} {...props} />
}
