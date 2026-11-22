// Invented numbers for layout checks and tests only. Never present these as real responses.
export const SAMPLE_RESULTS = {
  sample: true,
  respondents: 12,
  ratings: {
    "Alert clarity": { overall: 4.3, by_role: { teammate: 4.6, classmate: 4.1 } },
    "Answer usefulness": { overall: 3.9, by_role: { teammate: 4.2, classmate: 3.7 } },
    "Trust in obstacle warnings": { overall: 3.1, by_role: { teammate: 3.5, classmate: 2.8 } },
  },
  timing: { "Too late": 4, "About right": 6, "Too early": 1, "Not sure": 1 },
  features: { "Spoken obstacle alerts": 5, "Distance in meters": 3, "Asking the assistant questions": 2, "Reading signs and text": 1, "Remembering my belongings": 1 },
  themes: [
    { theme: "Alerts should say how soon, not only how far", mentions: 5, quote: "One meter is too late when I'm walking fast." },
    { theme: "Answers are helpful but a bit long", mentions: 3, quote: "Just tell me the closest thing first." },
    { theme: "Unsure when the system cannot see", mentions: 3, quote: "I want to know when it's blind, like glass doors." },
  ],
  fixes: [
    { fix: "Warn by time-to-collision while walking", mentions: 5, severity: "high" },
    { fix: "Say when the camera cannot see (glass, darkness)", mentions: 3, severity: "high" },
    { fix: "Lead answers with the nearest obstacle", mentions: 3, severity: "medium" },
  ],
};

export const SAMPLE_COMPARE = {
  agreements: ["Spoken alerts are the most valuable feature", "Answers should be shorter"],
  differences: [
    { topic: "Trust in warnings", real: "moderate (3.1/5)", synthetic: "low until the system proves itself; want a cane-first fallback" },
    { topic: "Alert timing", real: "a third say too late", synthetic: "most want earlier, vibration as well as speech" },
  ],
};
