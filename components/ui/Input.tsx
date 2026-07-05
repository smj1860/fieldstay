import { forwardRef, type InputHTMLAttributes } from 'react'

export const Input = forwardRef<HTMLInputElement, Readonly<InputHTMLAttributes<HTMLInputElement>>>(
  function Input({ className = '', ...props }, ref) {
    return <input ref={ref} className={`input ${className}`} {...props} />
  }
)
