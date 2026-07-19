'use client'

import { useState }              from 'react'
import { Check }                  from 'lucide-react'
import { submitWorkOrderSignOff } from '@/app/actions/work-order-public'

const ORANGE       = '#FF6B00'
const ORANGE_DARK  = '#CC4A00'
const CHARCOAL     = '#1A1A1A'
const CHARCOAL_MID = '#242424'
const CHROME       = '#C0C0C0'
const CHROME_LIGHT = '#E0E0E0'

interface WorkOrderData {
  id:              string
  woNumber:        string
  status:          string
  title:           string
  description:     string | null
  nteAmount:       number | null
  lockboxCode:     string | null
  parkingNotes:    string | null
  accessNotes:     string | null
  propertyName:    string
  propertyAddress: string
  vendorName:      string | null
  dispatcherName:  string
  dispatcherOrg:   string
  dispatcherPhone: string | null
  alreadySigned:   boolean
  signedOffAt:     string | null
  signOffNotes:    string | null
}

interface Props {
  token:     string
  workOrder: WorkOrderData
}

const TreadplateBg = () => (
  <div style={{ position:'fixed', inset:0, zIndex:0, background:'#0E0E0E' }}>
    <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%' }}>
      <defs>
        <linearGradient id="lozG" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#2E2E2E"/>
          <stop offset="45%"  stopColor="#1A1A1A"/>
          <stop offset="100%" stopColor="#0C0C0C"/>
        </linearGradient>
        <pattern id="tpPub" x="0" y="0" width="34" height="20" patternUnits="userSpaceOnUse">
          <rect width="34" height="20" fill="#0E0E0E"/>
          <path d="M17,1.5 L31,10 L17,18.5 L3,10 Z" fill="url(#lozG)"/>
          <path d="M3,10 L17,1.5 L17,3.2 L4.5,10 Z"   fill="#5A5A5A" opacity="0.9"/>
          <path d="M17,1.5 L31,10 L29.5,10 L17,3.2 Z" fill="#3A3A3A" opacity="0.9"/>
          <path d="M31,10 L17,18.5 L17,16.8 L29.5,10 Z" fill="#060606"/>
          <path d="M17,18.5 L3,10 L4.5,10 L17,16.8 Z"   fill="#080808"/>
        </pattern>
        <radialGradient id="vigPub" cx="50%" cy="50%" r="68%" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="transparent"/>
          <stop offset="100%" stopColor="rgba(0,0,0,0.6)"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="#0E0E0E"/>
      <rect width="100%" height="100%" fill="url(#tpPub)"/>
      <rect width="100%" height="100%" fill="url(#tpPub)" transform="translate(17,10)"/>
      <rect width="100%" height="100%" fill="url(#vigPub)"/>
    </svg>
  </div>
)

const PanelPlate = () => (
  <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                opacity:0.1, pointerEvents:'none' }}>
    <defs>
      <linearGradient id="lozPP" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stopColor={CHROME_LIGHT}/>
        <stop offset="100%" stopColor={CHROME}/>
      </linearGradient>
      <pattern id="tpPP" x="0" y="0" width="24" height="14" patternUnits="userSpaceOnUse">
        <path d="M12,1 L21,7 L12,13 L3,7 Z" fill="url(#lozPP)"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#tpPP)"/>
    <rect width="100%" height="100%" fill="url(#tpPP)" transform="translate(12,7)"/>
  </svg>
)

function Lbl({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div style={{ color:'#7A7A7A', fontSize:10, fontWeight:700,
                  letterSpacing:'0.14em', textTransform:'uppercase', marginBottom:10 }}>
      {children}
    </div>
  )
}

function Icon({ d, color = '#6B7280', size = 16 }: Readonly<{ d: string; color?: string; size?: number }>) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24"
         stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
         style={{ flexShrink:0 }}>
      <path d={d}/>
    </svg>
  )
}

export function WorkOrderPublicClient({ token, workOrder: wo }: Props) {
  const [signed,     setSigned]     = useState(wo.alreadySigned)
  const [notes,      setNotes]      = useState('')
  const [photos,     setPhotos]     = useState<File[]>([])
  const [actualCost, setActualCost] = useState('')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const nteFormatted = wo.nteAmount
    ? new Intl.NumberFormat('en-US', { style:'currency', currency:'USD',
                                       minimumFractionDigits:0 }).format(wo.nteAmount)
    : null

  const signedAtFormatted = wo.signedOffAt
    ? new Date(wo.signedOffAt).toLocaleString('en-US', {
        month:'short', day:'numeric', year:'numeric',
        hour:'numeric', minute:'2-digit'
      })
    : null

  async function handleSignOff() {
    setLoading(true)
    setError(null)
    const cost = actualCost.trim() ? parseFloat(actualCost) : undefined
    const result = await submitWorkOrderSignOff(token, notes, photos.length > 0 ? photos : undefined, cost)
    setLoading(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setSigned(true)
  }

  const accessItems = [
    wo.lockboxCode  ? { label:'Lockbox code', value:wo.lockboxCode, mono:true, accent:true,
                        d:'M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z' } : null,
    wo.parkingNotes ? { label:'Parking', value:wo.parkingNotes, mono:false, accent:false,
                        d:'M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12' } : null,
    wo.accessNotes  ? { label:'Site notes', value:wo.accessNotes, mono:false, accent:false,
                        d:'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z' } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null)

  return (
    <>
      <TreadplateBg/>
      <div style={{ position:'relative', zIndex:1, minHeight:'100vh',
                    display:'flex', alignItems:'flex-start', justifyContent:'center',
                    paddingTop:40, paddingBottom:40, paddingLeft:16, paddingRight:16 }}>

        <div style={{
          width:'100%', maxWidth:390,
          borderRadius:24, overflow:'hidden', background:'#fff',
          boxShadow:`0 0 0 1.5px ${CHROME}, 0 0 0 3px rgba(0,0,0,0.5), 0 48px 120px rgba(0,0,0,0.9)`
        }}>

          {/* ── HEADER ── */}
          <div style={{ background:CHARCOAL, position:'relative', overflow:'hidden',
                        padding:'24px 20px 20px' }}>
            <PanelPlate/>
            <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                          background:`linear-gradient(90deg, transparent, ${CHROME}, transparent)`,
                          opacity:0.5 }}/>
            <div style={{ position:'relative' }}>
              <div style={{ display:'flex', alignItems:'center',
                            justifyContent:'space-between', marginBottom:18 }}>
                <div>
                  <div style={{ color:CHROME_LIGHT, fontWeight:900, fontSize:14,
                                letterSpacing:'0.07em', lineHeight:1.1 }}>TRADESUITE</div>
                  <div style={{ color:ORANGE, fontWeight:900, fontSize:11,
                                letterSpacing:'0.22em' }}>PRO</div>
                </div>
                <div style={{
                  background: signed ? 'rgba(16,185,129,0.15)' : 'rgba(255,107,0,0.15)',
                  color:      signed ? '#34D399' : ORANGE,
                  border:     `1px solid ${signed ? 'rgba(52,211,153,0.3)' : 'rgba(255,107,0,0.4)'}`,
                  fontSize:11, fontWeight:700, padding:'5px 12px', borderRadius:99,
                  display:'inline-flex', alignItems:'center', gap:4
                }}>
                  {signed ? <><Check size={11} /> Complete</> : '● Active'}
                </div>
              </div>
              <div style={{ color:CHROME, fontSize:10, fontWeight:700,
                            letterSpacing:'0.18em', textTransform:'uppercase', marginBottom:3 }}>
                Work Order
              </div>
              <div style={{ color:'#F8F8F8', fontWeight:900, fontSize:22,
                            letterSpacing:'-0.025em' }}>
                {wo.woNumber}
              </div>
            </div>
          </div>

          {/* ── PROPERTY ── */}
          <div style={{ background:CHARCOAL_MID, position:'relative', overflow:'hidden',
                        padding:'16px 20px' }}>
            <PanelPlate/>
            <div style={{ position:'relative' }}>
              <div style={{ color:CHROME, fontSize:10, fontWeight:700,
                            letterSpacing:'0.18em', textTransform:'uppercase', marginBottom:8 }}>
                Property
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <div style={{ width:3, borderRadius:99, background:ORANGE,
                              alignSelf:'stretch', flexShrink:0, minHeight:52 }}/>
                <div>
                  <div style={{ color:'#F0F0F0', fontWeight:800, fontSize:17, lineHeight:1.2 }}>
                    {wo.propertyName}
                  </div>
                  <div style={{ color:'#B0B0B0', fontSize:13, marginTop:3 }}>
                    {wo.propertyAddress}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── AUTHORIZATION ── */}
          {nteFormatted && (
            <div style={{ padding:'16px 20px', borderBottom:'1px solid #EBEBEB' }}>
              <div style={{
                background:'linear-gradient(135deg,#FFF4EE 0%,#FFE8D6 100%)',
                border:`2px solid ${ORANGE}`, borderRadius:16, padding:'18px 20px',
                position:'relative', overflow:'hidden'
              }}>
                <div style={{
                  position:'absolute', right:-20, top:-20, width:110, height:110,
                  background:`radial-gradient(circle, rgba(255,107,0,0.25) 0%, transparent 70%)`
                }}/>
                <div style={{ color:ORANGE_DARK, fontSize:10, fontWeight:800,
                              letterSpacing:'0.16em', textTransform:'uppercase', marginBottom:2 }}>
                  Authorized up to
                </div>
                <div style={{ color:ORANGE, fontWeight:900, fontSize:56,
                              letterSpacing:'-0.04em', lineHeight:1 }}>
                  {nteFormatted}
                </div>
                <div style={{ display:'flex', alignItems:'flex-start', gap:6, marginTop:10 }}>
                  <Icon size={14} color={ORANGE_DARK}
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                  <p style={{ color:ORANGE_DARK, fontSize:11.5, lineHeight:1.5, margin:0 }}>
                    Work exceeding this amount requires PM approval before proceeding.
                    Contact {wo.dispatcherName} before starting any additional scope.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── SCOPE ── */}
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #EBEBEB' }}>
            <Lbl>Scope of Work</Lbl>
            <div style={{ display:'flex', gap:10 }}>
              <Icon color={ORANGE}
                d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/>
              <div>
                <div style={{ color:'#111', fontSize:14, fontWeight:700, marginBottom:4 }}>
                  {wo.title}
                </div>
                {wo.description && (
                  <p style={{ color:'#444', fontSize:13.5, lineHeight:1.65, margin:0 }}>
                    {wo.description}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── ACCESS ── */}
          {accessItems.length > 0 && (
            <div style={{ padding:'16px 20px', borderBottom:'1px solid #EBEBEB' }}>
              <Lbl>Property Access</Lbl>
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                {accessItems.map(item => (
                  <div key={item.label} style={{ display:'flex', alignItems:'flex-start', gap:11 }}>
                    <div style={{
                      width:34, height:34, borderRadius:10, flexShrink:0, marginTop:1,
                      background: item.accent ? '#FFF0E6' : '#F5F5F5',
                      border: `1.5px solid ${item.accent ? '#FFCCA0' : '#E5E5E5'}`,
                      display:'flex', alignItems:'center', justifyContent:'center'
                    }}>
                      <Icon d={item.d} color={item.accent ? ORANGE : '#777'}/>
                    </div>
                    <div>
                      <div style={{ color:'#999', fontSize:10, fontWeight:600,
                                    letterSpacing:'0.07em', textTransform:'uppercase' }}>
                        {item.label}
                      </div>
                      <div style={{
                        color:'#111', lineHeight:1.5,
                        fontSize:     item.mono ? 17 : 13,
                        fontWeight:   item.mono ? 900 : 400,
                        letterSpacing:item.mono ? '0.22em' : '0',
                        fontFamily:   item.mono ? 'monospace' : 'inherit'
                      }}>
                        {item.value}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── DISPATCHED BY ── */}
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #EBEBEB' }}>
            <Lbl>Dispatched By</Lbl>
            <div style={{ display:'flex', alignItems:'center', gap:11 }}>
              <div style={{ width:40, height:40, borderRadius:99, background:CHARCOAL,
                            display:'flex', alignItems:'center', justifyContent:'center',
                            flexShrink:0, border:`1.5px solid ${CHROME}` }}>
                <span style={{ color:CHROME_LIGHT, fontWeight:800, fontSize:14 }}>
                  {wo.dispatcherName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                </span>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ color:'#111', fontSize:14, fontWeight:700 }}>
                  {wo.dispatcherName}
                </div>
                <div style={{ color:'#777', fontSize:11, marginTop:1 }}>
                  {wo.dispatcherOrg}
                </div>
              </div>
              {wo.dispatcherPhone && (
                <a href={`tel:${wo.dispatcherPhone.replace(/\D/g,'')}`}
                   style={{ width:38, height:38, borderRadius:99, background:'#F0FDF4',
                            border:'1px solid #BBF7D0', display:'flex',
                            alignItems:'center', justifyContent:'center',
                            flexShrink:0, textDecoration:'none' }}>
                  <Icon color="#16A34A"
                    d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/>
                </a>
              )}
            </div>
          </div>

          {/* ── SIGN-OFF ── */}
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #EBEBEB' }}>
            <Lbl>Contractor Sign-Off</Lbl>

            {!signed ? (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Add job notes, parts used, or anything the PM should know..."
                  rows={3}
                  style={{
                    width:'100%', fontSize:13, color:'#1A1A1A',
                    border:'1.5px solid #E0E0E0', borderRadius:12,
                    padding:'10px 12px', background:'#F7F7F7',
                    outline:'none', resize:'none', boxSizing:'border-box',
                    fontFamily:'inherit', lineHeight:1.5, transition:'all 0.15s'
                  }}
                  onFocus={e => {
                    e.target.style.borderColor = ORANGE
                    e.target.style.boxShadow   = `0 0 0 3px rgba(255,107,0,0.1)`
                  }}
                  onBlur={e => {
                    e.target.style.borderColor = '#E0E0E0'
                    e.target.style.boxShadow   = 'none'
                  }}
                />
                <div>
                  <label
                    htmlFor="signoff-cost"
                    style={{
                      display:'block', fontSize:11, fontWeight:700,
                      color:'#7A7A7A', letterSpacing:'0.14em',
                      textTransform:'uppercase', marginBottom:6,
                    }}
                  >
                    Total cost (optional)
                  </label>
                  <div style={{ position:'relative' }}>
                    <span style={{
                      position:'absolute', left:12, top:'50%', transform:'translateY(-50%)',
                      color:'#ABABAB', fontSize:13, pointerEvents:'none',
                    }}>
                      $
                    </span>
                    <input
                      id="signoff-cost"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={actualCost}
                      onChange={e => setActualCost(e.target.value)}
                      placeholder="0.00"
                      style={{
                        width:'100%', fontSize:13, color:'#1A1A1A',
                        border:'1.5px solid #E0E0E0', borderRadius:12,
                        padding:'10px 12px 10px 26px', background:'#F7F7F7',
                        outline:'none', boxSizing:'border-box',
                        fontFamily:'inherit', transition:'all 0.15s'
                      }}
                      onFocus={e => {
                        e.target.style.borderColor = ORANGE
                        e.target.style.boxShadow   = `0 0 0 3px rgba(255,107,0,0.1)`
                      }}
                      onBlur={e => {
                        e.target.style.borderColor = '#E0E0E0'
                        e.target.style.boxShadow   = 'none'
                      }}
                    />
                  </div>
                  <p style={{ color:'#AAA', fontSize:11, margin:'4px 0 0' }}>
                    Include labor and materials if you have the total handy — saves a follow-up call.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="signoff-photos"
                    style={{
                      display:'block', fontSize:11, fontWeight:700,
                      color:'#7A7A7A', letterSpacing:'0.14em',
                      textTransform:'uppercase', marginBottom:6,
                    }}
                  >
                    Photos (optional, up to 5)
                  </label>
                  <input
                    id="signoff-photos"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic"
                    multiple
                    onChange={e => {
                      const files = Array.from(e.target.files ?? []).slice(0, 5)
                      setPhotos(files)
                    }}
                    style={{
                      width:'100%', fontSize:12, color:'#C0C0C0',
                      border:'1.5px solid #E0E0E0', borderRadius:10,
                      padding:'8px 12px', background:'#F7F7F7',
                      boxSizing:'border-box', cursor:'pointer',
                    }}
                  />
                  {photos.length > 0 && (
                    <p style={{ margin:'4px 0 0', fontSize:11, color:'#7A7A7A' }}>
                      {photos.length} photo{photos.length !== 1 ? 's' : ''} selected
                    </p>
                  )}
                </div>
                {error && (
                  <p style={{ color:'#EF4444', fontSize:12, margin:0, textAlign:'center' }}>
                    {error}
                  </p>
                )}
                <button
                  onClick={handleSignOff}
                  disabled={loading}
                  style={{
                    width:'100%', padding:'15px 0', background:CHARCOAL,
                    color:'#F0F0F0', fontWeight:800, fontSize:14,
                    borderRadius:14, border:`2px solid ${loading ? '#444' : ORANGE}`,
                    cursor: loading ? 'default' : 'pointer',
                    display:'flex', alignItems:'center',
                    justifyContent:'center', gap:8,
                    opacity: loading ? 0.8 : 1, transition:'all 0.15s'
                  }}
                >
                  {loading ? (
                    <>
                      <div style={{
                        width:16, height:16, borderRadius:99,
                        border:`2.5px solid rgba(255,255,255,0.15)`,
                        borderTopColor:ORANGE,
                        animation:'spin 0.7s linear infinite'
                      }}/>
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Icon color="#fff" d="M4.5 12.75l6 6 9-13.5"/>
                      Sign Off & Submit
                    </>
                  )}
                </button>
                <p style={{ color:'#AAA', fontSize:11, textAlign:'center', margin:0 }}>
                  By signing off you confirm this work is complete
                </p>
              </div>
            ) : (
              <div style={{ background:'#F0FDF4', border:'1.5px solid #BBF7D0',
                            borderRadius:14, padding:18, textAlign:'center' }}>
                <div style={{ width:46, height:46, borderRadius:99, background:'#16A34A',
                              display:'flex', alignItems:'center', justifyContent:'center',
                              margin:'0 auto 10px' }}>
                  <Icon color="#fff" d="M4.5 12.75l6 6 9-13.5" size={20}/>
                </div>
                <div style={{ color:'#14532D', fontWeight:800, fontSize:15 }}>
                  Work Order Complete
                </div>
                {signedAtFormatted && (
                  <div style={{ color:'#16A34A', fontSize:11, marginTop:3 }}>
                    Signed off {signedAtFormatted}
                  </div>
                )}
                {(wo.signOffNotes || notes) && (
                  <div style={{ marginTop:12, textAlign:'left',
                                background:'rgba(255,255,255,0.7)',
                                borderRadius:10, padding:'10px 12px' }}>
                    <div style={{ color:'#166534', fontSize:10, fontWeight:700,
                                  letterSpacing:'0.08em', textTransform:'uppercase',
                                  marginBottom:4 }}>Notes submitted</div>
                    <div style={{ color:'#1F2937', fontSize:12.5, lineHeight:1.5 }}>
                      {wo.signOffNotes ?? notes}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── FOOTER ── */}
          <div style={{ background:CHARCOAL, padding:'20px 20px 26px',
                        textAlign:'center', position:'relative', overflow:'hidden' }}>
            <PanelPlate/>
            <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                          background:`linear-gradient(90deg, transparent, ${CHROME}, transparent)`,
                          opacity:0.45 }}/>
            <div style={{ position:'relative' }}>
              <div style={{ color:CHROME_LIGHT, fontWeight:900, fontSize:14,
                            letterSpacing:'0.06em', marginBottom:4 }}>
                TRADESUITE <span style={{ color:ORANGE }}>PRO</span>
              </div>
              <p style={{ color:'#555', fontSize:11, margin:'0 0 8px', lineHeight:1.5 }}>
                Professional work orders & invoicing for skilled trades
              </p>
              <a href="https://tradesuite.com"
                 style={{ color:ORANGE, fontSize:12, fontWeight:700, textDecoration:'none',
                          borderBottom:`1px solid rgba(255,107,0,0.35)`, paddingBottom:1 }}>
                Get TradeSuite Pro for your business →
              </a>
            </div>
          </div>

        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform:rotate(360deg); } }
        textarea::placeholder { color:#ABABAB; }
      `}</style>
    </>
  )
}
