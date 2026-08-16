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
  type RotationMailbox,
} from "../src/campaigns/rotation";
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
  resumeVolume,
  sendingAllowance,
  shouldRampToday,
  shouldReply,
} from "../src/warmup/plan";
import { isValidWarmupToken, newWarmupToken } from "../src/warmup/token";
import { domainFromUrl, isRoleAccount, normalizeUrl, splitName } from "../src/lib/email";
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


console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
