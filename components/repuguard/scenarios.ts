// Canned demo scenarios for RepuGuardSandbox. Each scenario carries its own
// severity color identity (color/dimColor/borderColor) — akin to a Badge
// `tone`, but modeled as data here since the sandbox picks one whole theme
// per scenario rather than coloring individual small elements.

export interface Scenario {
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

export const SCENARIOS: Scenario[] = [
  {
    id: "five_star",
    label: "5★ Glowing Review",
    color: "#22c55e",
    dimColor: "#052e16",
    borderColor: "#166534",
    guest_name: "Christopher",
    property_name: "The Carriage House",
    rating: 5,
    review:
      "This is hands-down the best rental we have ever stayed in! The attention to detail is unmatched — from the luxury linens to the locally roasted coffee provided in the kitchen. Check-in was a breeze with the smart lock, and the host checked in on us via text to ensure we had everything we needed. 10/10, will absolutely book again next year!",
    internal_note: null,
    tone: ["warm", "personable", "confident", "gracious"],
    word_count: 163,
    flags: [],
    response:
      "Christopher, what a wonderful note to read — thank you for sharing this so thoughtfully. Hearing that The Carriage House felt like a genuine escape rather than just a place to stay means everything to us. We put real care into the details that most guests never have to think about, so knowing the locally roasted coffee and the linens made an impression tells us those choices are landing exactly as intended. The smart lock was something we introduced specifically to make arrivals feel effortless, and it's great to hear the transition into the space was seamless from the very first moment. Hospitality for us isn't just about the physical property — it's about how a guest feels throughout the entire stay, so our team reaching out to check in is simply part of how we operate. We would absolutely love to welcome you back next year. Until then, safe travels, and know that The Carriage House will be ready and waiting.",
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
    review:
      "An okay stay for a quick weekend trip. The furniture was pretty worn out and the bed was very squeaky. It's definitely smaller in person than it looks in the listing photos. The neighborhood is quiet, which was nice, but it's a solid 20-minute drive from any decent restaurants.",
    internal_note: null,
    tone: ["neutral", "constructive", "empathetic", "poised"],
    word_count: 172,
    flags: [],
    response:
      "Robert, thank you for taking the time to share your thoughts after your stay at The Pine Ridge Cabin. We're glad the peaceful surroundings contributed positively to your weekend — the quiet of Pine Ridge is something many guests specifically seek out, and we're pleased that landed well for you. Your feedback about the furniture and bed frame is genuinely appreciated and has been flagged for our property team to assess during our next scheduled maintenance visit. Comfort is non-negotiable, and we take that seriously. On the listing photos and sizing — that's a fair and constructive point. We're reviewing our photo presentation and property description to ensure future guests arrive with accurate expectations around both space and proximity to dining options. Transparency in how we represent Pine Ridge matters to us, and your perspective helps sharpen that. We hope the cabin still served its purpose for a restful getaway, and we'd welcome the chance to host you again under a more refined experience.",
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
    review:
      "The location is fantastic, right in the heart of downtown. Unfortunately that's where the positives end. The Wi-Fi was practically non-existent — measured at less than 2 Mbps — which made working remotely impossible. The shower barely had any pressure and fluctuated between freezing and scalding.",
    internal_note:
      "WiFi upgraded to 500 Mbps fiber last month. Shower pressure and temperature resolved with a new mixing valve installation.",
    tone: ["accountable", "solution-forward", "professional", "empathetic"],
    word_count: 168,
    flags: [],
    response:
      "David, we genuinely appreciate you sharing this with such clarity — this kind of honest feedback is exactly what helps us hold The Summit Retreat to the standard it should be. We hear you completely on the connectivity. While we know that doesn't undo the frustration you experienced, we want you to know that the internet infrastructure has since been upgraded to a 500 Mbps fiber connection — a direct result of feedback like yours. Reliability for remote work was identified as a priority and we acted on it. The shower concerns have also been fully addressed with a new mixing valve installation, ensuring consistent pressure and temperature. The location continues to be one of the retreat's greatest strengths, and we want every aspect of the experience inside the property to match what's right outside the door. If you're ever in the area again, we'd be honored to show you the difference. Please reach out to us directly if we can do anything further.",
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
    review:
      "Absolute nightmare. We arrived at 9 PM after a 6-hour drive only to find the lockbox code didn't work. It took the host over an hour to respond. When we finally got inside, the place clearly hadn't been cleaned since the last guests. We didn't even stay the night — we booked a hotel. Waiting on a full refund.",
    internal_note: null,
    tone: ["empathetic", "de-escalating", "accountable", "professional"],
    word_count: 170,
    flags: ["billing"],
    flag_reason:
      "Guest explicitly states they are awaiting a full refund — active billing dispute flagged for private follow-up.",
    response:
      "Michael, we are deeply sorry for what happened during your arrival — there is no version of this experience that meets any reasonable standard of hospitality, and we want to acknowledge that without reservation. Arriving after a long drive to find an unresponsive lockbox, and then discovering a property that had not been properly turned over, is a serious failure on every level. Your frustration is entirely warranted, and we are grateful you took the time to document it clearly. The access issue, the condition of the property, and the delayed response — each represents a breakdown in our operational process that we are actively investigating and addressing. We understand you were forced to find alternative accommodations that evening, and we take full responsibility for that outcome. Please reach out to our team directly so we can ensure your concern is handled with the urgency it deserves. The Lakeview Cottage is held to a far higher standard than what you experienced, and we intend to make that standard visible.",
  },
];
