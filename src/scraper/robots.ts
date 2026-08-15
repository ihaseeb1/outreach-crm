import { env } from "@/lib/env";

/**
 * Minimal robots.txt fetcher/parser. Compliance rule #9: we honour Disallow
 * rules and Crawl-delay, and identify ourselves with a descriptive UA.
 *
 * Matching follows the common convention: longest matching path wins, and
 * Allow beats Disallow on an equal-length match.
 */

interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

export interface RobotsPolicy {
  groups: RobotsGroup[];
  /** True when robots.txt was missing/unreadable — we then default to allow. */
  absent: boolean;
}

const robotsCache = new Map<string, { policy: RobotsPolicy; at: number }>();
const ROBOTS_CACHE_TTL_MS = 30 * 60 * 1000;

export function parseRobots(text: string): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;

    if (field === "disallow") {
      current.rules.push({ type: "disallow", path: value });
    } else if (field === "allow") {
      current.rules.push({ type: "allow", path: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) current.crawlDelayMs = seconds * 1000;
    }
  }

  return { groups, absent: false };
}

function uaToken(): string {
  // "OutreachCRM/1.0 (+…)" -> "outreachcrm"
  return (env.scraperUserAgent().split("/")[0] ?? "outreachcrm").toLowerCase();
}

function selectGroup(policy: RobotsPolicy): RobotsGroup | null {
  const token = uaToken();
  const specific = policy.groups.find((g) =>
    g.agents.some((a) => a !== "*" && token.includes(a)),
  );
  if (specific) return specific;
  return policy.groups.find((g) => g.agents.includes("*")) ?? null;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  // Support the widely-implemented * and $ extensions.
  if (pattern.includes("*") || pattern.endsWith("$")) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const source = escaped.endsWith("\\$")
      ? `^${escaped.slice(0, -2)}$`
      : `^${escaped}`;
    try {
      return new RegExp(source).test(path);
    } catch {
      return false;
    }
  }
  return path.startsWith(pattern);
}

export function isAllowed(policy: RobotsPolicy, path: string): boolean {
  if (policy.absent) return true;
  const group = selectGroup(policy);
  if (!group) return true;

  let best: { rule: RobotsRule; length: number } | null = null;
  for (const rule of group.rules) {
    if (!pathMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.type === "allow")
    ) {
      best = { rule, length };
    }
  }

  if (!best) return true;
  return best.rule.type === "allow";
}

export function crawlDelayMs(policy: RobotsPolicy): number {
  const group = selectGroup(policy);
  const fromRobots = group?.crawlDelayMs ?? 0;
  // Never crawl faster than our own politeness floor.
  return Math.max(fromRobots, env.scraperCrawlDelayMs());
}

export async function fetchRobots(origin: string): Promise<RobotsPolicy> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_CACHE_TTL_MS) return cached.policy;

  let policy: RobotsPolicy = { groups: [], absent: true };
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": env.scraperUserAgent() },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (response.ok) {
      const text = await response.text();
      // Guard against HTML 200-pages served in place of a real robots.txt.
      policy = text.trimStart().startsWith("<")
        ? { groups: [], absent: true }
        : parseRobots(text);
    }
  } catch {
    policy = { groups: [], absent: true };
  }

  robotsCache.set(origin, { policy, at: Date.now() });
  return policy;
}
