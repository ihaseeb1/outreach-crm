/**
 * Pure-logic smoke tests — no network, no database.
 * Run with: npm run smoke
 *
 * Covers the pieces that are easy to get subtly wrong: robots.txt matching,
 * contact extraction from messy HTML, validation verdicts, and crypto round-trips.
 */

import assert from "node:assert/strict";

import { encryptSecret, decryptSecret, safeEqual } from "../src/lib/crypto";
import { domainFromUrl, isRoleAccount, normalizeUrl, splitName } from "../src/lib/email";
import { extractFromHtml, isJunkEmail } from "../src/scraper/extract";
import { isAllowed, parseRobots } from "../src/scraper/robots";
import { isDisposableDomain } from "../src/validation/disposable";

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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
