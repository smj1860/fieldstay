"use client";

import { useState, useEffect, useRef } from "react";

const SCENARIOS = [
  {
    id: "five_star",
    label: "5★ Glowing Review",
    color: "#22c55e",
    dimColor: "#052e16",
    borderColor: "#166534",
    guest_name: "Christopher",
    property_name: "The Carriage House",
    rating: 5,
    review: "This is hands-down the best rental we have ever stayed in! The attention to detail is unmatched — from the luxury linens to the locally roasted coffee provided in the kitchen. Check-in was a breeze with the smart lock, and the host checked in on us via text to ensure we had everything we needed. 10/10, will absolutely book again next year!",
    internal_note: null,
    tone: ["warm", "personable", "confident", "gracious"],
    word_count: 163,
    flags: [],
    response: `Christopher, what a wonderful note to read — thank you for sharing this so thoughtfully. Hearing that The Carriage House felt like a genuine escape rather than just a place to stay means everything to us. We put real care into the details that most guests never have to think about, so knowing the locally roasted coffee and the linens made an impression tells us those choices are landing exactly as intended. The smart lock was something we introduced specifically to make arrivals feel effortless, and it's great to hear the transition into the space was seamless from the very first moment. Hospitality for us isn't just about the physical property — it's about how a guest feels throughout the entire stay, so our team reaching out to check in is simply part of how we operate. We would absolutely love to welcome you back next year. Until then, safe travels, and know that The Carriage House will be ready and waiting.`
  },
  {
    id: "three_star",
    label: "3★ Mixed Review",
    color: "#eab308",
    dimColor: "#1a1500",
    borderColor: "#854d0e",
    guest_name: "Robert",
    property_name: "The Pine Ridge Cabin",
    rating: 3,
    review: "An okay stay for a quick weekend trip. The furniture was pretty worn out and the bed was very squeaky. It's definitely smaller in person than it looks in the listing photos. The neighborhood is quiet, which was nice, but it's a solid 20-minute drive from any decent restaurants.",
    internal_note: null,
    tone: ["neutral", "constructive", "empathetic", "poised"],
    word_count: 172,
    flags: [],
    response: `Robert, thank you for taking the time to share your thoughts after your stay at The Pine Ridge Cabin. We're glad the peaceful surroundings contributed positively to your weekend — the quiet of Pine Ridge is something many guests specifically seek out, and we're pleased that landed well for you. Your feedback about the furniture and bed frame is genuinely appreciated and has been flagged for our property team to assess during our next scheduled maintenance visit. Comfort is non-negotiable, and we take that seriously. On the listing photos and sizing — that's a fair and constructive point. We're reviewing our photo presentation and property description to ensure future guests arrive with accurate expectations around both space and proximity to dining options. Transparency in how we represent Pine Ridge matters to us, and your perspective helps sharpen that. We hope the cabin still served its purpose for a restful getaway, and we'd welcome the chance to host you again under a more refined experience.`
  },
  {
    id: "two_star_note",
    label: "2★ + Internal Note",
    color: "#f97316",
    dimColor: "#1a0a00",
    borderColor: "#9a3412",
    guest_name: "David",
    property_name: "The Summit Retreat",
    rating: 2,
    review: "The location is fantastic, right in the heart of downtown. Unfortunately that's where the positives end. The Wi-Fi was practically non-existent — measured at less than 2 Mbps — which made working remotely impossible. The shower barely had any pressure and fluctuated between freezing and scalding.",
    internal_note: "WiFi upgraded to 500 Mbps fiber last month. Shower pressure and temperature resolved with a new mixing valve installation.",
    tone: ["accountable", "solution-forward", "professional", "empathetic"],
    word_count: 168,
    flags: [],
    response: `David, we genuinely appreciate you sharing this with such clarity — this kind of honest feedback is exactly what helps us hold The Summit Retreat to the standard it should be. We hear you completely on the connectivity. While we know that doesn't undo the frustration you experienced, we want you to know that the internet infrastructure has since been upgraded to a 500 Mbps fiber connection — a direct result of feedback like yours. Reliability for remote work was identified as a priority and we acted on it. The shower concerns have also been fully addressed with a new mixing valve installation, ensuring consistent pressure and temperature. The location continues to be one of the retreat's greatest strengths, and we want every aspect of the experience inside the property to match what's right outside the door. If you're ever in the area again, we'd be honored to show you the difference. Please reach out to us directly if we can do anything further.`
  },
  {
    id: "one_star",
    label: "1★ Critical Review",
    color: "#ef4444",
    dimColor: "#1a0000",
    borderColor: "#991b1b",
    guest_name: "Michael",
    property_name: "The Lakeview Cottage",
    rating: 1,
    review: "Absolute nightmare. We arrived at 9 PM after a 6-hour drive only to find the lockbox code didn't work. It took the host over an hour to respond. When we finally got inside, the place clearly hadn't been cleaned since the last guests. We didn't even stay the night — we booked a hotel. Waiting on a full refund.",
    internal_note: null,
    tone: ["empathetic", "de-escalating", "accountable", "professional"],
    word_count: 170,
    flags: ["billing"],
    flag_reason: "Guest explicitly states they are awaiting a full refund — active billing dispute flagged for private follow-up.",
    response: `Michael, we are deeply sorry for what happened during your arrival — there is no version of this experience that meets any reasonable standard of hospitality, and we want to acknowledge that without reservation. Arriving after a long drive to find an unresponsive lockbox, and then discovering a property that had not been properly turned over, is a serious failure on every level. Your frustration is entirely warranted, and we are grateful you took the time to document it clearly. The access issue, the condition of the property, and the delayed response — each represents a breakdown in our operational process that we are actively investigating and addressing. We understand you were forced to find alternative accommodations that evening, and we take full responsibility for that outcome. Please reach out to our team directly so we can ensure your concern is handled with the urgency it deserves. The Lakeview Cottage is held to a far higher standard than what you experienced, and we intend to make that standard visible.`
  }
];

function StarRow({ rating, color }: { rating: number; color: string }) {

  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[1,2,3,4,5].map(i => (
        <svg key={i} width="13" height="13" viewBox="0 0 24 24"
          fill={i <= rating ? color : "#1e3a5e"}>
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
      ))}
    </div>
  );
}

export default function RepuGuardSandbox() {
  const [selected, setSelected] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | thinking | typing | done
  const [displayed, setDisplayed] = useState("");
  const [showMeta, setShowMeta] = useState(false);
  const timerRef = useRef(null);
  const indexRef = useRef(0);

  function clearTimers() {
    if (timerRef.current) clearTimeout(timerRef.current);
  }

  function runScenario(scenario: typeof SCENARIOS) {
    clearTimers();
    setSelected(scenario);
    setPhase("thinking");
    setDisplayed("");
    setShowMeta(false);
    indexRef.current = 0;

    timerRef.current = setTimeout(() => {
      setPhase("typing");
      typeNext(scenario.response);
    }, 1800);
  }

  function typeNext(fullText) {
    const CHUNK = 4;
    const DELAY = 18;

    function tick() {
      indexRef.current += CHUNK;
      const next = fullText.slice(0, indexRef.current);
      setDisplayed(next);

      if (indexRef.current < fullText.length) {
        timerRef.current = setTimeout(tick, DELAY);
      } else {
        setDisplayed(fullText);
        setPhase("done");
        setTimeout(() => setShowMeta(true), 300);
      }
    }
    tick();
  }

  useEffect(() => () => clearTimers(), []);

  const scenario = selected;

  return (
    <div style={{
      background: "#070f1f",
      borderRadius: 20,
      border: "1px solid #0e2040",
      overflow: "hidden",
      fontFamily: "'DM Sans', system-ui, sans-serif",
      maxWidth: 860,
      margin: "0 auto",
      boxShadow: "0 24px 80px rgba(0,0,0,0.6)"
    }}>

      {/* Header bar */}
      <div style={{
        background: "#0a1628",
        borderBottom: "1px solid #0e2040",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            background: "linear-gradient(135deg, #FCD116, #EAB800)",
            borderRadius: 6,
            padding: "3px 9px",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.12em",
            color: "#070f1f"
          }}>REPUGUARD</div>
          <span style={{ color: "#2a4a6e", fontSize: 13 }}>Interactive Demo</span>
        </div>
        <span style={{ fontSize: 12, color: "#1e3a5e", fontStyle: "italic" }}>
          No account required · Select a scenario below
        </span>
      </div>

      {/* Scenario selector */}
      <div style={{
        padding: "20px 24px 0",
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8
      }}>
        {SCENARIOS.map(s => (
          <button
            key={s.id}
            onClick={() => runScenario(s)}
            style={{
              background: selected?.id === s.id ? s.dimColor : "#0a1628",
              border: `1px solid ${selected?.id === s.id ? s.borderColor : "#0e2040"}`,
              borderRadius: 10,
              padding: "10px 8px",
              cursor: "pointer",
              transition: "all 0.2s",
              textAlign: "center"
            }}
          >
            <div style={{
              fontSize: 12,
              fontWeight: 700,
              color: selected?.id === s.id ? s.color : "#3a5a7e",
              lineHeight: 1.3
            }}>{s.label}</div>
          </button>
        ))}
      </div>

      {/* Main demo area */}
      <div style={{ padding: 24 }}>
        {!scenario ? (
          <div style={{
            textAlign: "center",
            padding: "48px 24px",
            color: "#1e3a5e"
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>↑</div>
            <div style={{ fontSize: 14 }}>Choose a review scenario to see RepuGuard in action</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

            {/* Left — Guest Review */}
            <div>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.12em",
                color: "#1e3a5e", marginBottom: 10, textTransform: "uppercase"
              }}>Guest Review</div>

              <div style={{
                background: "#0a1628",
                border: `1px solid ${scenario.borderColor}40`,
                borderRadius: 12,
                padding: 16
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#c8d8e8", marginBottom: 3 }}>
                      {scenario.guest_name}
                    </div>
                    <div style={{ fontSize: 11, color: "#2a4a6e" }}>{scenario.property_name}</div>
                  </div>
                  <StarRow rating={scenario.rating} color={scenario.color} />
                </div>
                <p style={{
                  margin: 0, fontSize: 12.5, color: "#6a8aaa",
                  lineHeight: 1.65, fontStyle: "italic"
                }}>"{scenario.review}"</p>

                {scenario.internal_note && (
                  <div style={{
                    marginTop: 12,
                    background: "#061020",
                    border: "1px solid #1e3a6e",
                    borderRadius: 8,
                    padding: "10px 12px"
                  }}>
                    <div style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: "0.12em",
                      color: "#3a7abf", marginBottom: 5, textTransform: "uppercase"
                    }}>Internal Note (Staff Only)</div>
                    <p style={{ margin: 0, fontSize: 11.5, color: "#3a5a7e", lineHeight: 1.5 }}>
                      {scenario.internal_note}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right — Generated Response */}
            <div>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 10
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.12em",
                  color: "#1e3a5e", textTransform: "uppercase"
                }}>RepuGuard Response</div>

                {phase === "thinking" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{
                      width: 10, height: 10,
                      border: "2px solid #FCD116",
                      borderTopColor: "transparent",
                      borderRadius: "50%",
                      animation: "spin 0.7s linear infinite"
                    }} />
                    <span style={{ fontSize: 11, color: "#FCD116" }}>Analyzing review…</span>
                  </div>
                )}
                {phase === "typing" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{
                      width: 6, height: 14, background: "#FCD116",
                      borderRadius: 1,
                      animation: "blink 0.8s step-end infinite"
                    }} />
                    <span style={{ fontSize: 11, color: "#FCD116" }}>Generating…</span>
                  </div>
                )}
                {phase === "done" && (
                  <div style={{
                    background: "#052e16",
                    border: "1px solid #166534",
                    borderRadius: 20,
                    padding: "3px 10px",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#4ade80",
                    display: "flex", alignItems: "center", gap: 4
                  }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="3">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    Ready
                  </div>
                )}
              </div>

              <div style={{
                background: "#0a1628",
                border: "1px solid #0e2040",
                borderRadius: 12,
                padding: 16,
                minHeight: 200,
                position: "relative"
              }}>
                {phase === "thinking" && (
                  <div style={{ display: "flex", gap: 6, padding: "20px 0" }}>
                    {[0,1,2].map(i => (
                      <div key={i} style={{
                        width: 8, height: 8,
                        background: "#1e3a5e",
                        borderRadius: "50%",
                        animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`
                      }} />
                    ))}
                  </div>
                )}

                {(phase === "typing" || phase === "done") && (
                  <p style={{
                    margin: 0,
                    fontSize: 13,
                    color: "#c8d8e8",
                    lineHeight: 1.75,
                    whiteSpace: "pre-wrap"
                  }}>
                    {displayed}
                    {phase === "typing" && (
                      <span style={{
                        display: "inline-block",
                        width: 2,
                        height: 14,
                        background: "#FCD116",
                        marginLeft: 1,
                        verticalAlign: "text-bottom",
                        animation: "blink 0.8s step-end infinite"
                      }} />
                    )}
                  </p>
                )}

                {phase === "idle" && (
                  <div style={{ color: "#1e3a5e", fontSize: 13, fontStyle: "italic", padding: "20px 0" }}>
                    Response will appear here…
                  </div>
                )}
              </div>

              {/* Metadata */}
              {showMeta && (
                <div style={{
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  animation: "fadeIn 0.4s ease"
                }}>
                  {/* Flag banner */}
                  {scenario.flags.length > 0 && (
                    <div style={{
                      background: "#200000",
                      border: "1px solid #7f1d1d",
                      borderRadius: 8,
                      padding: "8px 12px",
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start"
                    }}>
                      <span style={{ fontSize: 13 }}>🚩</span>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: "#ef4444", letterSpacing: "0.1em", marginBottom: 2 }}>
                          FLAGGED — {scenario.flags.map(f => f.toUpperCase()).join(", ")}
                        </div>
                        <div style={{ fontSize: 11, color: "#9a3a3a", lineHeight: 1.4 }}>
                          {scenario.flag_reason}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Tone + word count row */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#1e3a5e", marginRight: 2 }}>Tone:</span>
                    {scenario.tone.map(t => (
                      <span key={t} style={{
                        background: "#0a1628",
                        border: "1px solid #0e2040",
                        borderRadius: 20,
                        padding: "2px 9px",
                        fontSize: 10,
                        color: "#4a7aaa",
                        fontWeight: 500
                      }}>{t}</span>
                    ))}
                    <div style={{ marginLeft: "auto" }}>
                      <span style={{
                        background: "#0a1628",
                        border: "1px solid #0e2040",
                        borderRadius: 20,
                        padding: "2px 10px",
                        fontSize: 10,
                        color: "#4ade80",
                        fontWeight: 700
                      }}>{scenario.word_count} words</span>
                    </div>
                  </div>

                  {/* Post CTA */}
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 4
                  }}>
                    <span style={{ fontSize: 11, color: "#1e3a5e", fontStyle: "italic" }}>
                      Review before posting — you're always in control
                    </span>
                    <div style={{
                      background: "#0a1628",
                      border: "1px solid #1e3a6e",
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#3a6aaa",
                      cursor: "default",
                      display: "flex",
                      alignItems: "center",
                      gap: 5
                    }}>
                      Post to OwnerRez →
                      <span style={{
                        background: "#061020",
                        borderRadius: 4,
                        padding: "1px 5px",
                        fontSize: 9,
                        color: "#1e3a5e"
                      }}>DEMO</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin   { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes blink  { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
