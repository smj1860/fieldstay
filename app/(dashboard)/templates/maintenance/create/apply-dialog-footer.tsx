'use client'

import { Clock, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface ApplyDialogFooterProps {
  isDone:   boolean
  applying: boolean
  disabled: boolean
  onApply:  () => void
  onClose:  () => void
}

/** Footer of ApplyTemplateDialog — split out to keep the dialog's own
 *  Cognitive Complexity (SonarCloud typescript:S3776) under threshold. */
export function ApplyDialogFooter({ isDone, applying, disabled, onApply, onClose }: Readonly<ApplyDialogFooterProps>) {
  if (isDone) {
    return <Button onClick={onClose} className="w-full">Done</Button>
  }

  const label = applying ? 'Applying…' : 'Apply Template'
  const icon = applying ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />

  return (
    <>
      <Button variant="ghost" type="button" onClick={onClose}>Skip</Button>
      <Button
        onClick={onApply}
        disabled={disabled}
        className="flex-1 flex items-center justify-center gap-2"
      >
        {icon}
        {label}
      </Button>
    </>
  )
}
