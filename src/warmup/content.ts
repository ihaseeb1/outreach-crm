/**
 * Warmup message content.
 *
 * Providers do not read a warmup email and judge it; they look at *patterns*.
 * The pattern that gets a mailbox filtered is repetition — the same fifteen
 * subject lines going round seven accounts, day after day, with a body built
 * from six interchangeable sentences. Two mailboxes exchanging "Quick update /
 * Hope your week is going well" for a month is not correspondence, it is a
 * fingerprint.
 *
 * So the corpus is organised as **topics**, not as a bag of sentences.
 *
 * A topic is a small work situation — a report going round for comment, a
 * supplier quote, a training session being scheduled — with its own subject
 * lines, its own openers and bodies, and its own replies written for the turn
 * they appear in. A thread stays on one topic from beginning to end, so a
 * three-message exchange reads as one conversation rather than three unrelated
 * sentences that happen to share a subject line.
 *
 * Two things make it hold up:
 *
 * 1. **Every choice is combinatorial.** A topic's opening email is a greeting ×
 *    opener × body × closer × sign-off, and each of those has several options
 *    per topic. `corpusSize()` counts it: the pool runs to millions of distinct
 *    openings, so at any realistic volume — seven mailboxes, a handful of sends
 *    each a day — the same message body never goes out twice.
 *
 * 2. **A thread is deterministic in its own root message id.** `warmupReply`
 *    seeds its randomness from the id of the message that started the thread,
 *    so the same thread produces the same reply no matter which tick gets round
 *    to it, and replies inside one conversation never contradict each other or
 *    repeat the line above.
 *
 * Nothing here is ever seen by a prospect. It only has to read like ordinary
 * short work correspondence to a filter that is looking at millions of them.
 */

export interface WarmupTopic {
  id: string;
  /** Subject lines. The first reply prefixes "Re: " and keeps the rest. */
  subjects: string[];
  openers: string[];
  bodies: string[];
  closers: string[];
  /**
   * Replies by turn: `turns[0]` answers the original, `turns[1]` answers that,
   * and so on. A conversation never runs deeper than this array is long.
   */
  turns: string[][];
}

/** Openings that are not topic-specific. Sometimes there is no greeting at all. */
const GREETINGS = [
  "",
  "Hi,",
  "Hi there,",
  "Morning,",
  "Afternoon,",
  "Hello,",
  "Quick one,",
];

/**
 * Second lines for a reply.
 *
 * Deliberately not the topic's own closers: those are written from the point of
 * view of the person who *started* the thread ("Let me know and I'll book the
 * room"), and putting one under a reply had the answering side offering to do
 * the asking side's job. These read the same from either end.
 */
export const REPLY_TAILS = [
  "No rush from my side.",
  "Let me know if that changes.",
  "Shout if you need anything else.",
  "Happy either way.",
  "Nothing else from me on this.",
  "Give me a nudge if it moves again.",
];

/**
 * There is deliberately no sign-off pool here.
 *
 * Warmup mail now carries the same closing block as real outreach — postal
 * address, social icons, opt-out — and that block opens with the company
 * sign-off. A generated "Speak soon," immediately above it put two sign-offs on
 * every message, which is precisely the two-signature shape the footer was
 * rebuilt to get rid of. The body ends on its last sentence and the closing
 * block closes the email, exactly as an outreach email does.
 */

export const WARMUP_TOPICS: WarmupTopic[] = [
  {
    id: "report-draft",
    subjects: [
      "Draft report — second pass",
      "Report draft for review",
      "Notes on the draft",
      "Second version of the report",
      "Draft, before I send it on",
    ],
    openers: [
      "I've had another go at the draft.",
      "Second pass on the report is done.",
      "Picking this back up after last week.",
      "Finally got a clear hour for this.",
    ],
    bodies: [
      "The middle section was doing two jobs, so I split it in two and moved the summary to the front.",
      "Most of the changes are in the second half — the opening was fine as it was.",
      "I cut about a page of repetition and left the figures exactly as they were.",
      "The tables now all use the same units, which they very much did not before.",
      "I've marked the two paragraphs I'm least sure about rather than rewriting them blind.",
      "It reads much better with the appendix pulled out into its own file.",
    ],
    closers: [
      "Have a look when you get a minute.",
      "Let me know if the new order works for you.",
      "No rush — end of the week is fine.",
      "Shout if you'd rather I put it back the way it was.",
    ],
    turns: [
      [
        "Read it this morning — the new order is much clearer.",
        "That's a big improvement. The split in the middle was the right call.",
        "Nothing from me beyond a couple of typos, which I've fixed.",
        "Agreed on the appendix. It was drowning the rest of it.",
      ],
      [
        "Good. I'll leave it as it is then and send it on Thursday.",
        "Thanks for reading it so quickly. I'll tidy the last section tonight.",
        "Perfect — I'll take that as signed off.",
        "That's the last of it done, then.",
      ],
      [
        "Sent. I'll let you know if anything comes back.",
        "All done at this end.",
        "Filed, and I've put a copy in the shared folder.",
        "Noted — I'll pick it up again if there are comments.",
      ],
    ],
  },
  {
    id: "timeline",
    subjects: [
      "Revised timeline",
      "Dates for the next two weeks",
      "Timeline — one week later",
      "Schedule check",
      "Where we are on dates",
    ],
    openers: [
      "Quick note on dates while it's in front of me.",
      "The timeline needed moving, so here it is.",
      "Checking we still agree on the dates.",
      "One change to the schedule.",
    ],
    bodies: [
      "Everything shifts a week later, which puts delivery in the last week of the month.",
      "The first two milestones are unchanged; only the final one has moved.",
      "That still leaves a few days of slack before the deadline, which I'd rather keep.",
      "Nothing is blocked — this is just to keep the plan honest about where we are.",
      "I've assumed we lose the bank holiday. If that's wrong it comes back a day.",
      "Two of the dates were only ever estimates, and they've turned out optimistic.",
    ],
    closers: [
      "Does that still work at your end?",
      "Tell me if that clashes with anything.",
      "Happy to move it again if you need to.",
      "Let me know and I'll update the plan.",
    ],
    turns: [
      [
        "That works. Nothing on my side depends on the earlier date.",
        "Fine by me — a week later is easier, if anything.",
        "One clash, but it's a small one and I can move it.",
        "Good. I'd rather have the slack than hit the deadline exactly.",
      ],
      [
        "Updated the plan with those dates.",
        "Great — I'll put it in the calendar now.",
        "Noted. I'll let the others know it's moved.",
        "That's the plan settled, then.",
      ],
      [
        "Calendar's updated and everyone has it.",
        "All confirmed at this end.",
        "Done — nothing else outstanding on dates.",
        "Good. I'll leave it alone unless something changes.",
      ],
    ],
  },
  {
    id: "invoice",
    subjects: [
      "Invoice for last month",
      "Billing query",
      "Invoice 4471",
      "Payment — last month",
      "One line on the invoice",
    ],
    openers: [
      "Invoice for last month is attached in the usual place.",
      "Small query on the billing.",
      "Sorting out the accounts before month end.",
      "One thing on the last invoice.",
    ],
    bodies: [
      "The total is the same as last month; only the reference number has changed.",
      "There's a line on it I can't place — I think it's the extra day in March.",
      "Payment terms are the usual thirty days from the date on it.",
      "I've split it by month rather than sending one at the end of the quarter.",
      "If the reference is wrong it bounces back to me, so worth a quick check.",
      "The VAT line was missing on the last one and it's fixed on this.",
    ],
    closers: [
      "Let me know if anything looks off.",
      "No hurry, whenever accounts get to it.",
      "Happy to resend it if it hasn't arrived.",
      "Give me a shout if you need it broken down further.",
    ],
    turns: [
      [
        "Got it, thanks — passed to accounts this morning.",
        "That line is the extra day, yes. All correct.",
        "Received. It'll go out with the next payment run.",
        "Looks right to me. Nothing to query.",
      ],
      [
        "Perfect, thanks for checking.",
        "Good — I'll mark it as sent then.",
        "Thanks. I'll keep an eye out for it.",
        "That's that one closed.",
      ],
      [
        "Payment's gone out today.",
        "Cleared this morning, all settled.",
        "Confirmed at this end. Thanks for sorting it.",
        "All square. Thanks.",
      ],
    ],
  },
  {
    id: "meeting",
    subjects: [
      "Time for a call this week?",
      "Moving Thursday",
      "Half an hour Wednesday?",
      "Call — new time",
      "Can we push the meeting?",
    ],
    openers: [
      "Trying to find half an hour this week.",
      "Thursday has fallen apart at my end.",
      "Quick one about the call.",
      "Wondering if we could move Wednesday.",
    ],
    bodies: [
      "Tuesday or Thursday afternoon both work for me; mornings are gone this week.",
      "Half an hour should be plenty — it's really just the one decision.",
      "If it's easier we could do it on the phone rather than a video call.",
      "I'd rather do it properly next week than squeeze it in badly on Friday.",
      "Anything after two o'clock is fine, and I can be flexible on the day.",
      "No agenda beyond the one item, so it may well be shorter than the slot.",
    ],
    closers: [
      "Send me a time and I'll take it.",
      "Whatever suits you is fine.",
      "Let me know what works and I'll put it in.",
      "Happy to fit around you.",
    ],
    turns: [
      [
        "Thursday at three works for me.",
        "Tuesday afternoon then — I'll send an invite.",
        "Let's do next week rather than rush it. Monday?",
        "Phone is easier, if you don't mind.",
      ],
      [
        "Booked. I'll call you on the usual number.",
        "In the calendar — see you then.",
        "That's fine, Monday it is.",
        "Great, I'll ring you at three.",
      ],
      [
        "Good call, thanks. I'll write up the one action.",
        "That was quicker than expected. All clear.",
        "Thanks for making time. Nothing else needed from me.",
        "All settled on the call — nothing to add.",
      ],
    ],
  },
  {
    id: "website-copy",
    subjects: [
      "Copy for the new page",
      "Wording on the homepage",
      "Two lines to change",
      "Page copy — final version",
      "Homepage text",
    ],
    openers: [
      "The copy for the new page is ready.",
      "Two small wording changes, nothing structural.",
      "Had another look at the homepage text.",
      "Last version of the copy, I think.",
    ],
    bodies: [
      "The headline is shorter now — the old one didn't fit on a phone.",
      "I've dropped the third paragraph entirely; it repeated the section above it.",
      "Same meaning, fewer words. It was about a third longer than it needed to be.",
      "The button text now matches what the page it goes to actually says.",
      "I've kept the technical wording exactly as it was, since that was deliberate.",
      "One typo in the second line, which has been there longer than I'd like to admit.",
    ],
    closers: [
      "Fine to put live as far as I'm concerned.",
      "Let me know if the shorter headline reads oddly to you.",
      "Have a look before it goes up.",
      "Say the word and I'll publish it.",
    ],
    turns: [
      [
        "Reads well. The shorter headline is better on mobile.",
        "Happy with that. Put it live whenever.",
        "One thing — can we keep the old wording on the button?",
        "Good spot on the typo. Yes, publish it.",
      ],
      [
        "Live now.",
        "Published, and it looks right on both sizes.",
        "Put the button back as it was and pushed it.",
        "Done — it's up.",
      ],
      [
        "Checked it on a phone this morning and it's fine.",
        "No issues since it went up.",
        "All good. Nothing further.",
        "That's that page finished.",
      ],
    ],
  },
  {
    id: "supplier-quote",
    subjects: [
      "Quote from the supplier",
      "Pricing came back",
      "Two quotes to compare",
      "Supplier pricing",
      "Costs for next quarter",
    ],
    openers: [
      "The quote came back this morning.",
      "Both suppliers have replied now.",
      "Pricing for next quarter is in.",
      "Numbers from the supplier, finally.",
    ],
    bodies: [
      "It's slightly above what we budgeted, but the lead time is two weeks shorter.",
      "The two are within a few per cent of each other, so it comes down to timing.",
      "They'll hold the price until the end of the month, which gives us room to decide.",
      "The cheaper one wants payment up front, which I'm less keen on.",
      "Volume makes almost no difference below a hundred units, which surprised me.",
      "Delivery is the real difference — one is a fortnight, the other closer to six weeks.",
    ],
    closers: [
      "Worth a quick look before I reply.",
      "Which way would you lean?",
      "I'll hold off answering until I hear from you.",
      "No rush, we have until month end.",
    ],
    turns: [
      [
        "Take the shorter lead time. The difference in price is not worth six weeks.",
        "Agreed, timing matters more here than the few per cent.",
        "I'd avoid paying up front, even at the lower price.",
        "Go with the first one. It's the safer of the two.",
      ],
      [
        "That's what I thought too. I'll confirm it today.",
        "Right, I'll accept and get the dates in writing.",
        "Confirmed with them this afternoon.",
        "Good — one less thing open.",
      ],
      [
        "Order's placed and the dates are confirmed.",
        "All arranged. Delivery in the second week.",
        "Done. I'll chase them if anything slips.",
        "That's it sorted.",
      ],
    ],
  },
  {
    id: "hiring",
    subjects: [
      "Interviews next week",
      "Two candidates",
      "Notes from yesterday's interview",
      "Shortlist",
      "Interview slots",
    ],
    openers: [
      "Interviews are set for next week.",
      "Notes from yesterday, while they're fresh.",
      "The shortlist is down to two.",
      "Quick summary of where we are on hiring.",
    ],
    bodies: [
      "Both are strong on the practical side; one is clearly better at explaining their thinking.",
      "I've put half an hour aside for each, with a longer slot for the second stage.",
      "Neither has done exactly this before, which I think matters less than it looks.",
      "The written exercise sorted them out more clearly than the conversations did.",
      "One is available almost immediately, the other has a two-month notice period.",
      "I've written up notes on both rather than trying to rank them yet.",
    ],
    closers: [
      "Worth talking it through before we decide.",
      "Let me know if you want to sit in on the second one.",
      "I'll hold off replying to either until we've spoken.",
      "Happy to arrange another conversation with either of them.",
    ],
    turns: [
      [
        "I'd like to meet the second one before we decide.",
        "The notice period is a problem, but not a fatal one.",
        "Agreed — the exercise told us more than the interviews.",
        "Let's do a second conversation with both.",
      ],
      [
        "Arranged for Thursday, both of them.",
        "Booked. I'll send you the notes beforehand.",
        "That's set up for next week.",
        "Both are in the diary now.",
      ],
      [
        "Offer's gone out this morning.",
        "Decision made, and I've let the other one know.",
        "All wrapped up. Start date is the first of next month.",
        "Done, and handled properly with both.",
      ],
    ],
  },
  {
    id: "office",
    subjects: [
      "Desk move",
      "Office on Friday",
      "Parking next week",
      "Room booking",
      "Building work",
    ],
    openers: [
      "Small logistics thing.",
      "Heads up about Friday.",
      "One for the diary.",
      "Nothing urgent, just so you know.",
    ],
    bodies: [
      "The work starts Monday and should be done by the end of the week.",
      "The room is booked from ten, so there's no need to get there early.",
      "Parking will be tight on Thursday — worth coming by train if you can.",
      "We're on the other side of the floor from next week, same building.",
      "It's noisier than expected, so I'd avoid booking calls in that room for now.",
      "Access is unchanged; only the entrance on the far side is closed.",
    ],
    closers: [
      "Nothing needed from you, just so you know.",
      "Shout if that causes a problem.",
      "Let me know if you'd rather move it.",
      "I'll send round the details nearer the time.",
    ],
    turns: [
      [
        "Thanks for the warning — I'll come in by train.",
        "Noted. That doesn't affect anything at my end.",
        "Good to know. I'll move my calls out of that room.",
        "Fine by me. See you Friday.",
      ],
      [
        "Sensible. I'll do the same.",
        "Good — nothing else to sort then.",
        "Right, that's all clear.",
        "Thanks, that's helpful.",
      ],
      [
        "All went fine in the end.",
        "Quieter than expected, as it turned out.",
        "Back to normal from Monday.",
        "Nothing else on this one.",
      ],
    ],
  },
  {
    id: "training",
    subjects: [
      "Training session — dates",
      "Half day next month",
      "Session for the new starters",
      "Training material",
      "Booking the training",
    ],
    openers: [
      "Trying to pin down the training dates.",
      "The material for the session is ready.",
      "Two options for the training.",
      "Quick one on the session next month.",
    ],
    bodies: [
      "A half day covers it comfortably; a full day would be padding.",
      "I've cut the slides down to about twenty, with more time for questions.",
      "Doing it in two smaller groups works better than one big session.",
      "Morning is better — attention goes after lunch, every time.",
      "The new starters need the first half; everyone else only needs the second.",
      "It's mostly hands-on now, which is what people asked for last time.",
    ],
    closers: [
      "Which of the two dates suits you?",
      "Let me know and I'll book the room.",
      "Happy to send the material over first.",
      "Tell me if you'd rather split it differently.",
    ],
    turns: [
      [
        "The morning of the twelfth works for me.",
        "Two groups is the right call. One big one never works.",
        "Send the material over and I'll have a look first.",
        "Half a day sounds about right.",
      ],
      [
        "Booked for the twelfth. I'll circulate it.",
        "Material's on its way over now.",
        "Room's reserved and the invites are out.",
        "That's arranged then.",
      ],
      [
        "Went well — the hands-on part was the useful bit.",
        "Good turnout, and the questions were better than last time.",
        "All done. I'll write up what came out of it.",
        "Nothing outstanding from the session.",
      ],
    ],
  },
  {
    id: "numbers",
    subjects: [
      "Numbers for last month",
      "Quarterly figures",
      "Month end",
      "Figures — corrected",
      "Last quarter, summarised",
    ],
    openers: [
      "Month-end numbers are done.",
      "Corrected figures, replacing what I sent yesterday.",
      "Quarterly summary is ready.",
      "The figures came out better than I expected.",
    ],
    bodies: [
      "The totals are up slightly, and the split between the two lines is almost unchanged.",
      "One of the columns was double-counting, which is now fixed. The total moves by about two per cent.",
      "Nothing dramatic — steady on last quarter, which is fine given the time of year.",
      "The dip in the middle month is the shutdown week, not a real fall.",
      "I've kept the same format as last time so they're directly comparable.",
      "The rounding is different from the version accounts produced, hence the small gap.",
    ],
    closers: [
      "Let me know if you want it cut a different way.",
      "Shout if the format doesn't suit.",
      "Happy to add last year's alongside if that helps.",
      "Anything else you want in it, just say.",
    ],
    turns: [
      [
        "Thanks — the comparison to last quarter is the useful bit.",
        "Good catch on the double count.",
        "Format's fine. Nothing else needed.",
        "That explains the dip, thanks.",
      ],
      [
        "I'll circulate it as it is, then.",
        "Filed. I'll use the same format next month.",
        "Sent on this morning.",
        "That's month end closed.",
      ],
      [
        "No questions came back, so I think we're done.",
        "All signed off.",
        "Nothing further on the figures.",
        "Closed off at this end.",
      ],
    ],
  },
  {
    id: "travel",
    subjects: [
      "Trains on Tuesday",
      "Travel for next week",
      "Hotel booked",
      "Getting there",
      "Travel plans",
    ],
    openers: [
      "Sorted the travel for next week.",
      "Booked the trains this morning.",
      "One thing on getting there.",
      "Travel is arranged, more or less.",
    ],
    bodies: [
      "The earlier train gets in with an hour to spare, which I'd rather have than not.",
      "Hotel is five minutes from the venue, so there's no need to work out transport.",
      "Driving is quicker on paper but the parking makes it a wash.",
      "I've booked a flexible ticket in case the meeting overruns.",
      "Coming back the same evening is doable but tight; I've stayed over instead.",
      "There's engineering work on the Sunday, so I'm travelling Monday morning.",
    ],
    closers: [
      "Let me know if you want the same train.",
      "Happy to book yours at the same time.",
      "Shout if your plans change.",
      "I'll send the details over once it's confirmed.",
    ],
    turns: [
      [
        "Same train would be good, if there's still space.",
        "I'll drive and meet you there.",
        "Staying over makes sense. I'll do the same.",
        "Good thinking on the flexible ticket.",
      ],
      [
        "Booked yours on the same one.",
        "Right, I'll see you at the venue.",
        "Both rooms are confirmed.",
        "All booked and confirmed.",
      ],
      [
        "Journey was fine, no delays.",
        "Got back late but it was worth going.",
        "All done, and the trip was useful.",
        "Nothing else outstanding on travel.",
      ],
    ],
  },
  {
    id: "design-review",
    subjects: [
      "Layout — second version",
      "Design feedback",
      "Two options for the layout",
      "Mockups",
      "Look of the new section",
    ],
    openers: [
      "Second version of the layout is ready.",
      "Two options rather than one, since I couldn't choose.",
      "Had a proper look at the mockups.",
      "Feedback on the design, such as it is.",
    ],
    bodies: [
      "The second one is calmer — less going on at the top, more room to read.",
      "I've kept the spacing consistent, which the first version very much did not.",
      "Both work on a phone; the wider one falls apart below about four hundred pixels.",
      "The colours are the same as everything else we have, which matters more than being interesting.",
      "It's a small change but the whole thing sits better with the heading moved down.",
      "I've left the images at the original size rather than guessing at crops.",
    ],
    closers: [
      "Which of the two do you prefer?",
      "Happy to combine bits of both.",
      "Let me know and I'll finish whichever one wins.",
      "No strong feelings either way from me.",
    ],
    turns: [
      [
        "The second one, easily. It's much calmer.",
        "First one for the top, second one for everything below it?",
        "Second, but keep the heading where it was.",
        "Agreed on the spacing — that was the main problem.",
      ],
      [
        "Right, I'll finish that one off.",
        "Combining them now. It'll be ready tomorrow.",
        "Heading's back where it was and the rest is the second version.",
        "That's the design settled then.",
      ],
      [
        "Finished and handed over.",
        "All done — nothing else needed from me on this.",
        "Sent it across this morning.",
        "That's it complete.",
      ],
    ],
  },
  {
    id: "handover",
    subjects: [
      "Cover for next week",
      "Handover notes",
      "While I'm away",
      "Out from Thursday",
      "Cover arrangements",
    ],
    openers: [
      "I'm out from Thursday, so here's where everything is.",
      "Handover notes, in case anything comes up.",
      "Short one on cover for next week.",
      "Away for a few days — nothing should need doing.",
    ],
    bodies: [
      "Everything outstanding is either finished or waiting on someone else.",
      "The only live thing is the supplier reply, and that isn't due until I'm back.",
      "I'll pick up anything urgent on the Monday rather than leaving it to sit.",
      "Notes are in the shared folder, in the same place as last time.",
      "Nothing is scheduled to go out while I'm away, deliberately.",
      "If something does come up, it can wait — none of it is time-critical.",
    ],
    closers: [
      "Shout if you'd rather I left it differently.",
      "Back on the Monday.",
      "Happy to hand anything over properly before I go.",
      "Let me know if anything worries you.",
    ],
    turns: [
      [
        "That all looks fine. Have a good break.",
        "Noted — I'll leave the supplier thing until you're back.",
        "Nothing here needs you, so enjoy it.",
        "Got it. I'll only call if something is actually on fire.",
      ],
      [
        "Thanks — back Monday.",
        "Perfect. I'll see you when I'm back.",
        "Appreciated. Nothing else to sort.",
        "That's everything handed over.",
      ],
      [
        "Back and caught up.",
        "Nothing had gone wrong, happily.",
        "All picked up again this morning.",
        "Back to normal at this end.",
      ],
    ],
  },
  {
    id: "stock",
    subjects: [
      "Stock check",
      "Running low on two things",
      "Order for next month",
      "Inventory",
      "Reorder",
    ],
    openers: [
      "Did the stock check this morning.",
      "Two things are running low.",
      "Time to put the next order in.",
      "Quick note on what's left.",
    ],
    bodies: [
      "We're fine on everything except the two items that always go first.",
      "At the current rate there's about three weeks left, which is cutting it fine.",
      "I'd rather order slightly more and not have to think about it again until spring.",
      "The lead time has gone out to a fortnight, so ordering later is not really an option.",
      "Nothing has gone missing — the numbers match what went out.",
      "I've put the slower-moving things off until the next order.",
    ],
    closers: [
      "Fine to place the order?",
      "Let me know if you'd rather wait.",
      "I'll put it in tomorrow unless you say otherwise.",
      "Happy to adjust the quantities.",
    ],
    turns: [
      [
        "Go ahead, and order the larger quantity.",
        "Yes, place it. Three weeks is too tight.",
        "Fine — but hold the slow-moving ones as you suggested.",
        "Agreed. Better to over-order slightly here.",
      ],
      [
        "Ordered this morning.",
        "In and confirmed. Delivery next week.",
        "Placed, with the larger quantity.",
        "Done — that's covered until spring.",
      ],
      [
        "Arrived and checked in, all correct.",
        "Delivered on time for once.",
        "All received. Stock is back where it should be.",
        "Nothing else outstanding on this.",
      ],
    ],
  },
  {
    id: "policy",
    subjects: [
      "Small change to the process",
      "New form",
      "Process update",
      "One change from Monday",
      "How we're doing this now",
    ],
    openers: [
      "Small change from Monday.",
      "Updating one bit of the process.",
      "New form replaces the old one from next week.",
      "Nothing dramatic, but worth knowing.",
    ],
    bodies: [
      "It's one extra field, and it saves a chase later, so on balance it's worth it.",
      "The old form still works this month; after that it goes.",
      "Nothing else changes — same people, same timing, same approvals.",
      "This came out of the thing that went wrong in March, which we'd rather not repeat.",
      "It should be quicker, not slower, once everyone is used to it.",
      "I've written it down properly this time rather than leaving it as folklore.",
    ],
    closers: [
      "Shout if that causes a problem for you.",
      "Let me know if I've missed a case.",
      "Happy to walk anyone through it.",
      "Nothing needed from you unless it clashes with something.",
    ],
    turns: [
      [
        "Makes sense. One extra field is nothing.",
        "Fine by me — the March thing was painful enough.",
        "No problems here. I'll switch to the new one now.",
        "Good that it's written down at last.",
      ],
      [
        "Thanks. I'll circulate it to the rest.",
        "Right, that's in from Monday then.",
        "Sent it round this morning.",
        "That's the change made.",
      ],
      [
        "Nobody's raised anything, so it seems to be working.",
        "Bedded in fine.",
        "Working as intended so far.",
        "Nothing further on this.",
      ],
    ],
  },
  {
    id: "newsletter",
    subjects: [
      "This month's newsletter",
      "Newsletter draft",
      "Two items short",
      "Sending Thursday",
      "Newsletter — final",
    ],
    openers: [
      "Draft of this month's newsletter.",
      "I'm two items short for Thursday.",
      "Newsletter is more or less done.",
      "Last look at the newsletter before it goes.",
    ],
    bodies: [
      "Three items so far, which is a bit thin — two more would make it feel complete.",
      "I've dropped the section nobody clicked on last time.",
      "Shorter than usual, which the numbers suggest is the right direction.",
      "The lead item is the training session, since that's the one with a date on it.",
      "Same layout as last month; changing it every time confuses people.",
      "I've kept it to one link per item, which reads much cleaner.",
    ],
    closers: [
      "Anything you want in it?",
      "Send me anything by Wednesday and I'll fit it in.",
      "Let me know if the order looks wrong.",
      "Otherwise it goes Thursday morning.",
    ],
    turns: [
      [
        "I've got one item for you — I'll send it over tonight.",
        "Order looks right. Lead with the training.",
        "Shorter is better. Nothing to add from me.",
        "Nothing from me this month.",
      ],
      [
        "Got it, thanks — that's four.",
        "Right, it goes Thursday as it is.",
        "Added and it fits nicely.",
        "That's it ready to go.",
      ],
      [
        "Sent this morning.",
        "Gone out, and the open rate is about normal.",
        "Out on time. Nothing bounced.",
        "That's this month's done.",
      ],
    ],
  },
  {
    id: "feedback",
    subjects: [
      "Survey results",
      "What came back",
      "Feedback from last week",
      "Responses so far",
      "Survey — summary",
    ],
    openers: [
      "The survey results are in.",
      "Summary of what came back last week.",
      "About forty responses so far.",
      "Feedback is more useful than I expected.",
    ],
    bodies: [
      "The written comments are far more useful than the scores, as usual.",
      "Two things come up repeatedly; everything else is one-offs.",
      "The response rate is better than last time, which I'd put down to it being shorter.",
      "Nothing in it is a surprise, but it's good to have it written down.",
      "The scores are almost identical to six months ago, which is reassuring in its way.",
      "I've grouped the comments rather than quoting all forty.",
    ],
    closers: [
      "Worth going through the two recurring points properly.",
      "Let me know if you want the raw responses.",
      "Happy to pull it into something shorter.",
      "I'll write up the actions unless you'd rather.",
    ],
    turns: [
      [
        "The two recurring points are the ones to act on.",
        "Send the raw responses over when you get a chance.",
        "Agreed — the comments are the useful part.",
        "Good. Let's not over-read the scores.",
      ],
      [
        "I'll write up the two actions and circulate them.",
        "Raw file is on its way.",
        "Summary's done and sent round.",
        "That's the write-up finished.",
      ],
      [
        "Both actions are underway now.",
        "Nothing else came out of it.",
        "Closed off — we'll run it again in six months.",
        "All done on this one.",
      ],
    ],
  },
  {
    id: "equipment",
    subjects: [
      "New laptops",
      "Kit for the new starters",
      "Replacing the old machines",
      "Equipment order",
      "Hardware",
    ],
    openers: [
      "The replacement machines have arrived.",
      "Kit for the new starters is ordered.",
      "Time to replace the oldest machines.",
      "Quick one on equipment.",
    ],
    bodies: [
      "Three of them are past the point where repairs make sense.",
      "Same spec as last time, which keeps everything simple to support.",
      "They arrive next week, so there's a day of setting up before anyone needs them.",
      "The old ones are fine for the spare desks rather than being thrown out.",
      "Cost is roughly what we spent last year, allowing for the price rise.",
      "I've ordered one extra, because there is always one extra person.",
    ],
    closers: [
      "Fine to go ahead?",
      "Let me know if the spec should change.",
      "I'll get them set up before anyone starts.",
      "Shout if you'd rather wait a quarter.",
    ],
    turns: [
      [
        "Go ahead. Same spec is the right call.",
        "Yes, and keeping the old ones as spares makes sense.",
        "Fine. Order the extra one too.",
        "Agreed — three of them are well past it.",
      ],
      [
        "Ordered. They're here next Tuesday.",
        "Placed this morning.",
        "All ordered, including the spare.",
        "Done — I'll set them up when they land.",
      ],
      [
        "All set up and handed out.",
        "Delivered and configured, no problems.",
        "Everyone's on the new machines now.",
        "That's finished.",
      ],
    ],
  },
  {
    id: "event",
    subjects: [
      "Numbers for the event",
      "Venue confirmed",
      "Running order",
      "Event on the ninth",
      "Catering",
    ],
    openers: [
      "Venue is confirmed for the ninth.",
      "Numbers are firmer than they were.",
      "Draft running order for the day.",
      "One thing left to sort for the event.",
    ],
    bodies: [
      "Around thirty confirmed, which the room handles comfortably.",
      "The morning is the substantial part; after lunch is deliberately lighter.",
      "Catering needs final numbers by the Friday before, which is the only hard deadline.",
      "There's a half-hour gap in the middle on purpose — the last one ran over badly.",
      "Everything is on one floor this time, which solves most of last year's problems.",
      "Parking is limited, so the invitation says to come by train.",
    ],
    closers: [
      "Anything you'd move in the running order?",
      "Let me know your numbers by Thursday.",
      "Happy to change the timings.",
      "Otherwise I'll confirm it all on Friday.",
    ],
    turns: [
      [
        "Running order looks right. The gap is a good idea.",
        "Thirty sounds about right. I'll confirm mine tomorrow.",
        "One floor makes all the difference.",
        "Nothing I'd move.",
      ],
      [
        "All confirmed with the venue.",
        "Catering booked for thirty-two.",
        "That's everything locked in.",
        "Confirmed on Friday as planned.",
      ],
      [
        "Went well — the timings held for once.",
        "Good day. A few things to do differently next time.",
        "All done, and the feedback was positive.",
        "Nothing outstanding from the event.",
      ],
    ],
  },
  {
    id: "software",
    subjects: [
      "The update goes out Tuesday",
      "New version",
      "Switching over",
      "Rollout",
      "Version 3 — timing",
    ],
    openers: [
      "The update is ready to go out.",
      "Planning the switch for Tuesday.",
      "New version is stable now.",
      "Quick note on the rollout.",
    ],
    bodies: [
      "Doing it in the morning gives us the whole day to notice if anything is wrong.",
      "Nothing visible changes for most people, which is the point.",
      "The old version stays available for a fortnight in case anything needs going back.",
      "It has been running on the test setup for a week with no issues.",
      "I'd rather do it on a Tuesday than a Friday, for obvious reasons.",
      "The two fiddly bits are both in areas hardly anyone touches.",
    ],
    closers: [
      "Any reason not to do Tuesday?",
      "Let me know if that's a bad week.",
      "I'll send a note round beforehand.",
      "Happy to push it a week if you'd rather.",
    ],
    turns: [
      [
        "Tuesday morning is fine. Not Friday, agreed.",
        "No objection here. Go ahead.",
        "Keep the old version available, yes.",
        "Fine — the test week is reassuring.",
      ],
      [
        "Booked for Tuesday. Note going round Monday.",
        "Right, that's scheduled.",
        "All set for Tuesday morning.",
        "Confirmed.",
      ],
      [
        "Went out this morning, no problems reported.",
        "Done and quiet, which is what you want.",
        "Switched over with nothing to roll back.",
        "All complete.",
      ],
    ],
  },
  {
    id: "photos",
    subjects: [
      "Photos from Thursday",
      "Shoot — dates",
      "Images for the site",
      "Photo selection",
      "Pictures",
    ],
    openers: [
      "Photos from Thursday are ready.",
      "Trying to find a date for the shoot.",
      "Narrowed the images down.",
      "Quick one about the pictures.",
    ],
    bodies: [
      "About two hundred usable, which is far more than we need.",
      "I've picked twelve and left the rest in the folder in case you disagree.",
      "The light was better in the afternoon, so most of the good ones are from later.",
      "They need cropping for the site but otherwise they're fine as they are.",
      "A morning shoot works better for the outside ones.",
      "I've kept the file sizes down so pages don't crawl.",
    ],
    closers: [
      "Have a look through and tell me if I've missed a good one.",
      "Let me know which you'd swap.",
      "Happy to reshoot anything that doesn't work.",
      "Otherwise I'll get these cropped and up.",
    ],
    turns: [
      [
        "Your twelve are the right twelve.",
        "Swap the third for one of the afternoon ones.",
        "All fine. Get them up.",
        "Good — the afternoon light is much better.",
      ],
      [
        "Cropped and uploaded.",
        "Swapped and it's live.",
        "All twelve are on the site now.",
        "That's done.",
      ],
      [
        "Pages look much better with them in.",
        "No complaints since they went up.",
        "All finished on the images.",
        "Nothing further.",
      ],
    ],
  },
  {
    id: "onboarding",
    subjects: [
      "New client — first steps",
      "Onboarding",
      "Kick-off next week",
      "Getting them set up",
      "First month plan",
    ],
    openers: [
      "New client starts next week.",
      "Setting up the onboarding.",
      "Kick-off is booked.",
      "Plan for the first month.",
    ],
    bodies: [
      "The first two weeks are mostly listening; nothing goes out before that.",
      "They've sent everything we asked for, which is not always the case.",
      "One point of contact on each side keeps it simple, so that's how I've set it up.",
      "The kick-off is an hour, and half of that is them talking.",
      "I've written down what success looks like at three months, so we can check.",
      "Expectations are sensible, which is a good sign.",
    ],
    closers: [
      "Anything you'd add to the first month?",
      "Let me know if you want to be on the kick-off.",
      "Happy to share the plan with them beforehand.",
      "I'll send the summary round after the call.",
    ],
    turns: [
      [
        "Put me on the kick-off if there's room.",
        "The plan looks right. Two weeks of listening is sensible.",
        "Good — one contact each side is the way.",
        "Nothing to add. It reads well.",
      ],
      [
        "Added you to the invite.",
        "Plan's gone over to them.",
        "All set for next week.",
        "That's arranged.",
      ],
      [
        "Kick-off went well. They're easy to work with.",
        "Good start. Notes are in the folder.",
        "All underway now.",
        "Nothing outstanding.",
      ],
    ],
  },
  {
    id: "translations",
    subjects: [
      "Translations back",
      "Second language version",
      "Wording in the other version",
      "Translation check",
      "Language versions",
    ],
    openers: [
      "The translations came back this morning.",
      "Second language version is ready to check.",
      "One question on the translated wording.",
      "Both versions are done now.",
    ],
    bodies: [
      "They read naturally, which is the bit machines still get wrong.",
      "Two terms were translated inconsistently and are now the same throughout.",
      "The layout needs a little more room — the translated text runs longer.",
      "I've left product names untranslated, which I think is right.",
      "The tone is slightly more formal, which suits that audience better anyway.",
      "One heading doesn't work translated literally, so it's been rewritten.",
    ],
    closers: [
      "Worth a native speaker glancing at it before it goes live.",
      "Let me know if the formal tone is wrong.",
      "Happy to have the headings looked at again.",
      "Otherwise I'll put both versions up together.",
    ],
    turns: [
      [
        "Formal is right for that audience.",
        "Leave the product names as they are, yes.",
        "I'll get someone to read it through this week.",
        "The rewritten heading is better than a literal one.",
      ],
      [
        "Read through and it's fine. Put it up.",
        "Both versions are ready then.",
        "Checked and approved.",
        "That's the language side finished.",
      ],
      [
        "Both live as of this morning.",
        "Up and rendering correctly in both.",
        "All published.",
        "Nothing else on this.",
      ],
    ],
  },
  {
    id: "backup",
    subjects: [
      "Backups checked",
      "Restore test",
      "Storage",
      "Monthly check",
      "Housekeeping",
    ],
    openers: [
      "Did the monthly check this morning.",
      "Ran a restore test, which is overdue.",
      "Storage is filling up faster than it was.",
      "Routine housekeeping note.",
    ],
    bodies: [
      "The restore worked, which is the only test of a backup that counts.",
      "There's about six months of room left at the current rate.",
      "Two old folders were taking a surprising amount of space and are archived now.",
      "Everything is where it should be and nothing has failed silently.",
      "The schedule runs overnight, so nobody notices it either way.",
      "I've set a reminder to test it properly every quarter rather than every year.",
    ],
    closers: [
      "Nothing needed from you.",
      "Let me know if you want more room ordered now.",
      "I'll do the same again next month.",
      "Shout if you'd rather keep the old folders.",
    ],
    turns: [
      [
        "Good that the restore actually works.",
        "Archive them, yes. Nobody has opened those in years.",
        "Six months is enough warning. We'll sort it next quarter.",
        "Quarterly testing is a better idea than yearly.",
      ],
      [
        "Archived, and the space is back.",
        "I'll book the extra storage next quarter then.",
        "Reminder is set.",
        "That's the housekeeping done.",
      ],
      [
        "All quiet since. Nothing to report.",
        "Ran again this month, all fine.",
        "Nothing further on this.",
        "Closed off.",
      ],
    ],
  },
];

/** A tiny deterministic PRNG, seeded from a string. */
function seededRandom(seed: string): () => number {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }
  // Mulberry32. Fast, and good enough to pick sentences with.
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!;
}

export interface WarmupContent {
  subject: string;
  body: string;
  /** Which topic this came from, so a reply can stay on it. */
  topicId: string;
}

/**
 * One opening message.
 *
 * Assembled from a single topic so the three sentences belong together — the
 * old version drew each line from a separate global pool, which produced
 * grammatical paragraphs that were about nothing in particular.
 */
export function warmupMessage(random: () => number = Math.random): WarmupContent {
  const topic = pick(WARMUP_TOPICS, random);

  const lines = [pick(topic.openers, random), pick(topic.bodies, random)];

  // Sometimes a second body line, sometimes none beyond the opener — real mail
  // varies in length and a constant three-paragraph shape is itself a pattern.
  if (random() < 0.35) {
    const extra = pick(topic.bodies, random);
    if (!lines.includes(extra)) lines.push(extra);
  }
  if (random() < 0.8) lines.push(pick(topic.closers, random));

  return {
    subject: pick(topic.subjects, random),
    body: wrap(lines, random),
    topicId: topic.id,
  };
}

/**
 * A reply, on the topic the thread is already about.
 *
 * `depth` is how many messages the thread already holds, so the second reply
 * answers the first rather than repeating it. `seed` is the thread's root
 * message id: the same thread always produces the same reply, however many
 * ticks it takes to get round to sending it, which is what stops a conversation
 * contradicting itself when it plays out over several days.
 */
export function warmupReply(
  options: {
    subject?: string | null;
    /** Messages already in the thread. 1 = replying to the original. */
    depth?: number;
    seed?: string | null;
  } = {},
  fallbackRandom: () => number = Math.random,
): string {
  // The depth goes into the seed, not just into the turn index. Without it a
  // thread that runs past the last written turn would draw the same line twice
  // — same seed, same call sequence, same sentence — which is the one thing a
  // conversation must never do.
  const random = options.seed
    ? seededRandom(`${options.seed}#${options.depth ?? 1}`)
    : fallbackRandom;
  const topic = topicForSubject(options.subject) ?? pick(WARMUP_TOPICS, random);

  const turn = Math.min(
    Math.max((options.depth ?? 1) - 1, 0),
    topic.turns.length - 1,
  );
  const lines = [pick(topic.turns[turn] ?? topic.turns[0]!, random)];

  // Early in a thread there is often a second line; by the end of one there is
  // not, because the last message in a real exchange is usually the shortest.
  if (turn === 0 && random() < 0.45) lines.push(pick(REPLY_TAILS, random));

  return wrap(lines, random);
}

/**
 * Which topic a subject line belongs to.
 *
 * The subject is the only thing a reply carries forward — `warmup_messages`
 * stores it — so it doubles as the thread's topic key. Matching on the stored
 * subject rather than adding a column keeps a conversation coherent with no
 * migration behind it. "Re: " prefixes are stripped, however many have stacked
 * up.
 */
export function topicForSubject(subject: string | null | undefined): WarmupTopic | null {
  if (!subject) return null;
  const stripped = subject.replace(/^(?:\s*re\s*:\s*)+/i, "").trim().toLowerCase();
  if (!stripped) return null;

  return (
    WARMUP_TOPICS.find((topic) =>
      topic.subjects.some((candidate) => candidate.toLowerCase() === stripped),
    ) ?? null
  );
}

/** A greeting, which may be absent, then the lines. The footer closes it. */
function wrap(lines: string[], random: () => number): string {
  const greeting = pick(GREETINGS, random);
  const parts = [...(greeting ? [greeting] : []), ...lines];
  return `${parts.join("\n\n")}\n`;
}

/**
 * How much distinct material there actually is.
 *
 * Exported so the smoke tests can assert on it rather than on a promise in a
 * comment: if someone trims the corpus back, the number moves and the test
 * says so.
 */
export function corpusSize(): {
  topics: number;
  subjects: number;
  openings: number;
  replies: number;
} {
  let subjects = 0;
  let openings = 0;
  let replies = 0;

  for (const topic of WARMUP_TOPICS) {
    subjects += topic.subjects.length;

    // What `warmupMessage` can actually assemble: a greeting (or none), an
    // opener, either one body line or an ordered pair of different ones, and a
    // closer (or none). No sign-off — the closing block supplies that.
    const bodyChoices =
      topic.bodies.length + topic.bodies.length * (topic.bodies.length - 1);

    openings +=
      topic.subjects.length *
      GREETINGS.length *
      topic.openers.length *
      bodyChoices *
      (topic.closers.length + 1);

    for (const turn of topic.turns) replies += turn.length;
  }

  return { topics: WARMUP_TOPICS.length, subjects, openings, replies };
}
