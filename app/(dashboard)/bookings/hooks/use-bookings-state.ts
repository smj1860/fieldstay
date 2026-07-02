'use client'

import { useState, useEffect, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cancelBooking, triggerSync } from '../actions'
import type { BookingSource, BookingStatus } from '@/types/database'

export interface BookingRow {
  id:                   string
  property_id:          string
  guest_name:           string | null
  checkin_date:         string
  checkout_date:        string
  checkin_time:         string | null
  checkout_time:        string | null
  source:               BookingSource
  status:               BookingStatus
  notes:                string | null
  has_overlap_conflict: boolean
  created_at:           string
  ical_feed_id:         string | null
  external_source:      string | null
  properties:           { id: string; name: string; city: string | null; state: string | null } | null
  turnovers:            { id: string; status: string; checkout_datetime: string }
                       | { id: string; status: string; checkout_datetime: string }[]
                       | null
}

export interface PropertyOption { id: string; name: string }

function isToday(date: string): boolean {
  return new Date(date).toDateString() === new Date().toDateString()
}

export function useBookingsState(initialBookings: BookingRow[], filtered_bookings_for_export?: BookingRow[]) {
  const router = useRouter()

  const [syncing,         startSync]          = useTransition()
  const [showAdd,         setShowAdd]         = useState(false)
  const [viewMode,        setViewMode]        = useState<'list' | 'calendar'>('list')
  const [filterProperty,  setFilterProperty]  = useState('all')
  const [filterStatus,    setFilterStatus]    = useState<'all' | 'active' | BookingStatus>('active')
  const [filterSource,    setFilterSource]    = useState<'all' | BookingSource>('all')
  const [searchQuery,     setSearchQuery]     = useState('')
  const [showPast,        setShowPast]        = useState(false)
  const [localBookings,   setLocalBookings]   = useState(initialBookings)
  const [justAdded,       setJustAdded]       = useState(false)
  const [calendarPrefill, setCalendarPrefill] = useState<{ propertyId: string; checkinDate: string } | null>(null)

  useEffect(() => {
    setLocalBookings(initialBookings)
  }, [initialBookings])

  useEffect(() => {
    if (!justAdded) return
    const t = setTimeout(() => setJustAdded(false), 4000)
    return () => clearTimeout(t)
  }, [justAdded])

  const todayStr = new Date().toISOString().split('T')[0]!

  const filtered = useMemo(() => {
    return localBookings.filter((b) => {
      if (!showPast && b.checkout_date < todayStr) return false
      if (filterProperty !== 'all' && b.property_id !== filterProperty) return false
      if (filterStatus   === 'active' && b.status     === 'cancelled') return false
      if (filterStatus   !== 'all' && filterStatus !== 'active' && b.status !== filterStatus) return false
      if (filterSource   !== 'all' && b.source     !== filterSource)    return false
      if (searchQuery.trim() && !(b.guest_name ?? '').toLowerCase().includes(searchQuery.trim().toLowerCase())) return false
      return true
    })
  }, [localBookings, showPast, filterProperty, filterStatus, filterSource, searchQuery, todayStr])

  const checkinsToday  = localBookings.filter((b) => isToday(b.checkin_date)  && b.status === 'confirmed')
  const checkoutsToday = localBookings.filter((b) => isToday(b.checkout_date) && b.status === 'confirmed')
  const hasFilters     = filterProperty !== 'all' || filterStatus !== 'all' || filterSource !== 'all' || searchQuery.trim() !== ''

  function handleCancel(id: string) {
    setLocalBookings((prev) =>
      prev.map((b) => b.id === id ? { ...b, status: 'cancelled' as BookingStatus } : b)
    )
  }

  function handleSync() {
    startSync(async () => { await triggerSync() })
  }

  function handleExportCsv(filteredRows: BookingRow[]) {
    const rows = ['Guest,Property,Check-in,Check-out,Status,Source']
    for (const b of filteredRows) {
      const propertyName = b.properties?.name ?? ''
      rows.push(`"${b.guest_name ?? ''}","${propertyName}",${b.checkin_date},${b.checkout_date},${b.status},${b.source}`)
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `bookings-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleAddSuccess() {
    setJustAdded(true)
    setCalendarPrefill(null)
    router.refresh()
  }

  return {
    filtered,
    localBookings,
    justAdded,
    syncing,
    showAdd,        setShowAdd,
    viewMode,       setViewMode,
    filterProperty, setFilterProperty,
    filterStatus,   setFilterStatus,
    filterSource,   setFilterSource,
    searchQuery,    setSearchQuery,
    showPast,       setShowPast,
    calendarPrefill, setCalendarPrefill,
    checkinsToday,
    checkoutsToday,
    hasFilters,
    handleCancel,
    handleSync,
    handleExportCsv,
    handleAddSuccess,
  }
}
