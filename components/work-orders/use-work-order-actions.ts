'use client'

import { useState, useTransition } from 'react'
import {
  markVendorAcknowledged,
  markWorkVerified,
} from '@/app/(dashboard)/maintenance/work-order-actions'
import { rateWorkOrderVendor, deleteWorkOrder } from '@/app/(dashboard)/maintenance/actions'
import { dispatchWorkOrderToVendor } from '@/app/actions/work-order-public'
import type { WorkOrderDetailData } from './work-order-detail'

/**
 * All mutation handlers + their local UI state for WorkOrderDetail —
 * extracted so the component itself is left as rendering plus a handful of
 * dialogs, not 11 useState hooks and 6 handlers in one function body. Every
 * Server Action call and its error handling is unchanged from the original
 * inline version — pure code motion.
 */
export function useWorkOrderActions(wo: WorkOrderDetailData) {
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [nteOverrideConfirmed, setNteOverrideConfirmed] = useState(false)
  const [hoverRating, setHoverRating] = useState(0)
  const [savedRating, setSavedRating] = useState<number | null>(wo.vendor_rating ?? null)
  const [ratingNotes, setRatingNotes] = useState(wo.vendor_rating_notes ?? '')
  const [ratingPending, startRatingTransition] = useTransition()
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [ratingSuccess, setRatingSuccess] = useState(false)

  // Cancel work order modal state
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // Dispatch modal state
  const [showDispatch,    setShowDispatch]    = useState(false)
  const [dispatchEmail,   setDispatchEmail]   = useState(wo.vendor_dispatch_email ?? wo.vendors?.email ?? '')
  const [dispatchName,    setDispatchName]    = useState(wo.vendors?.name ?? '')
  const [dispatching,     setDispatching]     = useState(false)
  const [dispatchError,   setDispatchError]   = useState<string | null>(null)
  const [dispatchedUrl,   setDispatchedUrl]   = useState<string | null>(null)
  const [copied,          setCopied]          = useState(false)

  function handleAcknowledge() {
    setActionError(null)
    startTransition(async () => {
      try { await markVendorAcknowledged(wo.id) }
      catch (e) { setActionError(e instanceof Error ? e.message : 'Failed.') }
    })
  }

  function handleVerify() {
    setActionError(null)
    startTransition(async () => {
      try { await markWorkVerified(wo.id) }
      catch (e) { setActionError(e instanceof Error ? e.message : 'Failed.') }
    })
  }

  function handleCancel() {
    setActionError(null)
    startTransition(async () => {
      try {
        await deleteWorkOrder(wo.id)
        setShowCancelConfirm(false)
      }
      catch (e) { setActionError(e instanceof Error ? e.message : 'Failed to cancel work order.') }
    })
  }

  function handleRating(star: number) {
    setSavedRating(star)
    setRatingError(null)
    setRatingSuccess(false)
    startRatingTransition(async () => {
      try {
        await rateWorkOrderVendor(wo.id, star as 1 | 2 | 3 | 4 | 5, ratingNotes)
        setRatingSuccess(true)
      } catch (e) {
        setRatingError(e instanceof Error ? e.message : 'Failed to save rating.')
      }
    })
  }

  function handleRatingNotesSave() {
    if (!savedRating) return
    handleRating(savedRating)
  }

  async function handleDispatch() {
    if (!dispatchEmail.trim()) return
    setDispatching(true)
    setDispatchError(null)
    try {
      const result = await dispatchWorkOrderToVendor({
        workOrderId: wo.id,
        vendorEmail: dispatchEmail.trim(),
        vendorName:  dispatchName.trim() || 'Contractor',
        vendorPhone: wo.vendors?.phone ?? null,
      })
      if (result.error) {
        setDispatchError(result.error)
        return
      }
      if (result.publicUrl) {
        setDispatchedUrl(result.publicUrl)
      }
    } catch (err) {
      console.error('[handleDispatch] failed:', err)
      setDispatchError('Could not dispatch vendor. Please check your connection and try again.')
    } finally {
      setDispatching(false)
    }
  }

  function handleCopyUrl() {
    if (!dispatchedUrl) return
    navigator.clipboard.writeText(dispatchedUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return {
    isPending, actionError,
    nteOverrideConfirmed, setNteOverrideConfirmed,
    hoverRating, setHoverRating,
    savedRating, ratingNotes, setRatingNotes,
    ratingPending, ratingError, ratingSuccess,
    showCancelConfirm, setShowCancelConfirm,
    showDispatch, setShowDispatch,
    dispatchEmail, setDispatchEmail,
    dispatchName, setDispatchName,
    dispatching, dispatchError, setDispatchError,
    dispatchedUrl, setDispatchedUrl,
    copied,
    handleAcknowledge, handleVerify, handleCancel,
    handleRating, handleRatingNotesSave,
    handleDispatch, handleCopyUrl,
  }
}

export type WorkOrderActions = ReturnType<typeof useWorkOrderActions>
