/**
 * Warmup message content.
 *
 * Providers flag repetitive, templated-looking traffic, so subjects and bodies
 * are drawn from a varied pool and composed rather than repeated verbatim.
 * The text reads like ordinary short work correspondence, because that is what
 * it is meant to look like to a spam filter.
 */

const SUBJECTS = [
  "Quick update",
  "Notes from earlier",
  "Following up on the draft",
  "Re: this week's plan",
  "Short question",
  "Timeline check",
  "Thoughts on the outline",
  "Small change to the schedule",
  "Recap",
  "One more thing",
  "Checking in",
  "Draft attached below",
  "Feedback on the last version",
  "Next steps",
  "Scheduling",
];

const OPENERS = [
  "Hope your week is going well.",
  "Thanks for turning that around so quickly.",
  "Quick one while it's on my mind.",
  "Following up on what we discussed.",
  "Just tidying up my notes from earlier.",
  "Wanted to close the loop on this.",
];

const MIDDLES = [
  "I went through the outline again and it reads much better now.",
  "The revised timeline works on my side — nothing else is blocking it.",
  "I've put the changes in and left the rest as it was.",
  "Two small edits and then I think it's finished.",
  "Everything looks fine from here, no changes needed.",
  "I moved the second section up, it flows better that way.",
  "Numbers are in and they line up with what we expected.",
];

const CLOSERS = [
  "Let me know if anything looks off.",
  "Happy to go over it whenever suits you.",
  "No rush on this one.",
  "Shout if you'd rather I changed the order.",
  "Give me a nudge if you need it sooner.",
];

const REPLIES = [
  "Thanks — that all makes sense to me.",
  "Got it, nothing further from me.",
  "Looks good. I'll pick it up from here.",
  "Agreed, let's go with that.",
  "Perfect, thanks for sorting it.",
  "That works. I'll update my notes.",
  "Noted — I'll come back to you if anything changes.",
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!;
}

export interface WarmupContent {
  subject: string;
  body: string;
}

export function warmupMessage(random: () => number = Math.random): WarmupContent {
  const paragraphs = [
    pick(OPENERS, random),
    pick(MIDDLES, random),
    pick(CLOSERS, random),
  ];

  // Occasionally drop the middle line so length varies too.
  if (random() < 0.25) paragraphs.splice(1, 1);

  return {
    subject: pick(SUBJECTS, random),
    body: `${paragraphs.join("\n\n")}\n`,
  };
}

export function warmupReply(random: () => number = Math.random): string {
  const lines = [pick(REPLIES, random)];
  if (random() < 0.4) lines.push(pick(CLOSERS, random));
  return `${lines.join("\n\n")}\n`;
}
