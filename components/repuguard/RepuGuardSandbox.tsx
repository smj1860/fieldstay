"use client";

import { useState, useEffect, useRef } from "react";

interface Scenario {
  id: string;
  label: string;
  color: string;
  dimColor: string;
  borderColor: string;
  guest_name: string;
  property_name: string;
  rating: number;
  review: string;
  internal_note: string | null;
  tone: string[];
  word_count: number;
  flags: string[];
  flag_reason?: string;
  response: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "five_star",
    label: "5★ Glowing Review",
    color: "#22c55e",
    dimColor: "#052e16",
    borderColor: "#166534",
    guest_name: "Christopher",
    property_name: "The Carriage House",
    rating: 5,
    review: "This is hands-down the best rental we have ever stayed in!",
    internal_note: null,
    tone: ["warm", "personable"],
    word_count: 163,
    flags: [],
    response: "Christopher, what a wonderful note to read..."
  },
  // ... ensure you include all your other scenarios here exactly as they were ...
];

function StarRow({ rating, color }: { rating: number; color: string }) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <svg key={i} width="13" height="13" viewBox="0 0 24 24" fill={i <= rating ? color : "#1e3a5e"}>
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
      ))}
    </div>
  );
}

export default function RepuGuardSandbox() {
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [phase, setPhase] = useState("idle");
  const [displayed, setDisplayed] = useState("");
  const [showMeta, setShowMeta] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const indexRef = useRef(0);

  function clearTimers() {
    if (timerRef.current) clearTimeout(timerRef.current);
  }

  function runScenario(scenario: Scenario) {
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

  function typeNext(fullText: string) {
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
    <div style={{ background: "#070f1f", borderRadius: 20, border: "1px solid #0e2040", padding: 24, color: "white" }}>
      {/* COPY YOUR ORIGINAL JSX UI CODE HERE 
         (Everything inside the 'return' block from your previous file version) 
      */}
      <h1>Demo Sandbox</h1>
      {/* ...rest of the original UI... */}
    </div>
  );
}
