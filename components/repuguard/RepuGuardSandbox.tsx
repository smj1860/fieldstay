"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import { useTypewriter } from "@/lib/hooks/use-typewriter";
import { SCENARIOS, type Scenario } from "./scenarios";

function StarRow({ rating, color }: Readonly<{ rating: number; color: string }>) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill={i <= rating ? color : "var(--rg-text-dim)"}
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}

export default function RepuGuardSandbox() {
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [showMeta, setShowMeta] = useState(false);
  const { phase, displayed, start } = useTypewriter();

  function runScenario(scenario: Scenario) {
    setSelected(scenario);
    setShowMeta(false);
    start(scenario.response, () => setTimeout(() => setShowMeta(true), 300));
  }

  const scenario = selected;

  return (
    <div
      className="repuguard-sandbox"
      style={{
        background: "var(--rg-bg)",
        borderRadius: 20,
        border: "1px solid var(--rg-border)",
        overflow: "hidden",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        maxWidth: 860,
        margin: "0 auto",
        boxShadow: "var(--rg-shadow)",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          background: "var(--rg-panel-bg)",
          borderBottom: "1px solid var(--rg-border)",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              background: "linear-gradient(135deg, var(--chrome-gold), var(--rg-gold-dark))",
              borderRadius: 6,
              padding: "3px 9px",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.12em",
              color: "var(--rg-bg)",
            }}
          >
            REPUGUARD
          </div>
          <span style={{ color: "var(--rg-text-subtle)", fontSize: 13 }}>
            Interactive Demo
          </span>
        </div>
        <span
          style={{ fontSize: 12, color: "var(--rg-text-dim)", fontStyle: "italic" }}
        >
          No account required · Select a scenario below
        </span>
      </div>

      {/* Scenario selector */}
      <div
        style={{
          padding: "20px 24px 0",
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
        }}
      >
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => runScenario(s)}
            style={{
              background:
                selected?.id === s.id ? s.dimColor : "var(--rg-panel-bg)",
              border: `1px solid ${
                selected?.id === s.id ? s.borderColor : "var(--rg-border)"
              }`,
              borderRadius: 10,
              padding: "10px 8px",
              cursor: "pointer",
              transition: "all 0.2s",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color:
                  selected?.id === s.id ? s.color : "var(--rg-text-label)",
                lineHeight: 1.3,
              }}
            >
              {s.label}
            </div>
          </button>
        ))}
      </div>

      {/* Main demo area */}
      <div style={{ padding: 24 }}>
        {!scenario ? (
          <div
            style={{
              textAlign: "center",
              padding: "48px 24px",
              color: "var(--rg-text-dim)",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>↑</div>
            <div style={{ fontSize: 14 }}>
              Choose a review scenario to see RepuGuard in action
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            {/* Left — Guest Review */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  color: "var(--rg-text-dim)",
                  marginBottom: 10,
                  textTransform: "uppercase",
                }}
              >
                Guest Review
              </div>

              <div
                style={{
                  background: "var(--rg-panel-bg)",
                  border: `1px solid ${scenario.borderColor}40`,
                  borderRadius: 12,
                  padding: 16,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        color: "var(--rg-text-strong)",
                        marginBottom: 3,
                      }}
                    >
                      {scenario.guest_name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--rg-text-subtle)" }}>
                      {scenario.property_name}
                    </div>
                  </div>
                  <StarRow rating={scenario.rating} color={scenario.color} />
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    color: "var(--rg-text-body)",
                    lineHeight: 1.65,
                    fontStyle: "italic",
                  }}
                >
                  &ldquo;{scenario.review}&rdquo;
                </p>

                {scenario.internal_note && (
                  <div
                    style={{
                      marginTop: 12,
                      background: "var(--rg-note-bg)",
                      border: "1px solid var(--rg-note-border)",
                      borderRadius: 6,
                      padding: "8px 12px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: "0.12em",
                        color: "var(--rg-note-label)",
                        marginBottom: 4,
                        textTransform: "uppercase",
                      }}
                    >
                      Internal Note (Staff Only)
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: 11.5,
                        color: "var(--rg-text-label)",
                        lineHeight: 1.5,
                      }}
                    >
                      {scenario.internal_note}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right — Generated Response */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.12em",
                    color: "var(--rg-text-dim)",
                    textTransform: "uppercase",
                  }}
                >
                  RepuGuard Response
                </div>

                {phase === "thinking" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        border: "2px solid var(--chrome-gold)",
                        borderTopColor: "transparent",
                        borderRadius: "50%",
                        animation: "rg-spin 0.7s linear infinite",
                      }}
                    />
                    <span style={{ fontSize: 11, color: "var(--chrome-gold)" }}>
                      Analyzing review…
                    </span>
                  </div>
                )}
                {phase === "typing" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "var(--chrome-gold)" }}>
                      Generating…
                    </span>
                  </div>
                )}
                {phase === "done" && (
                  <div
                    style={{
                      background: "var(--rg-success-bg)",
                      border: "1px solid var(--rg-success-border)",
                      borderRadius: 20,
                      padding: "3px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--rg-success-text)",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Ready
                  </div>
                )}
              </div>

              <div
                style={{
                  background: "var(--rg-panel-bg)",
                  border: "1px solid var(--rg-border)",
                  borderRadius: 12,
                  padding: 16,
                  minHeight: 200,
                }}
              >
                {phase === "thinking" && (
                  <div
                    style={{ display: "flex", gap: 6, padding: "20px 0" }}
                  >
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        style={{
                          width: 8,
                          height: 8,
                          background: "var(--rg-text-dim)",
                          borderRadius: "50%",
                          animation: `rg-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                        }}
                      />
                    ))}
                  </div>
                )}

                {(phase === "typing" || phase === "done") && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      color: "var(--rg-text-strong)",
                      lineHeight: 1.75,
                    }}
                  >
                    {displayed}
                    {phase === "typing" && (
                      <span
                        style={{
                          display: "inline-block",
                          width: 2,
                          height: 14,
                          background: "var(--chrome-gold)",
                          marginLeft: 1,
                          verticalAlign: "text-bottom",
                          animation: "rg-blink 0.8s step-end infinite",
                        }}
                      />
                    )}
                  </p>
                )}

                {phase === "idle" && (
                  <div
                    style={{
                      color: "var(--rg-text-dim)",
                      fontSize: 13,
                      fontStyle: "italic",
                      padding: "20px 0",
                    }}
                  >
                    Response will appear here…
                  </div>
                )}
              </div>

              {/* Metadata */}
              {showMeta && (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {scenario.flags.length > 0 && (
                    <div
                      style={{
                        background: "var(--rg-flag-bg)",
                        border: "1px solid var(--rg-flag-border)",
                        borderRadius: 8,
                        padding: "8px 12px",
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                      }}
                    >
                      <Flag style={{ width: 13, height: 13, color: "var(--rg-flag-text)", flexShrink: 0 }} />
                      <div>
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 800,
                            color: "var(--rg-flag-text)",
                            letterSpacing: "0.1em",
                            marginBottom: 2,
                          }}
                        >
                          FLAGGED —{" "}
                          {scenario.flags
                            .map((f) => f.toUpperCase())
                            .join(", ")}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--rg-flag-reason)",
                            lineHeight: 1.4,
                          }}
                        >
                          {scenario.flag_reason}
                        </div>
                      </div>
                    </div>
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--rg-text-dim)",
                        marginRight: 2,
                      }}
                    >
                      Tone:
                    </span>
                    {scenario.tone.map((t) => (
                      <span
                        key={t}
                        style={{
                          background: "var(--rg-panel-bg)",
                          border: "1px solid var(--rg-border)",
                          borderRadius: 20,
                          padding: "2px 9px",
                          fontSize: 10,
                          color: "var(--rg-tone-text)",
                          fontWeight: 500,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                    <div style={{ marginLeft: "auto" }}>
                      <span
                        style={{
                          background: "var(--rg-panel-bg)",
                          border: "1px solid var(--rg-border)",
                          borderRadius: 20,
                          padding: "2px 10px",
                          fontSize: 10,
                          color: "var(--rg-success-text)",
                          fontWeight: 700,
                        }}
                      >
                        {scenario.word_count} words
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginTop: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--rg-text-dim)",
                        fontStyle: "italic",
                      }}
                    >
                      Review before posting — you&apos;re always in control
                    </span>
                    <div
                      style={{
                        background: "var(--rg-panel-bg)",
                        border: "1px solid var(--rg-note-border)",
                        borderRadius: 8,
                        padding: "6px 14px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--rg-cta-text)",
                        cursor: "default",
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      Post to OwnerRez →
                      <span
                        style={{
                          background: "var(--rg-cta-demo-bg)",
                          borderRadius: 4,
                          padding: "1px 5px",
                          fontSize: 9,
                          color: "var(--rg-text-dim)",
                        }}
                      >
                        DEMO
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .repuguard-sandbox {
          --rg-bg:             #070f1f;
          --rg-panel-bg:       #0a1628;
          --rg-border:         #0e2040;
          --rg-gold-dark:      #EAB800;
          --rg-text-subtle:    #2a4a6e;
          --rg-text-dim:       #1e3a5e;
          --rg-text-label:     #3a5a7e;
          --rg-text-strong:    #c8d8e8;
          --rg-text-body:      #6a8aaa;
          --rg-note-bg:        #061428;
          --rg-note-border:    #1e3a6e;
          --rg-note-label:     #3a7abf;
          --rg-success-bg:     #0a2a1a;
          --rg-success-border: #16a34a;
          --rg-success-text:   #4ade80;
          --rg-flag-bg:        #200000;
          --rg-flag-border:    #7f1d1d;
          --rg-flag-text:      #ef4444;
          --rg-flag-reason:    #9a3a3a;
          --rg-tone-text:      #4a7aaa;
          --rg-cta-text:       #3a6aaa;
          --rg-cta-demo-bg:    #061020;
          --rg-shadow:         0 24px 80px rgba(0,0,0,0.6);
        }
        @keyframes rg-spin   { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes rg-blink  { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes rg-bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
      `}</style>
    </div>
  );
}
