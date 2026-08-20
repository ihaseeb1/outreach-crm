/**
 * Pure-logic smoke tests — no network, no database.
 * Run with: npm run smoke
 *
 * Covers the pieces that are easy to get subtly wrong: robots.txt matching,
 * contact extraction from messy HTML, validation verdicts, and crypto round-trips.
 */

import assert from "node:assert/strict";

import {
  isEligible,
  mailboxForContact,
  pickMailbox,
  recordSend,
  remainingCapacity,
  type RotationMailbox,
} from "../src/campaigns/rotation";
import { copyName } from "../src/campaigns/duplicate";
import { canStartAnother } from "../src/mail/poll";
import {
  canonicalNiche,
  countFound,
  parseQuote,
  stripQuotedReply,
} from "../src/deals/parse-quote";
import {
  isWithinSendWindow,
  mailboxIsRested,
  nextSendAt,
  nextWindowOpening,
  resolveWindow,
} from "../src/campaigns/schedule";
import {
  buildExportGrid,
  gridToCsv,
  gridToTsv,
  nicheColumns,
  toApiShape,
} from "../src/deals/export";
import { matchesPriceFilters, parseDealFilters } from "../src/deals/query";
import { rate, scoreMailbox, type HealthSignals } from "../src/health/score";
import {
  buildDailySeries,
  buildFunnel,
  buildSeries,
  summariseByNiche,
  totals,
} from "../src/reports/metrics";
import type { DealWithPrices } from "../src/types/db";
import { encryptSecret, decryptSecret, safeEqual } from "../src/lib/crypto";
import { warmupMessage } from "../src/warmup/content";
import {
  nextVolume,
  pickPeer,
  poolIsViable,
  quotaRemaining,
  conversationLength,
  isConversationThread,
  resumeVolume,
  sendingAllowance,
  shouldContinueThread,
  shouldRampToday,
  shouldReply,
} from "../src/warmup/plan";
import { isValidWarmupToken, newWarmupToken } from "../src/warmup/token";
import { domainFromUrl, isRoleAccount, normalizeUrl, splitName } from "../src/lib/email";
import { addressRank, duplicateDomains, planDomainDedupe } from "../src/lib/domain-dedupe";
import { pairColumns, parseContactImport } from "../src/lib/import-parse";
import {
  classifyInbound,
  parseBounceBody,
  WARMUP_HEADER,
} from "../src/mail/inbound-classify";
import { contactVars, renderTemplate, templateVariables } from "../src/mail/template";
import {
  buildFooterText,
  unsubscribeHeaders,
  unsubscribeUrl,
  verifyUnsubscribeParams,
} from "../src/mail/unsubscribe";
import { extractFromHtml, isJunkEmail } from "../src/scraper/extract";
import { isAllowed, parseRobots } from "../src/scraper/robots";
import { isDisposableDomain } from "../src/validation/disposable";
import {
  MAX_REPORT_MAILBOX_WINDOW,
  MAX_VOLUME_WINDOW,
  REPORT_MAILBOX_WINDOWS,
  countsFor,
  summariseVolume,
  perDay,
  type SentRow,
  type VolumeWindow,
  type WindowCounts,
} from "../src/mailboxes/volume";
import {
  SOCIAL_KEYS,
  buildSignature,
  parseSocialKeys,
} from "../src/mail/signature";
import { parseReportRange, resolveReportRange } from "../src/reports/ranges";

// Set before any test runs; env values are read lazily inside the functions.
process.env.APP_ENCRYPTION_KEY ??= "0".repeat(64);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\nrobots.txt");

test("disallows a blocked path for the wildcard agent", () => {
  const policy = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/public/`);
  assert.equal(isAllowed(policy, "/private/secrets"), false);
  assert.equal(isAllowed(policy, "/private/public/page"), true);
  assert.equal(isAllowed(policy, "/about"), true);
});

test("a bare 'Disallow:' blocks nothing", () => {
  const policy = parseRobots("User-agent: *\nDisallow:");
  assert.equal(isAllowed(policy, "/anything"), true);
});

test("Disallow: / blocks the whole site", () => {
  const policy = parseRobots("User-agent: *\nDisallow: /");
  assert.equal(isAllowed(policy, "/"), false);
  assert.equal(isAllowed(policy, "/contact"), false);
});

test("missing robots.txt defaults to allow", () => {
  assert.equal(isAllowed({ groups: [], absent: true }, "/anything"), true);
});

test("wildcard patterns are honoured", () => {
  const policy = parseRobots("User-agent: *\nDisallow: /*.pdf$");
  assert.equal(isAllowed(policy, "/files/report.pdf"), false);
  assert.equal(isAllowed(policy, "/files/report.html"), true);
});

console.log("\nextraction");

test("pulls mailto addresses with names", () => {
  const html = `<html><body>
    <a href="mailto:jane.doe@publisher.com">Jane Doe</a>
  </body></html>`;
  const result = extractFromHtml(html, "https://publisher.com/contact");
  assert.equal(result.emails.length, 1);
  assert.equal(result.emails[0]!.email, "jane.doe@publisher.com");
  assert.equal(result.emails[0]!.firstName, "Jane");
  assert.equal(result.emails[0]!.lastName, "Doe");
});

test("finds plain-text and obfuscated addresses", () => {
  const html = `<html><body>
    <p>Write to editor@publisher.com</p>
    <p>Or press [at] publisher [dot] com</p>
  </body></html>`;
  const result = extractFromHtml(html, "https://publisher.com/");
  const found = result.emails.map((e) => e.email).sort();
  assert.deepEqual(found, ["editor@publisher.com", "press@publisher.com"]);
});

test("ignores script bodies and asset filenames", () => {
  const html = `<html><body>
    <script>var t="sentry_key@sentry.io"; var img="logo@2x.png";</script>
    <p>real@publisher.com</p>
  </body></html>`;
  const result = extractFromHtml(html, "https://publisher.com/");
  assert.deepEqual(result.emails.map((e) => e.email), ["real@publisher.com"]);
});

test("queues contact-ish internal links only", () => {
  const html = `<html><body>
    <a href="/write-for-us">Write for us</a>
    <a href="/blog/post-1">A post</a>
    <a href="https://other.com/contact">Elsewhere</a>
  </body></html>`;
  const result = extractFromHtml(html, "https://publisher.com/");
  assert.deepEqual(result.candidateLinks, ["https://publisher.com/write-for-us"]);
});

test("captures title, description, phone and socials", () => {
  const html = `<html><head>
      <title>Publisher</title>
      <meta name="description" content="We publish things." />
    </head><body>
      <a href="tel:+441234567890">Call</a>
      <a href="https://twitter.com/publisher">Twitter</a>
    </body></html>`;
  const result = extractFromHtml(html, "https://publisher.com/");
  assert.equal(result.title, "Publisher");
  assert.equal(result.description, "We publish things.");
  assert.equal(result.phones[0], "+441234567890");
  assert.equal(result.social.twitter, "https://twitter.com/publisher");
});

test("junk filter rejects assets and placeholder domains", () => {
  assert.equal(isJunkEmail("logo@2x.png"), true);
  assert.equal(isJunkEmail("someone@example.com"), true);
  assert.equal(isJunkEmail("hello@realsite.io"), false);
});

console.log("\nvalidation helpers");

test("disposable domains are caught", () => {
  assert.equal(isDisposableDomain("someone@mailinator.com"), true);
  assert.equal(isDisposableDomain("someone@realsite.io"), false);
});

test("role accounts are recognised", () => {
  assert.equal(isRoleAccount("editor@site.com"), true);
  assert.equal(isRoleAccount("info2@site.com"), true);
  assert.equal(isRoleAccount("jane.doe@site.com"), false);
});

console.log("\nurl + name helpers");

test("normalises bare domains and strips fragments", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("https://example.com/x#y"), "https://example.com/x");
  assert.equal(domainFromUrl("https://www.Example.com/path"), "example.com");
});

test("splits names", () => {
  assert.deepEqual(splitName("Jane Van Doe"), { first: "Jane", last: "Van Doe" });
  assert.deepEqual(splitName(null), { first: null, last: null });
});

console.log("\ncrypto");

test("encrypt/decrypt round-trips", () => {
  const secret = "app-password-1234";
  const sealed = encryptSecret(secret);
  assert.notEqual(sealed, secret);
  assert.equal(decryptSecret(sealed), secret);
});

test("tampered ciphertext fails to decrypt", () => {
  const sealed = encryptSecret("secret");
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join(".")));
});

test("safeEqual compares correctly", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

console.log("\ninbound classification");

test("warmup header keeps mail out of the inbox", () => {
  const result = classifyInbound({
    fromEmail: "peer@mine.com",
    subject: "Re: quick note",
    text: "sure thing",
    headers: { [WARMUP_HEADER]: "signed-token" },
  });
  assert.equal(result.kind, "warmup");
});

test("mail from one of my own mailboxes is internal", () => {
  const result = classifyInbound({
    fromEmail: "second@mine.com",
    subject: "Re: catching up",
    text: "yes",
    headers: {},
    ownMailboxes: new Set(["second@mine.com", "third@mine.com"]),
  });
  assert.equal(result.kind, "warmup");
});

test("mailer-daemon is a bounce, with the failed address extracted", () => {
  const dsn = [
    "Final-Recipient: rfc822; missing@publisher.com",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
  ].join("\n");
  const result = classifyInbound({
    fromEmail: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    text: dsn,
    headers: {},
  });
  assert.equal(result.kind, "bounce");
  assert.equal(result.bouncedRecipient, "missing@publisher.com");
  assert.equal(result.bounceType, "hard");
});

test("a temporary failure is soft, so it is not suppressed", () => {
  const { type } = parseBounceBody(
    "Final-Recipient: rfc822; busy@publisher.com\nStatus: 4.2.2\n",
  );
  assert.equal(type, "soft");
});

test("wording-only bounces are still detected as hard", () => {
  const { type, recipient } = parseBounceBody(
    "Your message to <gone@publisher.com> could not be delivered: mailbox does not exist",
  );
  assert.equal(type, "hard");
  assert.equal(recipient, "gone@publisher.com");
});

test("out-of-office is an auto-reply, not a real reply", () => {
  const result = classifyInbound({
    fromEmail: "editor@publisher.com",
    subject: "Automatic reply: Quick question",
    text: "I am away until Monday.",
    headers: { "auto-submitted": "auto-replied" },
  });
  assert.equal(result.kind, "auto_reply");
});

test("a genuine reply classifies as a reply", () => {
  const result = classifyInbound({
    fromEmail: "editor@publisher.com",
    subject: "Re: Quick question about publisher.com",
    text: "Sure — our rate is $150 for a general niche post.",
    headers: {},
    ownMailboxes: new Set(["me@mine.com"]),
  });
  assert.equal(result.kind, "reply");
});

console.log("\ntemplating");

test("renders variables and falls back", () => {
  const vars = contactVars({
    email: "editor@publisher.com",
    first_name: null,
    last_name: null,
    website: "https://publisher.com",
    domain: "publisher.com",
    phone: null,
  });
  assert.equal(
    renderTemplate("Hi {{first_name|there}}, about {{domain}}", vars),
    "Hi there, about publisher.com",
  );
});

test("a missing variable never leaks the raw token", () => {
  const output = renderTemplate("Hello {{nickname}}!", {});
  assert.equal(output, "Hello !");
  assert.ok(!output.includes("{{"));
});

test("lists referenced variables", () => {
  assert.deepEqual(
    templateVariables("{{first_name|there}} at {{domain}}").sort(),
    ["domain", "first_name"],
  );
});

console.log("\nunsubscribe links");

test("round-trips a signed unsubscribe token", () => {
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const url = new URL(unsubscribeUrl(workspaceId, "Editor@Publisher.com"));
  const token = verifyUnsubscribeParams(url.searchParams);
  assert.ok(token);
  assert.equal(token.workspaceId, workspaceId);
  assert.equal(token.email, "editor@publisher.com");
});

test("a tampered address is rejected", () => {
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const url = new URL(unsubscribeUrl(workspaceId, "editor@publisher.com"));
  url.searchParams.set(
    "e",
    Buffer.from("someone-else@publisher.com").toString("base64url"),
  );
  assert.equal(verifyUnsubscribeParams(url.searchParams), null);
});

test("one-click headers opt into RFC 8058", () => {
  const headers = unsubscribeHeaders("ws", "editor@publisher.com");
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(headers["List-Unsubscribe"]!, /^<https?:\/\/.+>$/);
});

test("the CAN-SPAM footer carries the address and the opt-out", () => {
  const footer = buildFooterText({
    workspaceId: "ws",
    recipientEmail: "editor@publisher.com",
    postalAddress: "Acme Ltd, 1 Example St, London",
  });
  assert.ok(footer.includes("Acme Ltd, 1 Example St, London"));
  assert.ok(footer.includes("/api/unsubscribe?"));
});

console.log("\nsend windows");

const WEEKDAY_9_TO_5 = resolveWindow({
  send_window_start: 9,
  send_window_end: 17,
  send_days: [1, 2, 3, 4, 5],
  timezone: "UTC",
});

test("inside the window on a Tuesday morning", () => {
  // 2026-08-18 is a Tuesday.
  assert.equal(
    isWithinSendWindow(new Date("2026-08-18T10:00:00Z"), WEEKDAY_9_TO_5),
    true,
  );
});

test("outside the window at night and at weekends", () => {
  assert.equal(
    isWithinSendWindow(new Date("2026-08-18T03:00:00Z"), WEEKDAY_9_TO_5),
    false,
  );
  // 2026-08-16 is a Sunday.
  assert.equal(
    isWithinSendWindow(new Date("2026-08-16T10:00:00Z"), WEEKDAY_9_TO_5),
    false,
  );
});

test("the window follows the configured timezone", () => {
  const tokyo = resolveWindow({
    send_window_start: 9,
    send_window_end: 17,
    send_days: [1, 2, 3, 4, 5],
    timezone: "Asia/Tokyo",
  });
  // 01:00 UTC Tuesday is 10:00 Tuesday in Tokyo.
  assert.equal(isWithinSendWindow(new Date("2026-08-18T01:00:00Z"), tokyo), true);
  // 10:00 UTC is 19:00 in Tokyo — after hours.
  assert.equal(isWithinSendWindow(new Date("2026-08-18T10:00:00Z"), tokyo), false);
});

test("a weekend send is pushed to Monday morning", () => {
  const opening = nextWindowOpening(
    new Date("2026-08-16T12:00:00Z"),
    WEEKDAY_9_TO_5,
  );
  assert.equal(isWithinSendWindow(opening, WEEKDAY_9_TO_5), true);
  assert.equal(opening.getUTCDay(), 1);
  assert.equal(opening.getUTCHours(), 9);
});

test("an inverted window falls back instead of never sending", () => {
  const broken = resolveWindow({ send_window_start: 18, send_window_end: 9 });
  assert.ok(broken.endHour > broken.startHour);
  // And the fallback is a window that actually opens.
  assert.equal(
    isWithinSendWindow(new Date("2026-08-18T10:00:00Z"), broken),
    true,
  );
});

test("an empty day list falls back to weekdays", () => {
  assert.deepEqual(resolveWindow({ send_days: [] }).days, [1, 2, 3, 4, 5]);
});

test("follow-ups land the right number of days later, inside the window", () => {
  const when = nextSendAt({
    from: new Date("2026-08-18T10:00:00Z"),
    delayDays: 3,
    window: WEEKDAY_9_TO_5,
    random: () => 0.5,
  });
  assert.ok(when.getTime() > new Date("2026-08-21T00:00:00Z").getTime());
  assert.equal(isWithinSendWindow(when, WEEKDAY_9_TO_5), true);
});

test("two contacts on the same step do not fire at the same instant", () => {
  const from = new Date("2026-08-18T09:00:00Z");
  const a = nextSendAt({ from, delayDays: 0, window: WEEKDAY_9_TO_5, random: () => 0.1 });
  const b = nextSendAt({ from, delayDays: 0, window: WEEKDAY_9_TO_5, random: () => 0.9 });
  assert.notEqual(a.getTime(), b.getTime());
});

test("a mailbox must rest between sends", () => {
  const now = new Date("2026-08-18T10:00:00Z");
  const justSent = new Date(now.getTime() - 10_000).toISOString();
  const longAgo = new Date(now.getTime() - 600_000).toISOString();
  assert.equal(mailboxIsRested(justSent, 90, 300, now, () => 0.5), false);
  assert.equal(mailboxIsRested(longAgo, 90, 300, now, () => 0.5), true);
  assert.equal(mailboxIsRested(null, 90, 300, now, () => 0.5), true);
});

console.log("\nmailbox rotation");

const NOW = new Date("2026-08-18T10:00:00Z");
const TODAY = NOW.toISOString().slice(0, 10);

function mailbox(overrides: Partial<RotationMailbox> & { id: string }): RotationMailbox {
  return {
    email: `${overrides.id}@mine.com`,
    daily_limit: 50,
    sent_today: 0,
    sent_today_date: TODAY,
    min_gap_seconds: 90,
    max_gap_seconds: 300,
    last_send_at: null,
    is_active: true,
    health_status: "healthy",
    ...overrides,
  };
}

test("a mailbox at its daily limit is skipped", () => {
  const full = mailbox({ id: "a", sent_today: 50, daily_limit: 50 });
  assert.equal(isEligible(full, { now: NOW }), false);
});

test("yesterday's count does not block today", () => {
  const stale = mailbox({
    id: "a",
    sent_today: 50,
    sent_today_date: "2026-08-17",
  });
  assert.equal(isEligible(stale, { now: NOW }), true);
});

test("inactive and health-paused mailboxes never send", () => {
  assert.equal(isEligible(mailbox({ id: "a", is_active: false }), { now: NOW }), false);
  assert.equal(
    isEligible(mailbox({ id: "b", health_status: "paused" }), { now: NOW }),
    false,
  );
  // A warning is not a stop — it still sends while you investigate.
  assert.equal(
    isEligible(mailbox({ id: "c", health_status: "warning" }), { now: NOW }),
    true,
  );
});

test("rotation spreads load across every connected mailbox", () => {
  const pool = [
    mailbox({ id: "a", sent_today: 40 }),
    mailbox({ id: "b", sent_today: 5 }),
    mailbox({ id: "c", sent_today: 20 }),
    mailbox({ id: "d", sent_today: 12 }),
  ];
  assert.equal(pickMailbox(pool, { now: NOW })?.id, "b");
});

test("ties break towards the mailbox idle longest", () => {
  const pool = [
    mailbox({ id: "a", last_send_at: "2026-08-18T09:50:00Z" }),
    mailbox({ id: "b", last_send_at: "2026-08-18T08:00:00Z" }),
  ];
  assert.equal(pickMailbox(pool, { now: NOW, ignoreRest: true })?.id, "b");
});

test("a contact keeps its original mailbox for follow-ups", () => {
  const pool = [mailbox({ id: "a" }), mailbox({ id: "b" })];
  assert.equal(mailboxForContact("b", pool, { now: NOW }).mailbox?.id, "b");
});

test("when the assigned mailbox is full we wait rather than switch sender", () => {
  const pool = [
    mailbox({ id: "a" }),
    mailbox({ id: "b", sent_today: 50, daily_limit: 50 }),
  ];
  const result = mailboxForContact("b", pool, { now: NOW });
  assert.equal(result.mailbox, null);
  assert.equal(result.waiting, true);
});

test("no eligible mailbox returns null instead of overshooting a limit", () => {
  const pool = [mailbox({ id: "a", sent_today: 50, daily_limit: 50 })];
  assert.equal(pickMailbox(pool, { now: NOW }), null);
});

console.log("\nwarmup planning");

test("the ramp climbs by the increment and stops at the target", () => {
  assert.equal(nextVolume({ current: 5, target: 40, increment: 2 }), 7);
  assert.equal(nextVolume({ current: 39, target: 40, increment: 5 }), 40);
  assert.equal(nextVolume({ current: 40, target: 40, increment: 5 }), 40);
});

test("the ramp advances at most once a day", () => {
  assert.equal(shouldRampToday("2026-08-16", "2026-08-16"), false);
  assert.equal(shouldRampToday("2026-08-15", "2026-08-16"), true);
  assert.equal(shouldRampToday(null, "2026-08-16"), true);
});

test("recovering from a pause restarts low instead of spiking", () => {
  assert.equal(resumeVolume(38), 5);
  assert.equal(resumeVolume(3), 3);
});

test("warmup needs at least two mailboxes to form a loop", () => {
  assert.equal(poolIsViable(1), false);
  assert.equal(poolIsViable(2), true);
  assert.equal(poolIsViable(9), true);
});

test("a peer is picked from those least recently written to", () => {
  const pool = [
    { id: "a", email: "a@mine.com", lastReceivedAt: "2026-08-16T10:00:00Z" },
    { id: "b", email: "b@mine.com", lastReceivedAt: "2026-08-10T10:00:00Z" },
    { id: "c", email: "c@mine.com", lastReceivedAt: null },
    { id: "d", email: "d@mine.com", lastReceivedAt: "2026-08-15T10:00:00Z" },
  ];
  // Never itself, and drawn from the stalest half.
  const chosen = pickPeer(pool, "a", () => 0);
  assert.equal(chosen?.id, "c");
  assert.notEqual(pickPeer(pool, "a", () => 0.99)?.id, "a");
});

test("a single-mailbox pool has nobody to warm up with", () => {
  assert.equal(
    pickPeer([{ id: "a", email: "a@mine.com", lastReceivedAt: null }], "a"),
    null,
  );
});

test("quota never goes negative", () => {
  assert.equal(quotaRemaining(10, 3), 7);
  assert.equal(quotaRemaining(10, 14), 0);
});

test("reply rate is honoured and never exceeds its bounds", () => {
  assert.equal(shouldReply(0.35, () => 0.2), true);
  assert.equal(shouldReply(0.35, () => 0.9), false);
  assert.equal(shouldReply(0, () => 0), false);
  assert.equal(shouldReply(1, () => 0.999), true);
});

test("warmup content varies rather than repeating one template", () => {
  const a = warmupMessage(() => 0.1);
  const b = warmupMessage(() => 0.8);
  assert.notEqual(a.subject, b.subject);
  assert.ok(a.body.length > 20);
});

test("a warmup token verifies only for its own workspace", () => {
  const token = newWarmupToken("ws-1");
  assert.equal(isValidWarmupToken("ws-1", token), true);
  assert.equal(isValidWarmupToken("ws-2", token), false);
  assert.equal(isValidWarmupToken("ws-1", "forged.token"), false);
});

console.log("\nhealth scoring");

const CLEAN: HealthSignals = {
  sent7d: 200,
  bounceRate: 0,
  complaintRate: 0,
  warmupSpamRate: 0,
  spfOk: true,
  dkimOk: true,
  dmarcOk: true,
  blacklists: [],
};

test("a clean mailbox scores 100 and stays healthy", () => {
  const verdict = scoreMailbox(CLEAN);
  assert.equal(verdict.score, 100);
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.issues, []);
});

test("a high bounce rate pauses the mailbox", () => {
  const verdict = scoreMailbox({ ...CLEAN, bounceRate: 0.12 });
  assert.equal(verdict.status, "paused");
  assert.ok(verdict.score < 70);
});

test("a moderate bounce rate warns without stopping sending", () => {
  assert.equal(scoreMailbox({ ...CLEAN, bounceRate: 0.05 }).status, "warning");
});

test("low volume never pauses on a noisy rate", () => {
  // 1 bounce out of 3 sends is 33% — meaningless, and must not pause.
  const verdict = scoreMailbox({ ...CLEAN, sent7d: 3, bounceRate: 0.33 });
  assert.equal(verdict.status, "warning");
});

test("a blacklisting pauses immediately", () => {
  const verdict = scoreMailbox({ ...CLEAN, blacklists: ["Spamhaus DBL"] });
  assert.equal(verdict.status, "paused");
  assert.match(verdict.issues.join(" "), /Spamhaus/);
});

test("warmup landing in spam escalates from warning to pause", () => {
  assert.equal(scoreMailbox({ ...CLEAN, warmupSpamRate: 0.3 }).status, "warning");
  assert.equal(scoreMailbox({ ...CLEAN, warmupSpamRate: 0.7 }).status, "paused");
});

test("missing DNS auth warns but never pauses — pausing would not fix it", () => {
  const verdict = scoreMailbox({
    ...CLEAN,
    spfOk: false,
    dkimOk: false,
    dmarcOk: false,
  });
  assert.equal(verdict.status, "warning");
  assert.equal(verdict.issues.length, 3);
});

test("complaints are judged on a far tighter threshold than bounces", () => {
  assert.equal(scoreMailbox({ ...CLEAN, complaintRate: 0.002 }).status, "warning");
  assert.equal(scoreMailbox({ ...CLEAN, complaintRate: 0.01 }).status, "paused");
});

test("the score is clamped to 0–100", () => {
  const verdict = scoreMailbox({
    sent7d: 500,
    bounceRate: 0.5,
    complaintRate: 0.5,
    warmupSpamRate: 1,
    spfOk: false,
    dkimOk: false,
    dmarcOk: false,
    blacklists: ["Spamhaus DBL", "SURBL"],
  });
  assert.ok(verdict.score >= 0);
  assert.equal(verdict.status, "paused");
});

test("rate() is safe when nothing has been sent", () => {
  assert.equal(rate(0, 0), 0);
  assert.equal(rate(3, 0), 0);
  assert.equal(rate(1, 4), 0.25);
});

console.log("\ndeal export");

function deal(
  domain: string,
  prices: { niche: string; price: number }[],
  overrides: Partial<DealWithPrices> = {},
): DealWithPrices {
  return {
    id: `id-${domain}`,
    workspace_id: "ws",
    contact_id: `contact-${domain}`,
    conversation_id: null,
    domain,
    link_type: "dofollow",
    placement_type: "guest post",
    tat_days: 7,
    da: 40,
    dr: 55,
    monthly_traffic: 12000,
    spam_score: 2,
    word_count: 1000,
    content_by: "us",
    max_links: 2,
    payment_terms: "50% upfront",
    payment_method: "PayPal",
    currency: "USD",
    status: "negotiating",
    notes: null,
    created_by: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
    deal_prices: prices.map((price, index) => ({
      id: `price-${domain}-${index}`,
      deal_id: `id-${domain}`,
      niche: price.niche,
      price: price.price,
      currency: "USD",
      created_at: "2026-08-01T00:00:00Z",
    })),
    ...overrides,
  };
}

test("a column is created for every niche across the export", () => {
  const grid = buildExportGrid([
    deal("a.com", [{ niche: "General", price: 150 }]),
    deal("b.com", [
      { niche: "Casino", price: 400 },
      { niche: "CBD", price: 350 },
    ]),
  ]);
  assert.ok(grid.headers.includes("General price"));
  assert.ok(grid.headers.includes("Casino price"));
  assert.ok(grid.headers.includes("CBD price"));
  assert.equal(grid.rows.length, 2);
});

test("common niches keep a stable leading order", () => {
  const niches = nicheColumns([
    deal("a.com", [
      { niche: "Zebra", price: 10 },
      { niche: "Casino", price: 400 },
      { niche: "General", price: 150 },
    ]),
  ]);
  assert.deepEqual(niches, ["General", "Casino", "Zebra"]);
});

test("a niche a publisher does not quote is blank, not zero", () => {
  const grid = buildExportGrid([
    deal("a.com", [{ niche: "General", price: 150 }]),
    deal("b.com", [{ niche: "Casino", price: 400 }]),
  ]);
  const generalIndex = grid.headers.indexOf("General price");
  // b.com quoted no General price — must not read as free.
  assert.equal(grid.rows[1]?.[generalIndex], null);
  assert.equal(grid.rows[0]?.[generalIndex], 150);
});

test("the contact email is carried into the export", () => {
  const grid = buildExportGrid([deal("a.com", [{ niche: "General", price: 150 }])], {
    contactEmails: new Map([["contact-a.com", "editor@a.com"]]),
  });
  assert.ok(grid.rows[0]?.includes("editor@a.com"));
});

test("TSV stays column-aligned even with messy text", () => {
  const grid = buildExportGrid([
    deal("a.com", [{ niche: "General", price: 150 }], {
      notes: "Line one\nLine two\twith a tab",
    }),
  ]);
  const lines = gridToTsv(grid).split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.split("\t").length, lines[1]?.split("\t").length);
});

test("CSV quotes commas and quotes correctly", () => {
  const grid = buildExportGrid([
    deal("a.com", [{ niche: "General", price: 150 }], {
      notes: 'Says "yes", eventually',
    }),
  ]);
  assert.ok(gridToCsv(grid).includes('"Says ""yes"", eventually"'));
});

test("the API shape groups metrics, content and payment", () => {
  const shaped = toApiShape(
    deal("a.com", [{ niche: "General", price: 150 }]),
    "editor@a.com",
  );
  assert.equal(shaped.domain, "a.com");
  assert.equal(shaped.contact_email, "editor@a.com");
  assert.equal(shaped.metrics.dr, 55);
  assert.equal(shaped.payment.method, "PayPal");
  assert.deepEqual(shaped.prices, [
    { niche: "General", price: 150, currency: "USD" },
  ]);
});

console.log("\ndeal filtering");

test("a price range matches only within the named niche", () => {
  const subject = deal("a.com", [
    { niche: "General", price: 150 },
    { niche: "Casino", price: 900 },
  ]);
  assert.equal(
    matchesPriceFilters(subject, { niche: "Casino", maxPrice: 500 }),
    false,
  );
  assert.equal(
    matchesPriceFilters(subject, { niche: "General", maxPrice: 500 }),
    true,
  );
});

test("a publisher who does not quote the niche is excluded", () => {
  const subject = deal("a.com", [{ niche: "General", price: 150 }]);
  assert.equal(matchesPriceFilters(subject, { niche: "Casino" }), false);
});

test("no price filter matches everything, including empty rate cards", () => {
  assert.equal(matchesPriceFilters(deal("a.com", []), {}), true);
});

test("filters parse from query params, ignoring junk", () => {
  const parsed = parseDealFilters(
    new URLSearchParams("status=live&min_price=100&max_tat=abc&niche=CBD"),
  );
  assert.equal(parsed.status, "live");
  assert.equal(parsed.minPrice, 100);
  assert.equal(parsed.maxTat, undefined);
  assert.equal(parsed.niche, "CBD");
});

console.log("\nreporting");

test("totals compute reply and bounce rates", () => {
  const summary = totals([
    { date: "2026-08-14", sent: 100, replies: 8, bounces: 2 },
    { date: "2026-08-15", sent: 100, replies: 12, bounces: 4 },
  ]);
  assert.equal(summary.sent, 200);
  assert.equal(summary.replyRate, 0.1);
  assert.equal(summary.bounceRate, 0.03);
});

test("a period with no sends reports 0%, not NaN", () => {
  const summary = totals([{ date: "2026-08-14", sent: 0, replies: 0, bounces: 0 }]);
  assert.equal(summary.replyRate, 0);
  assert.ok(Number.isFinite(summary.bounceRate));
});

test("the day series is dense, so quiet days show as zero", () => {
  const series = buildDailySeries(
    3,
    {
      sent: ["2026-08-16T10:00:00Z", "2026-08-16T11:00:00Z"],
      replies: ["2026-08-14T09:00:00Z"],
      bounces: [],
    },
    new Date("2026-08-16T12:00:00Z"),
  );
  assert.equal(series.length, 3);
  assert.deepEqual(
    series.map((point) => point.date),
    ["2026-08-14", "2026-08-15", "2026-08-16"],
  );
  assert.equal(series[2]?.sent, 2);
  assert.equal(series[1]?.sent, 0);
  assert.equal(series[0]?.replies, 1);
});

test("timestamps outside the window are ignored, not misfiled", () => {
  const series = buildDailySeries(
    2,
    { sent: ["2026-01-01T10:00:00Z"], replies: [], bounces: [] },
    new Date("2026-08-16T12:00:00Z"),
  );
  assert.equal(series.reduce((total, point) => total + point.sent, 0), 0);
});

test("niche summary counts agreed, ordered and live as won", () => {
  const summary = summariseByNiche([
    { niche: "General", price: 150, status: "live" },
    { niche: "General", price: 250, status: "negotiating" },
    { niche: "Casino", price: 400, status: "ordered" },
    { niche: "Casino", price: 600, status: "rejected" },
  ]);

  const general = summary.find((row) => row.niche === "General")!;
  assert.equal(general.quoted, 2);
  assert.equal(general.won, 1);
  assert.equal(general.wonValue, 150);
  assert.equal(general.averagePrice, 200);
  assert.equal(general.lowestPrice, 150);
  assert.equal(general.highestPrice, 250);

  const casino = summary.find((row) => row.niche === "Casino")!;
  assert.equal(casino.wonValue, 400);
});

test("niches are ordered by won value", () => {
  const summary = summariseByNiche([
    { niche: "Small", price: 50, status: "live" },
    { niche: "Big", price: 900, status: "live" },
  ]);
  assert.equal(summary[0]?.niche, "Big");
});

test("the funnel converts each step against the previous one", () => {
  const funnel = buildFunnel({
    contacted: 200,
    replied: 40,
    dealsLogged: 20,
    dealsWon: 5,
  });
  assert.equal(funnel[1]?.rate, 0.2);
  assert.equal(funnel[2]?.rate, 0.5);
  assert.equal(funnel[3]?.rate, 0.25);
});

test("an empty funnel does not divide by zero", () => {
  const funnel = buildFunnel({ contacted: 0, replied: 0, dealsLogged: 0, dealsWon: 0 });
  assert.ok(funnel.every((step) => Number.isFinite(step.rate)));
});

console.log("\ncontact import parsing");

test("reads a spreadsheet paste with tab-separated website and email", () => {
  const result = parseContactImport("https://example.com\tjane@example.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.email, "jane@example.com");
  assert.equal(result.rows[0]?.domain, "example.com");
  assert.ok(result.rows[0]?.website?.includes("example.com"));
});

test("reads comma separated, in either order", () => {
  const a = parseContactImport("example.com, jane@example.com");
  const b = parseContactImport("jane@example.com, example.com");
  assert.equal(a.rows[0]?.email, "jane@example.com");
  assert.equal(b.rows[0]?.email, "jane@example.com");
  assert.equal(a.rows[0]?.domain, "example.com");
  assert.equal(b.rows[0]?.domain, "example.com");
});

test("an email on its own derives the domain from the address", () => {
  const result = parseContactImport("editor@blog.co.uk");
  assert.equal(result.rows[0]?.domain, "blog.co.uk");
  assert.equal(result.rows[0]?.website, null);
});

test("a website on its own is queued for scraping, not made a contact", () => {
  const result = parseContactImport("https://nocontact.com");
  assert.equal(result.rows.length, 0);
  assert.equal(result.websitesOnly.length, 1);
});

test("a name is kept whole when a real separator is present", () => {
  const result = parseContactImport("Jane Doe, example.com, jane@example.com");
  assert.equal(result.rows[0]?.firstName, "Jane");
  assert.equal(result.rows[0]?.lastName, "Doe");
});

test("space separated still splits when there is no other separator", () => {
  const result = parseContactImport("example.com jane@example.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.email, "jane@example.com");
});

test("a spreadsheet header row is ignored", () => {
  const result = parseContactImport("Website\tEmail\nexample.com\tjane@example.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.length, 0);
});

test("numeric metric columns are not mistaken for names", () => {
  const result = parseContactImport("example.com\tjane@example.com\t55\t72");
  assert.equal(result.rows[0]?.firstName, null);
  assert.equal(result.rows[0]?.lastName, null);
});

test("duplicate addresses collapse to one row", () => {
  const result = parseContactImport("jane@example.com\nJANE@example.com");
  assert.equal(result.rows.length, 1);
});

test("angle brackets and trailing punctuation are stripped", () => {
  const result = parseContactImport("<jane@example.com>,");
  assert.equal(result.rows[0]?.email, "jane@example.com");
});

test("a junk line is reported rather than silently dropped", () => {
  const result = parseContactImport("just some words here");
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.length, 1);
});


console.log("\npaired column import");

test("pairs two columns line by line", () => {
  const result = pairColumns(
    "example.com\nanother.co.uk",
    "jane@example.com\neditor@another.co.uk",
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.email, "jane@example.com");
  assert.equal(result.rows[0]?.domain, "example.com");
  assert.equal(result.rows[1]?.domain, "another.co.uk");
});

test("a blank cell mid-column does not shift later rows", () => {
  const result = pairColumns(
    "first.com\n\nthird.com",
    "a@first.com\nb@orphan.com\nc@third.com",
  );
  assert.equal(result.rows.length, 3);
  // b@ had no website, so its domain falls back to the address, and c@ must
  // still be paired with third.com rather than being pulled up a row.
  assert.equal(result.rows[1]?.domain, "orphan.com");
  assert.equal(result.rows[2]?.domain, "third.com");
});

test("more websites than emails queues the leftovers for scraping", () => {
  const result = pairColumns("a.com\nb.com\nc.com", "one@a.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.websitesOnly.length, 2);
});

test("more emails than websites still creates every contact", () => {
  const result = pairColumns("a.com", "one@a.com\ntwo@b.com\nthree@c.com");
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[1]?.website, null);
  assert.equal(result.rows[1]?.domain, "b.com");
});

test("emails only is a valid import", () => {
  const result = pairColumns("", "solo@example.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.website, null);
});

test("websites only becomes a scrape queue, not contacts", () => {
  const result = pairColumns("a.com\nb.com", "");
  assert.equal(result.rows.length, 0);
  assert.equal(result.websitesOnly.length, 2);
});

test("matching header rows on both columns are dropped together", () => {
  const result = pairColumns("Website\nexample.com", "Email\njane@example.com");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.domain, "example.com");
});

test("trailing blank lines from a spreadsheet copy are ignored", () => {
  const result = pairColumns("a.com\n\n\n", "one@a.com\n\n\n");
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.length, 0);
});

test("a malformed address is reported with its row number", () => {
  const result = pairColumns("a.com", "not-an-email");
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0]?.line.includes("row 1"));
});

test("duplicate addresses across rows collapse to one", () => {
  const result = pairColumns("a.com\nb.com", "same@x.com\nSAME@x.com");
  assert.equal(result.rows.length, 1);
});


console.log("\nwarmup-aware sending allowance");

test("a mailbox with no warmup row keeps its configured limit", () => {
  assert.equal(sendingAllowance(50, null), 50);
});

test("warmup switched off is an explicit choice and is not overridden", () => {
  assert.equal(
    sendingAllowance(50, { enabled: false, currentDailyVolume: 5, targetDailyVolume: 40 }),
    50,
  );
});

test("while ramping, real sending is held to the volume reached so far", () => {
  assert.equal(
    sendingAllowance(50, { enabled: true, currentDailyVolume: 7, targetDailyVolume: 40 }),
    7,
  );
});

test("a limit below the warmed volume still wins — it is the stricter of the two", () => {
  assert.equal(
    sendingAllowance(3, { enabled: true, currentDailyVolume: 20, targetDailyVolume: 40 }),
    3,
  );
});

test("once the ramp reaches target the configured limit applies again", () => {
  assert.equal(
    sendingAllowance(50, { enabled: true, currentDailyVolume: 40, targetDailyVolume: 40 }),
    50,
  );
});

test("a mailbox reset to zero after a health pause sends nothing until it climbs", () => {
  assert.equal(
    sendingAllowance(50, { enabled: true, currentDailyVolume: 0, targetDailyVolume: 40 }),
    0,
  );
});


console.log("\nmailbox failover");

const healthyBox = (id: string, lastSend: string | null = null): RotationMailbox => ({
  id,
  email: `${id}@example.com`,
  daily_limit: 50,
  sent_today: 0,
  sent_today_date: new Date().toISOString().slice(0, 10),
  min_gap_seconds: 10,
  max_gap_seconds: 10,
  last_send_at: lastSend,
  is_active: true,
  health_status: "healthy",
});

test("a follow-up stays on its assigned mailbox while that mailbox is usable", () => {
  const pool = [healthyBox("a"), healthyBox("b")];
  const result = mailboxForContact("a", pool, { ignoreRest: true });
  assert.equal(result.mailbox?.id, "a");
  assert.equal(result.switched, false);
});

test("a mailbox merely resting is waited for, not swapped out", () => {
  const resting = { ...healthyBox("a"), last_send_at: new Date().toISOString() };
  const pool = [resting, healthyBox("b")];
  const result = mailboxForContact("a", pool, { now: new Date() });
  assert.equal(result.mailbox, null);
  assert.equal(result.waiting, true);
  assert.equal(result.switched, false);
});

test("a mailbox at its daily cap is waited for, not swapped out", () => {
  const full = { ...healthyBox("a"), sent_today: 50 };
  const pool = [full, healthyBox("b")];
  const result = mailboxForContact("a", pool, { ignoreRest: true });
  assert.equal(result.mailbox, null);
  assert.equal(result.waiting, true);
  assert.equal(result.switched, false);
});

test("a mailbox absent from the pool hands the step to a healthy one", () => {
  // loadMailboxes filters out paused and inactive mailboxes, so 'gone' is how
  // a health-paused mailbox presents itself here.
  const pool = [healthyBox("b")];
  const result = mailboxForContact("a", pool, { ignoreRest: true });
  assert.equal(result.mailbox?.id, "b");
  assert.equal(result.switched, true);
  assert.equal(result.waiting, false);
});

test("with nothing healthy left it waits rather than inventing a sender", () => {
  const result = mailboxForContact("a", [], { ignoreRest: true });
  assert.equal(result.mailbox, null);
  assert.equal(result.waiting, true);
  assert.equal(result.switched, false);
});

test("a first send with no assignment is not a switch", () => {
  const result = mailboxForContact(null, [healthyBox("a")], { ignoreRest: true });
  assert.equal(result.mailbox?.id, "a");
  assert.equal(result.switched, false);
});


console.log("\nwarmup conversation threads");

test("the original message is always eligible for its single reply", () => {
  // Depth 1 is the ordinary case and must not depend on the conversation draw.
  assert.equal(shouldContinueThread(1, "anything@example.com"), true);
  assert.equal(shouldContinueThread(1, null), true);
});

test("a one-off thread stops after that first reply", () => {
  // everyN of 1000 makes the conversation draw effectively never fire.
  assert.equal(shouldContinueThread(2, "some-id@example.com", 1000), false);
});

test("roughly one thread in four is picked for a conversation", () => {
  let picked = 0;
  const total = 4000;
  for (let i = 0; i < total; i += 1) {
    if (isConversationThread(`msg-${i}@example.com`)) picked += 1;
  }
  const share = picked / total;
  // Hash-derived, so not exactly 25% — but it must be in the right region,
  // not 0% (never converses) or 100% (always does).
  assert.ok(share > 0.15 && share < 0.35, `share was ${share}`);
});

test("the decision for one thread is stable across repeated calls", () => {
  const id = "stable-thread@example.com";
  const first = isConversationThread(id);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(isConversationThread(id), first);
  }
});

test("a conversation runs to three or four messages, never more", () => {
  for (let i = 0; i < 500; i += 1) {
    const id = `len-${i}@example.com`;
    const length = conversationLength(id);
    assert.ok(length === 3 || length === 4, `length was ${length}`);
  }
});

test("a conversation continues while short and stops at its target", () => {
  // Find an id that was actually drawn as a conversation.
  let id = "";
  for (let i = 0; i < 1000; i += 1) {
    const candidate = `conv-${i}@example.com`;
    if (isConversationThread(candidate)) {
      id = candidate;
      break;
    }
  }
  assert.ok(id, "expected at least one conversation thread in 1000 ids");

  const target = conversationLength(id);
  assert.equal(shouldContinueThread(target - 1, id), true);
  assert.equal(shouldContinueThread(target, id), false);
  assert.equal(shouldContinueThread(target + 1, id), false);
});

test("a thread with no root id never becomes a conversation", () => {
  assert.equal(shouldContinueThread(2, null), false);
  assert.equal(isConversationThread(null), false);
});

test("depth below one is not repliable", () => {
  assert.equal(shouldContinueThread(0, "x@example.com"), false);
});


console.log("\nper-domain address selection");

const c = (email: string, domain: string | null = null) => ({
  id: email,
  email,
  domain: domain ?? email.split("@")[1] ?? null,
});

test("a named person outranks every shared inbox", () => {
  assert.ok(addressRank("jane.doe@site.com") < addressRank("editor@site.com"));
  assert.ok(addressRank("jane.doe@site.com") < addressRank("info@site.com"));
});

test("editorial contacts outrank generic ones", () => {
  assert.ok(addressRank("editor@site.com") < addressRank("info@site.com"));
  assert.ok(addressRank("content@site.com") < addressRank("support@site.com"));
});

test("addresses that should never be pitched rank last", () => {
  assert.ok(addressRank("noreply@site.com") > addressRank("support@site.com"));
  assert.ok(addressRank("privacy@site.com") > addressRank("info@site.com"));
  assert.ok(addressRank("webmaster@site.com") > addressRank("admin@site.com"));
});

test("trailing digits do not defeat role detection", () => {
  assert.equal(addressRank("info2@site.com"), addressRank("info@site.com"));
});

test("keeps the best one per domain and drops the rest", () => {
  const plan = planDomainDedupe([
    c("info@site.com"),
    c("jane@site.com"),
    c("noreply@site.com"),
    c("editor@site.com"),
  ]);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.keep[0]?.email, "jane@site.com");
  assert.equal(plan.drop.length, 3);
});

test("keeping two per domain takes the top two by rank", () => {
  const plan = planDomainDedupe(
    [c("info@site.com"), c("jane@site.com"), c("editor@site.com")],
    2,
  );
  assert.deepEqual(
    plan.keep.map((row) => row.email),
    ["jane@site.com", "editor@site.com"],
  );
  assert.equal(plan.drop.length, 1);
});

test("a domain with a single address never lands in drop", () => {
  const plan = planDomainDedupe([c("info@one.com"), c("info@two.com")]);
  assert.equal(plan.keep.length, 2);
  assert.equal(plan.drop.length, 0);
});

test("contacts with no domain are always kept", () => {
  const plan = planDomainDedupe([
    { id: "a", email: "someone@x.com", domain: null },
    { id: "b", email: "other@x.com", domain: null },
  ]);
  assert.equal(plan.keep.length, 2);
  assert.equal(plan.drop.length, 0);
});

test("domains are matched case-insensitively", () => {
  const plan = planDomainDedupe([
    c("a@site.com", "Site.com"),
    c("b@site.com", "site.com"),
  ]);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.drop.length, 1);
});

test("the same input always splits the same way", () => {
  const input = [c("info@site.com"), c("hello@site.com"), c("team@site.com")];
  const first = planDomainDedupe(input).keep[0]?.email;
  for (let i = 0; i < 20; i += 1) {
    assert.equal(planDomainDedupe(input).keep[0]?.email, first);
  }
});

test("duplicate domains are listed worst first", () => {
  const dupes = duplicateDomains([
    c("a@one.com"),
    c("b@one.com"),
    c("c@one.com"),
    c("a@two.com"),
    c("b@two.com"),
    c("a@three.com"),
  ]);
  assert.deepEqual(dupes, [
    { domain: "one.com", count: 3 },
    { domain: "two.com", count: 2 },
  ]);
});


console.log("\none send per mailbox per batch");

const poolBox = (id: string): RotationMailbox => ({
  id,
  email: `${id}@example.com`,
  daily_limit: 50,
  sent_today: 0,
  sent_today_date: new Date().toISOString().slice(0, 10),
  min_gap_seconds: 5400,
  max_gap_seconds: 7200,
  last_send_at: null,
  is_active: true,
  health_status: "healthy",
});

test("recordSend makes a mailbox ineligible until its gap elapses", () => {
  const box = poolBox("a");
  const now = new Date("2026-08-17T10:00:00Z");
  assert.equal(isEligible(box, { now }), true);

  recordSend(box, now);
  assert.equal(isEligible(box, { now }), false);
});

test("recordSend counts against the daily limit", () => {
  const box = poolBox("a");
  const now = new Date("2026-08-17T10:00:00Z");
  recordSend(box, now);
  recordSend(box, now);
  assert.equal(remainingCapacity(box, now), 48);
});

test("a send on a new day restarts the daily count", () => {
  const box = poolBox("a");
  box.sent_today = 40;
  box.sent_today_date = "2026-08-16";
  recordSend(box, new Date("2026-08-17T10:00:00Z"));
  assert.equal(box.sent_today, 1);
  assert.equal(box.sent_today_date, "2026-08-17");
});

test("a batch spreads one email per mailbox instead of draining one", () => {
  // The reported bug: five emails left a single account back to back.
  const pool = [poolBox("a"), poolBox("b"), poolBox("c")];
  const now = new Date("2026-08-17T10:00:00Z");
  const used: string[] = [];

  for (let i = 0; i < 5; i += 1) {
    const picked = pickMailbox(pool, { now });
    if (!picked) break;
    used.push(picked.id);
    recordSend(picked, now);
  }

  // Three mailboxes, so three sends and then nothing until the gap elapses.
  assert.equal(used.length, 3);
  assert.deepEqual([...used].sort(), ["a", "b", "c"]);
});

test("without recording the send the same mailbox is chosen every time", () => {
  // Guards the regression directly: this is the old behaviour.
  const pool = [poolBox("a"), poolBox("b"), poolBox("c")];
  const now = new Date("2026-08-17T10:00:00Z");
  const first = pickMailbox(pool, { now })?.id;
  const second = pickMailbox(pool, { now })?.id;
  assert.equal(first, second);
});

test("once the gap has elapsed the mailbox is usable again", () => {
  const box = poolBox("a");
  recordSend(box, new Date("2026-08-17T10:00:00Z"));
  // max_gap_seconds is 7200, so three hours later is past any drawn gap.
  assert.equal(isEligible(box, { now: new Date("2026-08-17T13:00:00Z") }), true);
});


console.log("\nmailbox sent volume");

const VOLUME_NOW = new Date("2026-08-17T12:00:00Z");

function sentRow(
  mailbox: string,
  daysAgo: number,
  kind: string | null = "campaign",
): SentRow {
  return {
    mailbox_id: mailbox,
    sent_at: new Date(VOLUME_NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    meta: kind === null ? null : { kind },
  };
}

function volumeFor(rows: SentRow[], mailbox: string) {
  const volume = summariseVolume(rows, VOLUME_NOW)[mailbox];
  assert.ok(volume, `no volume recorded for ${mailbox}`);
  // The windows are a parameter now, so the return type is keyed by any number.
  // Called without them it is exactly these three, which lets the assertions
  // below index it directly instead of guarding each one.
  return volume as Record<VolumeWindow, WindowCounts>;
}

test("windows nest — a recent send is in all three counts", () => {
  const volume = volumeFor([sentRow("a", 2)], "a");
  assert.equal(volume[7].outreach, 1);
  assert.equal(volume[14].outreach, 1);
  assert.equal(volume[30].outreach, 1);
});

test("an older send only reaches the wider windows", () => {
  const volume = volumeFor([sentRow("a", 10), sentRow("a", 20)], "a");
  assert.equal(volume[7].outreach, 0);
  assert.equal(volume[14].outreach, 1);
  assert.equal(volume[30].outreach, 2);
});

test("anything past the widest window is dropped", () => {
  const volume = summariseVolume([sentRow("a", MAX_VOLUME_WINDOW + 1)], VOLUME_NOW);
  assert.deepEqual(volume, {});
});

test("warmup is counted apart from real outreach", () => {
  const volume = volumeFor(
    [sentRow("a", 1, "warmup"), sentRow("a", 1, "campaign"), sentRow("a", 1, "manual")],
    "a",
  );
  assert.equal(volume[7].warmup, 1);
  // Manual sends are real mail to a real person, so they belong with outreach.
  assert.equal(volume[7].outreach, 2);
});

test("a row with no kind counts as outreach, never as warmup", () => {
  const volume = volumeFor([sentRow("a", 1, null)], "a");
  assert.equal(volume[7].outreach, 1);
  assert.equal(volume[7].warmup, 0);
});

test("mailboxes are kept separate", () => {
  const rows = [sentRow("a", 1), sentRow("b", 1), sentRow("b", 3)];
  assert.equal(volumeFor(rows, "a")[7].outreach, 1);
  assert.equal(volumeFor(rows, "b")[7].outreach, 2);
});

test("rows with no mailbox, no timestamp, or a junk timestamp are skipped", () => {
  const volume = summariseVolume(
    [
      { mailbox_id: null, sent_at: VOLUME_NOW.toISOString(), meta: null },
      { mailbox_id: "a", sent_at: null, meta: null },
      { mailbox_id: "a", sent_at: "not a date", meta: null },
    ],
    VOLUME_NOW,
  );
  assert.deepEqual(volume, {});
});

test("a future timestamp counts as just-sent rather than vanishing", () => {
  // Clock skew between the app and Postgres should not hide a send.
  assert.equal(volumeFor([sentRow("a", -1)], "a")[7].outreach, 1);
});

test("per-day average keeps one decimal", () => {
  assert.equal(perDay(3, 7), "0.4");
  assert.equal(perDay(0, 30), "0.0");
});

console.log("\ncampaign duplication");

test("the first copy is suffixed", () => {
  assert.equal(copyName("Outreach", ["Outreach"]), "Outreach (copy)");
});

test("a second copy is numbered instead of stacking suffixes", () => {
  assert.equal(
    copyName("Outreach", ["Outreach", "Outreach (copy)"]),
    "Outreach (copy 2)",
  );
});

test("duplicating a copy goes back to the root name", () => {
  assert.equal(
    copyName("Outreach (copy)", ["Outreach", "Outreach (copy)"]),
    "Outreach (copy 2)",
  );
  assert.equal(
    copyName("Outreach (copy 2)", ["Outreach", "Outreach (copy)", "Outreach (copy 2)"]),
    "Outreach (copy 3)",
  );
});

test("existing names are matched case-insensitively", () => {
  assert.equal(copyName("Outreach", ["outreach (COPY)"]), "Outreach (copy 2)");
});

test("a long name loses its tail, not its suffix", () => {
  const long = "x".repeat(200);
  const name = copyName(long, []);
  assert.ok(name.length <= 160);
  assert.ok(name.endsWith(" (copy)"));
});

test("an empty name still produces something selectable", () => {
  assert.equal(copyName("   ", []), "Campaign (copy)");
});

// ---------------------------------------------------------------------------
// Inbound poll scheduling
// ---------------------------------------------------------------------------

test("the first mailbox is always polled, however tight the budget", () => {
  assert.equal(
    canStartAnother({
      startedCount: 0,
      elapsedMs: 0,
      budgetMs: 1_000,
      estimateMs: 25_000,
    }),
    true,
  );
});

test("another mailbox starts while there is room to finish it", () => {
  assert.equal(
    canStartAnother({
      startedCount: 2,
      elapsedMs: 10_000,
      budgetMs: 45_000,
      estimateMs: 12_000,
    }),
    true,
  );
});

test("no mailbox is started that the budget cannot finish", () => {
  assert.equal(
    canStartAnother({
      startedCount: 4,
      elapsedMs: 26_000,
      budgetMs: 45_000,
      estimateMs: 25_000,
    }),
    false,
  );
});

test("a mailbox that lands exactly on the budget still starts", () => {
  assert.equal(
    canStartAnother({
      startedCount: 1,
      elapsedMs: 20_000,
      budgetMs: 45_000,
      estimateMs: 25_000,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Reading a publisher's quote out of their reply
// ---------------------------------------------------------------------------

const TYPICAL_REPLY = `Hi Haseeb,

Thanks for reaching out. Here is our price list:

General - $150
Business/Tech - $180
Health - $250
Casino, Gambling - $400
CBD - $350

DA: 45, DR: 52, Traffic: 25k monthly
Turnaround: 3-5 days
Do-follow links, maximum 2 links per post
Article should be minimum 1000 words. You can provide the content.
Payment via PayPal, 50% advance.

Best,
Sarah`;

test("a typical rate card yields every niche price", () => {
  const quote = parseQuote(TYPICAL_REPLY);
  const prices = Object.fromEntries(quote.prices.map((row) => [row.niche, row.price]));

  assert.equal(prices.General, 150);
  assert.equal(prices.Business, 180);
  assert.equal(prices.Health, 250);
  assert.equal(prices.Casino, 400);
  assert.equal(prices.CBD, 350);
  assert.equal(quote.currency, "USD");
});

test("metrics and terms come off the same reply", () => {
  const quote = parseQuote(TYPICAL_REPLY);

  assert.equal(quote.da, 45);
  assert.equal(quote.dr, 52);
  assert.equal(quote.monthlyTraffic, 25_000);
  assert.equal(quote.tatDays, 5, "the far end of 3-5 days is the promise");
  assert.equal(quote.linkType, "dofollow");
  assert.equal(quote.maxLinks, 2);
  assert.equal(quote.wordCount, 1000);
  assert.equal(quote.contentBy, "us");
  assert.equal(quote.paymentMethod, "PayPal");
  assert.equal(quote.paymentTerms, "50% advance");
});

test("every value carries the line it was read from", () => {
  const quote = parseQuote(TYPICAL_REPLY);
  assert.match(quote.evidence.da ?? "", /DA: 45/);
  assert.match(quote.evidence["price:Casino"] ?? "", /Casino/);
});

test("metrics are never mistaken for prices", () => {
  const quote = parseQuote(
    "DA 45\nDR 52\nSpam score 2\n1000 words\n3 days TAT\n2 links max",
  );
  assert.deepEqual(quote.prices, []);
  assert.equal(quote.da, 45);
  assert.equal(quote.spamScore, 2);
});

test("prices listed inline on one line are split apart", () => {
  const quote = parseQuote("Our rates: General $150, Casino $400, CBD $350");
  assert.equal(quote.prices.length, 3);
  assert.equal(quote.prices[1]?.niche, "Casino");
  assert.equal(quote.prices[1]?.price, 400);
});

test("a comma inside one price does not split that row", () => {
  const quote = parseQuote("Homepage link - $1,200");
  assert.equal(quote.prices.length, 1);
  assert.equal(quote.prices[0]?.price, 1200);
});

test("a listed pair of niches stays one price", () => {
  const quote = parseQuote("Casino, Gambling and Betting - $400");
  assert.equal(quote.prices.length, 1);
  assert.equal(quote.prices[0]?.niche, "Casino");
});

test("currencies other than dollars are read", () => {
  assert.equal(parseQuote("General - £120").currency, "GBP");
  assert.equal(parseQuote("General - 120 EUR").currency, "EUR");
  assert.equal(parseQuote("General - INR 8000").prices[0]?.price, 8000);
});

test("a bare number is a price only in a price-shaped row", () => {
  assert.equal(parseQuote("General - 150").prices[0]?.price, 150);
  assert.deepEqual(parseQuote("Turnaround - 3 days").prices, []);
});

test("hours and weeks become days", () => {
  assert.equal(parseQuote("Delivery within 48 hours").tatDays, 2);
  assert.equal(parseQuote("TAT: 2 weeks").tatDays, 14);
});

test("nofollow is not read as dofollow", () => {
  assert.equal(parseQuote("All links are no-follow.").linkType, "nofollow");
});

test("whoever writes the article is worked out from their side of it", () => {
  assert.equal(parseQuote("We will write the article ourselves.").contentBy, "publisher");
  assert.equal(parseQuote("You can send us your article.").contentBy, "us");
  assert.equal(
    parseQuote("We can write it, or you provide the content — either works.").contentBy,
    "either",
  );
});

test("the quoted email underneath is not parsed as their quote", () => {
  const quote = parseQuote(`Yes, $200 works for us.

On Mon, 17 Aug 2026 at 10:00, Haseeb wrote:
> We usually pay $50 for a guest post
> General - $50`);

  assert.equal(quote.prices.length, 1);
  assert.equal(quote.prices[0]?.price, 200);
});

test("quoted lines are dropped but a reply written below one is kept", () => {
  const stripped = stripQuotedReply("> their old line\nOur price is $300");
  assert.match(stripped, /Our price is \$300/);
});

test("an unrecognised niche keeps the publisher's own wording", () => {
  assert.equal(canonicalNiche("Pet care"), "Pet care");
  assert.equal(canonicalNiche("iGaming & Sportsbook"), "Casino");
  assert.equal(canonicalNiche("general business"), "Business");
});

test("a label naming two niches goes by the publisher's order", () => {
  assert.equal(canonicalNiche("Business/Tech"), "Business");
  assert.equal(canonicalNiche("Tech/Business"), "Tech");
});

test("a restricted niche sets the price wherever it appears in the label", () => {
  assert.equal(canonicalNiche("SEO for casinos"), "Casino");
  assert.equal(canonicalNiche("Health and CBD"), "CBD");
});

test("a sentence carrying a number is not a price row", () => {
  const quote = parseQuote(
    "General - £120\nWe can write the content for an extra £40.",
  );
  assert.equal(quote.prices.length, 1);
  assert.equal(quote.prices[0]?.niche, "General");
});

test("a niche that shares a name with a payment method is not the payment method", () => {
  const quote = parseQuote(
    "Crypto & Forex: £400\nGeneral: £120\nPayment: Wise or PayPal, 50% upfront.",
  );
  assert.equal(quote.paymentMethod, "Wise");
  assert.equal(quote.paymentTerms, "50% advance");
  assert.equal(quote.prices[0]?.niche, "Crypto");
});

test("crypto is still read as a payment method when they ask to be paid in it", () => {
  assert.equal(parseQuote("Payment in USDT only.").paymentMethod, "Crypto");
});

// A real reply from a bulk publisher, which looks nothing like a tidy rate
// card: a list of domains, then products and niches mixed in one column.
const BULK_REPLY = `Hello Below are the discounted prices of guest post for

||* charfen.co.uk [charfen.co.uk], ||* postplace.co.uk [postplace.co.uk], ||* okayuj.co.uk [okayuj.co.uk],

General 100
CBD 200
Adult 250
30 Days Footer Text Link 30
30 Days Banner 50
Link insertion 150

Let me know if you are interested.`;

test("a price list with no separators and no currency is read", () => {
  const prices = Object.fromEntries(
    parseQuote(BULK_REPLY).prices.map((row) => [row.niche, row.price]),
  );

  assert.equal(prices.General, 100);
  assert.equal(prices.CBD, 200);
  assert.equal(prices.Adult, 250);
  assert.equal(prices["Link insertion"], 150);
});

test("a product whose name starts with a number keeps it", () => {
  const prices = Object.fromEntries(
    parseQuote(BULK_REPLY).prices.map((row) => [row.niche, row.price]),
  );

  assert.equal(prices["30 Days Footer Text Link"], 30);
  assert.equal(prices["30 Days Banner"], 50);
});

test("the placement is the one they lead with, not a line item further down", () => {
  // "prices of guest post" opens the email; a link insertion is one row in it.
  assert.equal(parseQuote(BULK_REPLY).placementType, "guest post");
});

test("the same list with dashes reads identically", () => {
  const dashed = parseQuote(BULK_REPLY.replace(/^(\D[^\n]*?) (\d+)$/gm, "$1 - $2"));
  const prices = Object.fromEntries(dashed.prices.map((row) => [row.niche, row.price]));

  assert.equal(prices.General, 100);
  assert.equal(prices["Link insertion"], 150);
});

test("a metric label is never a price, even with the separator optional", () => {
  const quote = parseQuote(
    "DA 45\nDR 52\nSpam score 2\nTraffic 40000\nWord count 1000\nMax links 2",
  );
  assert.deepEqual(quote.prices, []);
  assert.equal(quote.monthlyTraffic, 40_000);
  assert.equal(quote.wordCount, 1000);
});

test("an email with no quote in it reports nothing found", () => {
  const quote = parseQuote("Thanks for your email, I will get back to you next week.");
  assert.equal(countFound(quote), 0);
});

test("empty input is safe", () => {
  const quote = parseQuote("");
  assert.equal(countFound(quote), 0);
  assert.deepEqual(quote.prices, []);
});

console.log("\nsignature and social icons");

const ICON_BASE = "https://crm.orankly.com";

test("no signature means nothing is appended", () => {
  const rendered = buildSignature({
    signature: null,
    socials: SOCIAL_KEYS,
    baseUrl: ICON_BASE,
  });
  assert.equal(rendered.text, "");
  assert.equal(rendered.html, "");
});

test("whitespace is not a signature", () => {
  const rendered = buildSignature({
    signature: "   \n  ",
    socials: SOCIAL_KEYS,
    baseUrl: ICON_BASE,
  });
  assert.equal(rendered.html, "");
});

test("a signature with no icons carries no images", () => {
  const rendered = buildSignature({
    signature: "Haseeb Butt\nOrankly",
    socials: [],
    baseUrl: ICON_BASE,
  });
  assert.ok(rendered.text.includes("Haseeb Butt"));
  assert.ok(rendered.html.includes("Haseeb Butt<br />Orankly"));
  assert.ok(!rendered.html.includes("<img"));
});

test("all four icons render, in the order the website lists them", () => {
  const rendered = buildSignature({
    signature: "Haseeb Butt",
    socials: SOCIAL_KEYS,
    baseUrl: ICON_BASE,
  });
  const order = [...rendered.html.matchAll(/signature\/([a-z]+)\.png/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, ["whatsapp", "linkedin", "facebook", "instagram"]);
});

test("icon URLs are absolute — a mail client has no page to resolve against", () => {
  const rendered = buildSignature({
    signature: "Haseeb",
    socials: ["whatsapp"],
    baseUrl: `${ICON_BASE}/`,
  });
  assert.ok(rendered.html.includes(`src="${ICON_BASE}/signature/whatsapp.png"`));
  // A trailing slash on the base must not double up.
  assert.ok(!rendered.html.includes("//signature"));
});

test("every icon is a link with alt text, so blocked images still say what it is", () => {
  const rendered = buildSignature({
    signature: "Haseeb",
    socials: ["linkedin"],
    baseUrl: ICON_BASE,
  });
  assert.ok(
    rendered.html.includes('href="https://www.linkedin.com/company/orankly/"'),
  );
  assert.ok(rendered.html.includes('alt="LinkedIn"'));
});

test("the plain-text part names each network next to its link", () => {
  const rendered = buildSignature({
    signature: "Haseeb",
    socials: ["whatsapp", "instagram"],
    baseUrl: ICON_BASE,
  });
  assert.ok(rendered.text.includes("WhatsApp: https://wa.me/12819694177"));
  assert.ok(
    rendered.text.includes(
      "Instagram: https://www.instagram.com/webwarnerofficial/",
    ),
  );
  assert.ok(!rendered.text.includes("LinkedIn"));
});

test("a signature cannot inject markup into the email", () => {
  const rendered = buildSignature({
    signature: '<script>alert("x")</script> & "quoted"',
    socials: [],
    baseUrl: ICON_BASE,
  });
  assert.ok(!rendered.html.includes("<script>"));
  assert.ok(rendered.html.includes("&lt;script&gt;"));
  assert.ok(rendered.html.includes("&amp;"));
});

test("a URL in the signature becomes a link", () => {
  const rendered = buildSignature({
    signature: "Haseeb\nhttps://orankly.com",
    socials: [],
    baseUrl: ICON_BASE,
  });
  assert.ok(rendered.html.includes('<a href="https://orankly.com"'));
});

test("an unconfigured mailbox gets every icon", () => {
  assert.deepEqual(parseSocialKeys(null), [
    "whatsapp",
    "linkedin",
    "facebook",
    "instagram",
  ]);
  assert.deepEqual(parseSocialKeys({}), SOCIAL_KEYS);
});

test("an explicit empty list means the user switched them off", () => {
  assert.deepEqual(parseSocialKeys({ socials: [] }), []);
});

test("stored icons come back in website order, deduplicated, junk dropped", () => {
  assert.deepEqual(
    parseSocialKeys({
      socials: ["facebook", "whatsapp", "facebook", "myspace"],
    }),
    ["whatsapp", "facebook"],
  );
});

console.log("\nreport ranges");

// A Thursday in August, mid-afternoon UTC — so a range that ignores the time of
// day and one that does not give different answers.
const RANGE_NOW = new Date("2026-08-20T14:30:00.000Z");

test("a day range covers whole days, starting at midnight", () => {
  const range = resolveReportRange("30", RANGE_NOW);
  assert.equal(range.days, 30);
  assert.equal(range.bucket, "day");
  // 30 days counting today: 22 July through 20 August.
  assert.equal(range.since, "2026-07-22T00:00:00.000Z");
});

test("the shortest range is still seven whole days", () => {
  const range = resolveReportRange("7", RANGE_NOW);
  assert.equal(range.since, "2026-08-14T00:00:00.000Z");
});

test("long ranges switch the chart to weekly bars", () => {
  assert.equal(resolveReportRange("90", RANGE_NOW).bucket, "day");
  assert.equal(resolveReportRange("180", RANGE_NOW).bucket, "week");
  assert.equal(resolveReportRange("365", RANGE_NOW).bucket, "week");
});

test("year to date runs from 1 January", () => {
  const range = resolveReportRange("ytd", RANGE_NOW);
  // 212 days to 31 July, plus 20 in August.
  assert.equal(range.days, 232);
  assert.equal(range.since, "2026-01-01T00:00:00.000Z");
  assert.equal(range.bucket, "week");
});

test("year to date on 1 January is one day, not an empty report", () => {
  const range = resolveReportRange("ytd", new Date("2026-01-01T09:00:00.000Z"));
  assert.equal(range.days, 1);
  assert.equal(range.since, "2026-01-01T00:00:00.000Z");
});

test("year to date counts the leap day", () => {
  const range = resolveReportRange("ytd", new Date("2028-03-01T00:00:00.000Z"));
  // 31 + 29 + 1.
  assert.equal(range.days, 61);
});

test("a range key from the URL is validated, never trusted", () => {
  assert.equal(parseReportRange("14"), "14");
  assert.equal(parseReportRange("ytd"), "ytd");
  assert.equal(parseReportRange("9999"), "30");
  assert.equal(parseReportRange(undefined), "30");
  assert.equal(parseReportRange(["7"]), "30");
});

console.log("\nreport series bucketing");

const SERIES_TODAY = new Date("2026-08-20T14:30:00.000Z");

test("a daily series is one point per day", () => {
  const series = buildSeries(
    7,
    { sent: [], replies: [], bounces: [] },
    "day",
    SERIES_TODAY,
  );
  assert.equal(series.length, 7);
  assert.equal(series[0]!.date, "2026-08-14");
  assert.equal(series[6]!.date, "2026-08-20");
  // Daily buckets report the same day both ends, so one tooltip format works.
  assert.equal(series[6]!.endDate, "2026-08-20");
  assert.equal(series[6]!.days, 1);
});

test("weekly buckets end today, not on a Monday", () => {
  const series = buildSeries(
    365,
    { sent: [], replies: [], bounces: [] },
    "week",
    SERIES_TODAY,
  );
  assert.equal(series.length, 53);
  assert.equal(series[52]!.endDate, "2026-08-20");
  assert.equal(series[52]!.days, 7);
  // The oldest bucket takes the remainder — 365 is not a whole number of weeks.
  assert.equal(series[0]!.days, 1);
});

test("folding into weeks loses nothing", () => {
  const sent = [
    "2026-08-20T01:00:00Z",
    "2026-08-19T01:00:00Z",
    "2026-06-01T01:00:00Z",
  ];
  const daily = buildSeries(
    180,
    { sent, replies: [], bounces: [] },
    "day",
    SERIES_TODAY,
  );
  const weekly = buildSeries(
    180,
    { sent, replies: [], bounces: [] },
    "week",
    SERIES_TODAY,
  );
  assert.equal(totals(daily).sent, 3);
  assert.equal(totals(weekly).sent, totals(daily).sent);
});

test("two sends on the same day land in the same weekly bucket", () => {
  const series = buildSeries(
    180,
    {
      sent: ["2026-08-20T01:00:00Z", "2026-08-20T23:00:00Z"],
      replies: [],
      bounces: [],
    },
    "week",
    SERIES_TODAY,
  );
  assert.equal(series[series.length - 1]!.sent, 2);
});

console.log("\nmailbox volume over report windows");

test("the report windows reach three months back", () => {
  assert.deepEqual(
    REPORT_MAILBOX_WINDOWS.map((window) => window.days),
    [7, 14, 30, 60, 90],
  );
  assert.equal(MAX_REPORT_MAILBOX_WINDOW, 90);
});

test("a send from six weeks ago is in the 2- and 3-month counts only", () => {
  const windows = REPORT_MAILBOX_WINDOWS.map((window) => window.days);
  const volume = summariseVolume([sentRow("a", 42)], VOLUME_NOW, windows).a;
  assert.equal(countsFor(volume, 30).outreach, 0);
  assert.equal(countsFor(volume, 60).outreach, 1);
  assert.equal(countsFor(volume, 90).outreach, 1);
});

test("a window that was never computed reads as zero, not undefined", () => {
  const volume = summariseVolume([sentRow("a", 1)], VOLUME_NOW, [7]).a;
  assert.equal(countsFor(volume, 7).outreach, 1);
  assert.equal(countsFor(volume, 90).outreach, 0);
  assert.equal(countsFor(undefined, 7).warmup, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
