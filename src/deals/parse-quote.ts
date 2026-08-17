/**
 * Reads a publisher's quote out of their email.
 *
 * Every deal in this CRM starts as a paragraph of prose: "General 150, Casino
 * 400, CBD 350, DA 45, dofollow, 2 links max, 3 day TAT, PayPal 50% advance."
 * Retyping that into fifteen form fields for every publisher is most of the work
 * of logging a deal, and it is the part where numbers get transposed.
 *
 * Pure text in, structured quote out — no network, no model, no API key. A
 * regex pass is not clever, but it is inspectable and it is free, and publisher
 * rate cards are written to a handful of conventions rather than freely. Every
 * field carries the line it came from so a wrong read is visible rather than
 * silently saved.
 *
 * Nothing here writes anything. The form fills its blanks and the user checks it.
 */

export interface ParsedPrice {
  niche: string;
  price: number;
}

export interface ParsedQuote {
  currency: string | null;
  prices: ParsedPrice[];
  linkType: string | null;
  placementType: string | null;
  tatDays: number | null;
  da: number | null;
  dr: number | null;
  monthlyTraffic: number | null;
  spamScore: number | null;
  wordCount: number | null;
  maxLinks: number | null;
  contentBy: string | null;
  paymentMethod: string | null;
  paymentTerms: string | null;
  /** Field name → the line it was read from, so every value can be checked. */
  evidence: Record<string, string>;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "₨": "PKR",
  "¥": "JPY",
};

const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "INR",
  "PKR",
  "AUD",
  "CAD",
  "AED",
  "SGD",
  "JPY",
  "CHF",
  "ZAR",
  "BRL",
];

/**
 * Publisher wording → the niche this CRM files it under.
 *
 * Ordered: the restricted, expensive niches are tested first, because "casino
 * SEO" and "CBD health" name a casino and a CBD price, not an SEO or a health
 * one. "General" is last so "general business" files as Business.
 */
const NICHE_ALIASES: [RegExp, string][] = [
  [/\b(casinos?|gambl\w*|betting|bets?|pokers?|slots?|sportsbooks?|igaming)\b/i, "Casino"],
  [/\b(cbd|cannabis|marijuana|weed|hemp|vape|kratom)\b/i, "CBD"],
  [/\b(crypto\w*|bitcoin|blockchain|nft|web\s?3)\b/i, "Crypto"],
  [/\b(adult|porn\w*|escort|xxx)\b/i, "Adult"],
  [/\b(dating|hookup)\b/i, "Dating"],
  [/\b(finance|financial|insurance|loans?|banking|mortgage|forex|trading)\b/i, "Finance"],
  [/\b(health|medical|medicine|pharma\w*|fitness|wellness|nutrition|supplements?)\b/i, "Health"],
  [/\b(law|legal|lawyer|attorney)\b/i, "Legal"],
  [/\b(real\s?estate|property)\b/i, "Real estate"],
  [/\b(travel|tourism)\b/i, "Travel"],
  [/\b(education|edu)\b/i, "Education"],
  [/\b(tech|technology|software|saas|gadgets?|ai)\b/i, "Tech"],
  [/\b(business|marketing|seo|startups?|b2b)\b/i, "Business"],
  [/\b(home|garden|interior|decor)\b/i, "Home"],
  [/\b(general|normal|regular|standard|non[-\s]?niche|others?|any|all)\b/i, "General"],
];

/** Niches that set the price wherever they appear in a label. */
const RESTRICTED = new Set(["Casino", "CBD", "Crypto", "Adult", "Dating"]);

const PLACEMENTS: [RegExp, string][] = [
  [/\bniche\s*edits?\b/i, "niche edit"],
  [/\b(link\s*insertion|link\s*placement|contextual\s*link)\b/i, "link insertion"],
  [/\bhome\s*page\b|\bhomepage\b/i, "homepage"],
  [/\bpress\s*release\b/i, "press release"],
  [/\b(guest\s*post|guest\s*article|sponsored\s*post|sponsored\s*article)\b/i, "guest post"],
];

/**
 * Words that make a bare number something other than money. "DA 45" and "1000
 * words" are not a price; a number wearing a currency is, whatever it sits next
 * to.
 */
/**
 * Labels that name a metric rather than a product.
 *
 * Anchored whole, not searched for. Banning the *word* "link" anywhere threw
 * away "Link insertion 150" and "30 Days Footer Text Link 30" — real products
 * with real prices — while what actually needs rejecting is a label that is
 * nothing but the metric: "Max links 2", "DA 45".
 */
const METRIC_LABEL =
  /^(da|dr|pa|ur|tf|cf|ds|domain\s*(authority|rating)|moz\s*da|ahrefs\s*dr|spam(\s*score)?|traffic|(monthly|organic)\s*traffic|words?|word\s*count|min(imum)?\s*words?|article\s*length|tat|turn\s*around|turnaround|delivery|deadline|(max(imum)?|no\.?\s*of|number\s*of)\s*links?|links?|copyright|since|est)$/i;

/**
 * Wording that makes a line a sentence rather than a rate-card row.
 *
 * "We can write the content for an extra £40" carries a real number and no
 * niche at all; read as a price it invents a niche out of half a sentence.
 * A niche label is a label — a couple of words, no pronouns, no verbs.
 */
const PROSE =
  /\b(we|i|you|our|your|us|they|it|can|will|would|should|could|may|please|thanks?|write|writing|written|provide|send|pay|paid|charge[sd]?|extra|additional|discount|offer|budget|accept|include[sd]?|starting)\b/i;

const MAX_LABEL_WORDS = 5;

/** Cut the publisher's own words free of everything they quoted back. */
export function stripQuotedReply(text: string): string {
  if (!text) return "";

  const markers = [
    /^\s*On .{0,200}\bwrote:\s*$/im,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^\s*_{5,}\s*$/m,
    /^\s*From:\s*.+$/im,
    /^\s*Sent from my \w+/im,
  ];

  let cut = text;
  for (const marker of markers) {
    const match = marker.exec(cut);
    // Only trust a marker that leaves something behind: a reply written
    // *underneath* the quote would otherwise be thrown away entirely.
    if (match && match.index > 40) cut = cut.slice(0, match.index);
  }

  return cut
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

export function parseQuote(input: string): ParsedQuote {
  const text = stripQuotedReply(input ?? "");
  const lines = text.split(/\r?\n/);

  const quote: ParsedQuote = {
    currency: null,
    prices: [],
    linkType: null,
    placementType: null,
    tatDays: null,
    da: null,
    dr: null,
    monthlyTraffic: null,
    spamScore: null,
    wordCount: null,
    maxLinks: null,
    contentBy: null,
    paymentMethod: null,
    paymentTerms: null,
    evidence: {},
  };

  if (!text.trim()) return quote;

  readPrices(lines, quote);
  readMetrics(text, quote);
  readTerms(text, quote);

  return quote;
}

/** Records a value and the line it came from, first read wins. */
function set<K extends keyof ParsedQuote>(
  quote: ParsedQuote,
  field: K,
  value: ParsedQuote[K],
  source: string,
): void {
  if (quote[field] !== null && quote[field] !== undefined) return;
  if (value === null || value === undefined) return;
  quote[field] = value;
  quote.evidence[field as string] = source.trim().slice(0, 160);
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function readPrices(lines: string[], quote: ParsedQuote): void {
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    for (const segment of splitPriceSegments(line)) {
      const money = readMoney(segment);
      if (!money) continue;

      const label = labelFor(segment, money.at, money.raw.length);
      if (!label) continue;

      const niche = canonicalNiche(label);
      const key = niche.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      quote.prices.push({ niche, price: money.amount });
      quote.evidence[`price:${niche}`] = line.trim().slice(0, 160);

      if (money.currency) set(quote, "currency", money.currency, line);
    }
  }

  // A rate card almost always quotes one currency; if only later rows spelled
  // it out, it still applies to the first.
  if (!quote.currency && quote.prices.length > 0) {
    const code = CURRENCY_CODES.find((value) =>
      new RegExp(`\\b${value}\\b`, "i").test(lines.join("\n")),
    );
    if (code) quote.currency = code;
  }
}

/**
 * "General $150, Casino $400" is two prices on one line; "Casino, Gambling -
 * $400" is one. Splitting only when a line carries two amounts tells them apart.
 */
function splitPriceSegments(line: string): string[] {
  const amounts = line.match(/[$£€₹₨¥]\s?\d|\d+\s*(?:USD|EUR|GBP|INR|PKR|AUD|CAD)\b/gi);
  if (!amounts || amounts.length < 2) return [line];
  // Never on a comma inside a number: "1,200" must survive.
  return line.split(/[;|]|,(?=\s*\D)/);
}

interface Money {
  amount: number;
  currency: string | null;
  /** The exact matched text, so the label can be taken from around it. */
  raw: string;
  /**
   * Where in the segment that text starts.
   *
   * Searching for it instead found the wrong one: "30 Days Footer Text Link 30"
   * priced at 30 matched the *leading* 30 and took everything after it as the
   * label, which named the product "Days Footer Text Link 30".
   */
  at: number;
}

function readMoney(segment: string): Money | null {
  const withSymbol =
    /([$£€₹₨¥])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:k\b)?/i.exec(
      segment,
    );
  if (withSymbol) {
    const [raw, symbol = "", digits = ""] = withSymbol;
    return {
      amount: toAmount(digits, /k\b/i.test(raw)),
      currency: CURRENCY_SYMBOLS[symbol] ?? null,
      raw,
      at: withSymbol.index,
    };
  }

  const withCode = new RegExp(
    `(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)\\s*(${CURRENCY_CODES.join("|")})\\b`,
    "i",
  ).exec(segment);
  if (withCode) {
    const [raw, digits = "", code = ""] = withCode;
    return { amount: toAmount(digits, false), currency: code.toUpperCase(), raw, at: withCode.index };
  }

  const codeFirst = new RegExp(
    `\\b(${CURRENCY_CODES.join("|")})\\s*(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)`,
    "i",
  ).exec(segment);
  if (codeFirst) {
    const [raw, code = "", digits = ""] = codeFirst;
    return { amount: toAmount(digits, false), currency: code.toUpperCase(), raw, at: codeFirst.index };
  }

  // No currency anywhere. A whole line that is a label and then a number is a
  // rate-card row: "General - 100", and equally "General 100", which is how a
  // pasted table arrives. The separator is optional because publishers often
  // have none; what keeps this honest is that the number must end the line and
  // the label must not read as a metric — "DA 45" and "Max 2 links" are caught
  // by NOT_MONEY below.
  const bare =
    /^[\s*•]*([^:\-–—|]{2,40}?)\s*[-–—:|]?\s+(\d{2,6})(?:\s*(?:\/|per)\s*\w+)?\s*$/i.exec(
      segment,
    );
  if (bare) {
    const [, label = "", digits = ""] = bare;
    if (digits && !METRIC_LABEL.test(label.trim())) {
      // The price is the last number on the line, never a leading one.
      return {
        amount: Number(digits),
        currency: null,
        raw: digits,
        at: bare.index + bare[0].lastIndexOf(digits),
      };
    }
  }

  return null;
}

function toAmount(digits: string, thousands: boolean): number {
  const value = Number(digits.replace(/,/g, ""));
  return thousands ? value * 1000 : value;
}

/** The words around the amount, cleaned of bullets and connecting words. */
function labelFor(segment: string, at: number, length: number): string | null {
  const before = segment.slice(0, at);
  const after = segment.slice(at + length);

  const candidate = before.replace(/[^\p{L}\p{N}\s/&()+'-]/gu, " ").trim()
    ? before
    : after;

  // "Our rates: General $150" — the niche is what follows the preamble, not the
  // whole run-up to the number.
  const parts = candidate.split(":").map((part) => part.trim()).filter(Boolean);
  const tail = parts.length > 0 ? parts[parts.length - 1]! : candidate;

  const label = tail
    .replace(/[*•]/g, " ")
    // A leading number is list numbering ("1. General") — unless a word follows
    // that makes it part of the name. "30 Days Footer Text Link" is a product,
    // and stripping its 30 left "Days Footer Text Link", which means nothing.
    .replace(/^[\s.)]*\d+[.)]\s+/, "")
    .replace(/^[\s.)]+/, "")
    .replace(/[\s:|=–—-]+$/, "")
    .replace(/^[\s:|=–—-]+/, "")
    .replace(/\b(price|cost|rate|charges?|fee|for|is|are|starts?\s+(?:at|from)|only|per\s+post|each)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!label || label.length < 2) return null;
  if (/^\d+$/.test(label)) return null;
  if (PROSE.test(label)) return null;
  if (label.split(/\s+/).length > MAX_LABEL_WORDS) return null;
  return label.slice(0, 60);
}

/**
 * Publisher's wording → the niche name this CRM files it under.
 *
 * A label naming several niches goes by *their* order, not this list's:
 * "Business/Tech" is a business price they also accept tech for. The one
 * exception is the restricted set — a label mentioning casino or CBD anywhere
 * in it is that price whatever came first, because "SEO for casinos" is quoted
 * at the casino rate, not the SEO one.
 */
export function canonicalNiche(label: string): string {
  const matches: { at: number; niche: string; restricted: boolean }[] = [];

  for (const [pattern, niche] of NICHE_ALIASES) {
    const found = new RegExp(pattern.source, "i").exec(label);
    if (found) {
      matches.push({ at: found.index, niche, restricted: RESTRICTED.has(niche) });
    }
  }

  if (matches.length > 0) {
    const restricted = matches.filter((match) => match.restricted);
    // "General" means "no particular niche", so it loses to any niche that is
    // actually named: "general business" is a business price.
    const named = matches.filter((match) => match.niche !== "General");
    const pool = restricted.length > 0 ? restricted : named.length > 0 ? named : matches;
    const best = pool.sort((a, b) => a.at - b.at)[0];
    if (best) return best.niche;
  }
  // Unrecognised is kept as they wrote it — a rate card may name a niche this
  // list has never seen, and inventing "General" for it would lose the price.
  const cleaned = label.replace(/\s{2,}/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function readMetrics(text: string, quote: ParsedQuote): void {
  // "DA/DR: 45/52" and "DA 45 DR 52" are both common; the combined form has to
  // be read first or "DA" would swallow the pair.
  const combined = /\bda\s*[/&]\s*dr\b\s*[:=-]?\s*(\d{1,3})\s*[/&]\s*(\d{1,3})/i.exec(text);
  if (combined) {
    set(quote, "da", clamp(Number(combined[1]), 0, 100), lineAround(text, combined.index));
    set(quote, "dr", clamp(Number(combined[2]), 0, 100), lineAround(text, combined.index));
  }

  const da = /\b(?:da|domain\s*authority)\b\s*[:=-]?\s*(\d{1,3})/i.exec(text);
  if (da) set(quote, "da", clamp(Number(da[1]), 0, 100), lineAround(text, da.index));

  const dr = /\b(?:dr|domain\s*rating)\b\s*[:=-]?\s*(\d{1,3})/i.exec(text);
  if (dr) set(quote, "dr", clamp(Number(dr[1]), 0, 100), lineAround(text, dr.index));

  const spam = /\b(?:spam\s*score|spam)\b\s*[:=-]?\s*(\d{1,3})\s*%?/i.exec(text);
  if (spam) set(quote, "spamScore", clamp(Number(spam[1]), 0, 100), lineAround(text, spam.index));

  const trafficAfter =
    /\b(?:monthly\s*)?(?:organic\s*)?traffic\b\s*[:=-]?\s*(\d[\d,.]*)\s*([km])?/i.exec(text);
  const trafficBefore =
    /(\d[\d,.]*)\s*([km])?\+?\s*(?:monthly\s*)?(?:organic\s*)?(?:visitors?|traffic|views?)\b/i.exec(
      text,
    );
  const traffic = trafficAfter ?? trafficBefore;
  if (traffic) {
    set(
      quote,
      "monthlyTraffic",
      scaleNumber(traffic[1] ?? "", traffic[2]),
      lineAround(text, traffic.index),
    );
  }

  // Horizontal whitespace only, throughout. With plain \s these patterns match
  // across a line break: "Traffic 40000" followed by "Word count 1000" read as
  // "40000 words", because \s* happily swallowed the newline between them.
  const words =
    // "800 words", "800-1200 words", "min 800 words"
    /\b(?:min(?:imum)?|at[^\S\n]*least|around|approx\w*)?[^\S\n]*(\d{3,5})[^\S\n]*(?:\+|-|–|to)?[^\S\n]*(?:\d{3,5})?[^\S\n]*words?\b/i.exec(
      text,
    ) ??
    // …and the label-first form a rate card uses: "Word count 1000".
    /\b(?:word[^\S\n]*count|article[^\S\n]*length)\b[^\S\n]*[:=-]?[^\S\n]*(\d{3,5})/i.exec(
      text,
    );
  if (words) set(quote, "wordCount", Number(words[1]), lineAround(text, words.index));

  const maxLinks =
    /\b(?:max(?:imum)?|up[^\S\n]*to|allow\w*|include[ds]?)[^\d\n]{0,15}?(\d{1,2})[^\S\n]*(?:do-?[^\S\n]?follow[^\S\n]*)?links?\b/i.exec(
      text,
    ) ??
    /\b(\d{1,2})[^\S\n]*links?[^\S\n]*(?:are[^\S\n]*)?(?:per|allowed|max|maximum|included|permitted)\b/i.exec(
      text,
    );
  if (maxLinks) {
    set(quote, "maxLinks", clamp(Number(maxLinks[1]), 1, 50), lineAround(text, maxLinks.index));
  } else {
    const worded = /\b(one|two|three|four|five)\s+(?:do-?\s?follow\s+)?links?\b/i.exec(text);
    if (worded) {
      const numbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      set(
        quote,
        "maxLinks",
        numbers[(worded[1] ?? "").toLowerCase()] ?? null,
        lineAround(text, worded.index),
      );
    }
  }

  readTat(text, quote);
}

function readTat(text: string, quote: ParsedQuote): void {
  const match =
    /\b(?:tat|turn\s*around|turnaround|delivery|deliver(?:ed)?|publish\w*|live|within|takes?)\b[^.\n]{0,25}?(\d{1,2})\s*(?:-|–|to)?\s*(\d{1,2})?\s*(business\s*)?(day|days|hrs?|hours?|week|weeks)\b/i.exec(
      text,
    );
  if (!match) return;

  // The far end of a range, not the near one: "3-5 days" is a promise of five.
  const value = Number(match[2] ?? match[1] ?? 0);
  const unit = (match[4] ?? "").toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || !unit) return;

  const days = unit.startsWith("h")
    ? Math.max(1, Math.ceil(value / 24))
    : unit.startsWith("w")
      ? value * 7
      : value;

  set(quote, "tatDays", clamp(days, 1, 365), lineAround(text, match.index));
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

function readTerms(text: string, quote: ParsedQuote): void {
  const dofollow = /\bdo[-\s]?follow\b/i.exec(text);
  const nofollow = /\bno[-\s]?follow\b/i.exec(text);
  const sponsored = /\b(rel\s*=\s*["']?sponsored|sponsored\s*link)\b/i.exec(text);

  // Whichever they said first: a rate card that offers dofollow and mentions
  // nofollow for restricted niches later is a dofollow deal.
  const linkType = [
    dofollow && { at: dofollow.index, value: "dofollow" },
    nofollow && { at: nofollow.index, value: "nofollow" },
    sponsored && { at: sponsored.index, value: "sponsored" },
  ]
    .filter((entry): entry is { at: number; value: string } => Boolean(entry))
    .sort((a, b) => a.at - b.at)[0];

  if (linkType) set(quote, "linkType", linkType.value, lineAround(text, linkType.at));

  // The placement they lead with, not whichever this list happens to name first.
  //
  // A real reply opened "Below are the discounted prices of guest post for…" and
  // listed a link insertion as one line item near the bottom; scanning in list
  // order recorded the whole deal as a link insertion. What a publisher offers
  // is what they say first — the rest are extras, and they are kept as their own
  // priced rows.
  const placements = PLACEMENTS.map(([pattern, placement]) => {
    const match = new RegExp(pattern.source, "i").exec(text);
    return match ? { at: match.index, placement } : null;
  })
    .filter((entry): entry is { at: number; placement: string } => Boolean(entry))
    .sort((a, b) => a.at - b.at);

  const leading = placements[0];
  if (leading) {
    set(quote, "placementType", leading.placement, lineAround(text, leading.at));
  }

  // "We" is the publisher and "you" is us — the text being read is theirs.
  const byPublisher =
    /\b(we|our\s+(?:team|writers?)|i)\s+(?:can\s+|will\s+|shall\s+)?(?:write|provide|create|prepare|arrange)\b[^.\n]{0,30}\b(content|article|post|copy)\b/i.exec(
      text,
    ) ?? /\bcontent\s+(?:is\s+)?(?:written|provided|created)\s+by\s+(?:us|our\s+team|me)\b/i.exec(text);

  const byUs =
    /\b(you|your\s+team|client)\s+(?:can\s+|will\s+|should\s+|may\s+)?(?:write|provide|send|supply|share)\b[^.\n]{0,30}\b(content|article|post|copy)\b/i.exec(
      text,
    ) ??
    /\b(content|article|post)\s+(?:is\s+)?(?:written|provided|supplied|sent)\s+by\s+(?:you|your\s+side|the\s+client)\b/i.exec(
      text,
    );

  if (byPublisher && byUs) {
    set(quote, "contentBy", "either", lineAround(text, Math.min(byPublisher.index, byUs.index)));
  } else if (byPublisher) {
    set(quote, "contentBy", "publisher", lineAround(text, byPublisher.index));
  } else if (byUs) {
    set(quote, "contentBy", "us", lineAround(text, byUs.index));
  }

  // Payment method is read from a line that is about payment.
  //
  // Searching the whole email for "crypto" found it in "Crypto & Forex: £400" —
  // a niche they price, not a way they want paying. Named services are
  // unambiguous anywhere; the currencies that double as niches are not.
  const NAMED = /\b(paypal|wise|transferwise|payoneer|bank\s*transfer|wire\s*transfer|stripe|revolut)\b/i;
  const AMBIGUOUS = /\b(usdt|bitcoin|btc|crypto)\b/i;

  const paymentLine = text
    .split(/\r?\n/)
    .find((line) => /\bpay(?:ment|able|ing)?\b|\binvoic\w*|\bbilling\b/i.test(line));

  const method =
    (paymentLine && (NAMED.exec(paymentLine) ?? AMBIGUOUS.exec(paymentLine))) ??
    NAMED.exec(text);

  if (method) {
    const source = paymentLine && method.input === paymentLine
      ? paymentLine
      : lineAround(text, method.index);
    set(quote, "paymentMethod", tidyMethod(method[1] ?? ""), source);
  }

  const percent = /\b(\d{1,3})\s*%\s*(advance|upfront|in\s*advance|deposit|prepayment)\b/i.exec(text);
  const net = /\bnet\s*(\d{1,3})\b/i.exec(text);
  const upfront = /\b(payment\s+)?(in\s+advance|upfront|advance\s+payment|prepay\w*|before\s+publi\w+)\b/i.exec(
    text,
  );
  const after = /\bafter\s+(publication|publishing|(?:it\s+goes?\s+)?live|the\s+post\s+is\s+live)\b/i.exec(
    text,
  );

  if (percent) {
    set(quote, "paymentTerms", `${percent[1]}% advance`, lineAround(text, percent.index));
  } else if (net) {
    set(quote, "paymentTerms", `Net ${net[1]}`, lineAround(text, net.index));
  } else if (upfront) {
    set(quote, "paymentTerms", "Payment in advance", lineAround(text, upfront.index));
  } else if (after) {
    set(quote, "paymentTerms", "Payment after publication", lineAround(text, after.index));
  }
}

function tidyMethod(raw: string): string {
  const value = raw.toLowerCase();
  if (value === "paypal") return "PayPal";
  if (value === "wise" || value === "transferwise") return "Wise";
  if (value === "payoneer") return "Payoneer";
  if (value === "stripe") return "Stripe";
  if (value === "revolut") return "Revolut";
  if (value.includes("transfer")) return "Bank transfer";
  return "Crypto";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function scaleNumber(digits: string, suffix: string | undefined): number {
  const base = Number(digits.replace(/[,\s]/g, ""));
  if (!Number.isFinite(base)) return 0;
  if (!suffix) return Math.round(base);
  return Math.round(base * (suffix.toLowerCase() === "m" ? 1_000_000 : 1_000));
}

/** The whole line a match sits on, which is what makes a value checkable. */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

/** How many fields a parse actually filled — nothing found is worth saying. */
export function countFound(quote: ParsedQuote): number {
  const scalars = [
    quote.linkType,
    quote.placementType,
    quote.tatDays,
    quote.da,
    quote.dr,
    quote.monthlyTraffic,
    quote.spamScore,
    quote.wordCount,
    quote.maxLinks,
    quote.contentBy,
    quote.paymentMethod,
    quote.paymentTerms,
  ].filter((value) => value !== null).length;

  return scalars + quote.prices.length;
}
