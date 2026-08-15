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
import { encryptSecret, decryptSecret, safeEqual } from "../src/lib/crypto";
import { domainFromUrl, isRoleAccount, normalizeUrl, splitName } from "../src/lib/email";
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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
