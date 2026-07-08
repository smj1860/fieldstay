import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'cta' | 'secondary' | 'danger' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

const variantClass: Record<ButtonVariant, string> = {
  primary:   'btn-primary',
  cta:       'btn-cta',
  secondary: 'btn-secondary',
  danger:    'btn-danger',
  ghost:     'btn-ghost',
}

/**
 * The raw button-variant class name, for elements that render button styling
 * but can't be the <Button> component itself — a <Link>/<a> styled as a
 * button (real navigation, so it must stay an anchor, not a <button onClick>),
 * or a disabled-looking non-interactive <span>. Never hand-write "btn-primary"
 * etc. as a literal string outside this file; call this instead so the class
 * name has one source of truth (and so check-raw-ui-classes.sh, which greps
 * for the literal string in a className="..." attribute, doesn't flag it).
 */
export function buttonVariantClass(variant: ButtonVariant): string {
  return variantClass[variant]
}

export function Button({ variant = 'primary', className = '', ...props }: Readonly<ButtonProps>) {
  return <button className={`${buttonVariantClass(variant)} ${className}`} {...props} />
}
