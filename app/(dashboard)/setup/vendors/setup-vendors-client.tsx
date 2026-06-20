'use client'

import { useState, useActionState } from 'react'
import { Plus, Check } from 'lucide-react'
import { addVendor, type SettingsActionState } from '@/app/(dashboard)/settings/actions'

const VENDOR_SPECIALTIES = [
  { value: 'plumbing',     label: 'Plumbing'     },
  { value: 'electrical',   label: 'Electrical'   },
  { value: 'hvac',         label: 'HVAC'         },
  { value: 'landscaping',  label: 'Landscaping'  },
  { value: 'cleaning',     label: 'Cleaning'     },
  { value: 'pest_control', label: 'Pest Control' },
  { value: 'pool',         label: 'Pool'         },
  { value: 'roofing',      label: 'Roofing'      },
  { value: 'general',      label: 'General'      },
  { value: 'other',        label: 'Other'        },
]

interface Vendor { id: string; name: string; specialty: string; contact_name: string | null }
interface Props  { vendors: Vendor[]; continueAction: () => Promise<void> }

export function SetupVendorsStep({ vendors: initialVendors, continueAction }: Props) {
  const [vendors, setVendors] = useState(initialVendors)
  const [view, setView]       = useState<'list' | 'add'>('list')
  const [savedName, setSavedName] = useState<string | null>(null)
  const [state, formAction, pending] = useActionState(
    async (prev: SettingsActionState | null, fd: FormData) => {
      const res = await addVendor(prev, fd)
      if (res.success) {
        if (res.vendor) {
          setVendors((prev) => [...prev, res.vendor!])
        }
        setView('list')
        setSavedName((fd.get('name') as string)?.trim() || 'Vendor')
        setTimeout(() => setSavedName(null), 4000)
      }
      return res
    },
    null
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Add Your Vendors
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Add service vendors and contractors for maintenance and specialized work.
          These vendors are available across your whole portfolio — you'll assign
          them to maintenance work orders for specific properties as needed.
        </p>
      </div>

      {savedName && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}>
          <Check className="w-4 h-4 flex-shrink-0" />
          {savedName} saved successfully
        </div>
      )}

      {vendors.length > 0 && (
        <div className="border border-themed rounded-xl overflow-hidden">
          {vendors.map((v) => (
            <div key={v.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                   style={{ background: 'var(--accent-blue-dim)', color: 'var(--accent-blue)' }}>
                {v.name[0]?.toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-medium text-primary-themed">{v.name}</div>
                <div className="text-xs text-muted-themed capitalize">
                  {v.specialty.replace(/_/g, ' ')}{v.contact_name ? ` · ${v.contact_name}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'add' ? (
        <div className="p-4 rounded-xl border border-themed" style={{ background: 'var(--bg-canvas)' }}>
          <p className="text-sm font-semibold text-secondary-themed mb-3">New Vendor</p>
          {state?.error && (
            <div className="text-sm rounded-lg px-3 py-2 mb-3"
                 style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
              {state.error}
            </div>
          )}
          <form action={formAction} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className="label">Vendor Name *</label>
                <input name="name" type="text" required className="input" placeholder="ABC Plumbing" /></div>
              <div><label className="label">Contact Name</label>
                <input name="contact_name" type="text" className="input" placeholder="John Smith" /></div>
              <div><label className="label">Email</label>
                <input name="email" type="email" className="input" placeholder="info@abcplumbing.com" /></div>
              <div><label className="label">Phone</label>
                <input name="phone" type="tel" className="input" placeholder="+1 555-0100" /></div>
              <div><label className="label">Specialty</label>
                <select name="specialty" className="input" defaultValue="general">
                  {VENDOR_SPECIALTIES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select></div>
              <div><label className="label">Service ZIP</label>
                <input name="service_zip" type="text" className="input" placeholder="30301" maxLength={10} /></div>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Adding…' : 'Add Vendor'}
              </button>
              <button type="button" onClick={() => setView('list')} className="btn-ghost text-sm">
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="space-y-2">
          <button onClick={() => setView('add')} className="btn-secondary text-sm flex items-center gap-2 w-full justify-center">
            <Plus className="w-4 h-4" />
            {vendors.length === 0 ? 'Add First Vendor' : 'Add Another'}
          </button>
          {vendors.length === 0 && (
            <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              Tip: The <a href="/vendors" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-gold)' }}>Vendors section</a> supports bulk CSV import.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-themed">
        <form action={continueAction}>
          <button type="submit" className="btn-primary">
            {vendors.length > 0 ? 'Continue →' : 'Skip for now →'}
          </button>
        </form>
      </div>
    </div>
  )
}
