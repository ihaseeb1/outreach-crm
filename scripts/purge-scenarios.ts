/**
 * End-to-end tests for the warmup purge (src/warmup/purge.ts), run against an
 * in-memory fake of the Supabase client — no network, no database. These prove
 * the whole orchestration, not just the pure predicates: that outreach is never
 * touched, that the gate holds, that an anomaly aborts, that it drains unlimited
 * volume across pages, and that a newly connected account is picked up.
 *
 * Imported and awaited by scripts/smoke-test.ts.
 */

import assert from "node:assert/strict";

import { runWarmupPurge } from "../src/warmup/purge";

type Row = Record<string, unknown>;
interface Store {
  messages: Row[];
  mailboxes: Row[];
  workspaces: Row[];
  warmup_settings: Row[];
  activity_log: Row[];
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** A deliberately small fake implementing exactly the query surface the purge
 * uses: select (+count/head), update, delete, insert, eq/is/lt/in/not, order,
 * limit, maybeSingle, and thenable await. */
class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "update" | "delete" | "insert" = "select";
  private cols = "*";
  private wantCount = false;
  private head = false;
  private single = false;
  private orderBy: { col: string; asc: boolean; nullsFirst: boolean } | null = null;
  private lim: number | null = null;
  private updateVals: Row | null = null;
  private insertVals: Row[] = [];

  constructor(private store: Store, private table: keyof Store) {}

  select(cols: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "insert" || this.op === "update" || this.op === "delete") {
      // a trailing .select() on a write — ignore projection, keep the op
    } else {
      this.op = "select";
    }
    this.cols = cols;
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.head = true;
    return this;
  }
  update(vals: Row) {
    this.op = "update";
    this.updateVals = vals;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  insert(vals: Row | Row[]) {
    this.op = "insert";
    this.insertVals = Array.isArray(vals) ? vals : [vals];
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => norm(r[col]) === norm(val));
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) =>
      val === null ? r[col] === null || r[col] === undefined : r[col] === val,
    );
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push(
      (r) => r[col] != null && String(r[col]) < String(val),
    );
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === "is" && val === null) {
      this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    }
    return this;
  }
  in(col: string, arr: unknown[]) {
    const set = new Set(arr.map(norm));
    this.filters.push((r) => set.has(norm(r[col])));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderBy = {
      col,
      asc: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst === true,
    };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this.exec();
  }
  then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
    return this.exec().then(resolve, reject);
  }

  private matched(): Row[] {
    return (this.store[this.table] ?? []).filter((r) =>
      this.filters.every((f) => f(r)),
    );
  }

  private async exec(): Promise<{ data: unknown; count: number | null; error: null }> {
    if (this.op === "insert") {
      this.store[this.table].push(...this.insertVals);
      return { data: null, count: null, error: null };
    }

    const matched = this.matched();

    if (this.op === "update") {
      for (const row of matched) Object.assign(row, this.updateVals);
      return { data: null, count: matched.length, error: null };
    }
    if (this.op === "delete") {
      this.store[this.table] = this.store[this.table].filter(
        (r) => !matched.includes(r),
      );
      return { data: null, count: matched.length, error: null };
    }

    // select
    let rows = [...matched];
    if (this.orderBy) {
      const { col, asc, nullsFirst } = this.orderBy;
      rows.sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return nullsFirst ? -1 : 1;
        if (bv == null) return nullsFirst ? 1 : -1;
        const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        return asc ? cmp : -cmp;
      });
    }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    if (this.head) return { data: null, count: matched.length, error: null };
    if (this.single) return { data: rows[0] ?? null, count: null, error: null };
    return { data: rows, count: this.wantCount ? matched.length : null, error: null };
  }
}

class FakeSupabase {
  constructor(private store: Store) {}
  from(table: keyof Store) {
    return new Query(this.store, table);
  }
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const WS = "ws-1";
const NOW = new Date("2026-08-30T12:00:00Z");
const OLD = "2026-08-01T12:00:00Z"; // ~29 days old
const RECENT = "2026-08-29T12:00:00Z"; // 1 day old

let seq = 0;
function msg(overrides: Row): Row {
  seq += 1;
  return {
    id: `m-${seq}`,
    workspace_id: WS,
    direction: "outbound",
    from_email: null,
    to_email: null,
    subject: "warmup",
    sent_at: OLD,
    meta: { kind: "warmup" },
    is_warmup: false,
    deleted_at: null,
    ...overrides,
  };
}

function baseStore(settings: Row = { warmup: { auto_delete_enabled: true } }): Store {
  return {
    messages: [],
    mailboxes: [
      { id: "mb-a", workspace_id: WS, email: "alice@mine.com" },
      { id: "mb-b", workspace_id: WS, email: "bob@mine.com" },
    ],
    workspaces: [{ id: WS, settings }],
    warmup_settings: [],
    activity_log: [],
  };
}

const OPTS = { now: NOW, mailboxLimit: 0, budgetMs: 60_000 };

// ---------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------

export async function runPurgeScenarios(
  atest: (name: string, fn: () => Promise<void>) => Promise<void>,
): Promise<void> {
  console.log("\nwarmup purge — end to end (fake DB)");

  await atest("soft-deletes old warmup, spares outreach / recent / anomalies", async () => {
    const store = baseStore();
    const oldWarmup = [
      msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true }),
      msg({ from_email: "bob@mine.com", to_email: "alice@mine.com", is_warmup: true }),
      msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true }),
    ];
    const recentWarmup = msg({
      from_email: "alice@mine.com",
      to_email: "bob@mine.com",
      is_warmup: true,
      sent_at: RECENT,
    });
    const outreach = [
      msg({ from_email: "alice@mine.com", to_email: "editor@publisher.com", is_warmup: false }),
      msg({ from_email: "bob@mine.com", to_email: "webmaster@site.org", is_warmup: false }),
    ];
    // A flag set wrongly on an external row (single anomaly, under threshold).
    const wrongFlag = msg({
      from_email: "alice@mine.com",
      to_email: "editor@publisher.com",
      is_warmup: true,
    });
    store.messages.push(...oldWarmup, recentWarmup, ...outreach, wrongFlag);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);

    assert.equal(result.dryRun, false, "should have written");
    assert.equal(result.softDeleted, 3, "exactly the 3 old pool-to-pool warmups");
    for (const row of oldWarmup) assert.ok(row.deleted_at, "old warmup soft-deleted");
    assert.equal(recentWarmup.deleted_at, null, "recent warmup within retention");
    for (const row of outreach) assert.equal(row.deleted_at, null, "outreach untouched");
    assert.equal(wrongFlag.deleted_at, null, "external row never deleted despite the flag");
    assert.equal(result.aborted.length, 0);
  });

  await atest("never touches outreach even at volume", async () => {
    const store = baseStore();
    for (let i = 0; i < 2500; i += 1) {
      store.messages.push(
        msg({ from_email: "alice@mine.com", to_email: `pub${i}@publisher.com`, is_warmup: false }),
      );
    }
    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.softDeleted, 0);
    assert.ok(store.messages.every((m) => m.deleted_at == null));
  });

  await atest("drains unlimited warmup volume across pages (> one SELECT_PAGE)", async () => {
    const store = baseStore();
    const n = 2500; // more than the 1000-row page, so the drain loop must page
    for (let i = 0; i < n; i += 1) {
      store.messages.push(
        msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true }),
      );
    }
    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.softDeleted, n, "all soft-deleted in one run");
    assert.ok(store.messages.every((m) => m.deleted_at != null));
  });

  await atest("aborts when the flag disagrees with the pool at scale", async () => {
    const store = baseStore();
    // 20 flagged rows whose recipient is external — well over the tolerance.
    for (let i = 0; i < 20; i += 1) {
      store.messages.push(
        msg({ from_email: "alice@mine.com", to_email: `x${i}@publisher.com`, is_warmup: true }),
      );
    }
    // ...and a genuine warmup that would otherwise be deleted.
    const real = msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true });
    store.messages.push(real);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.ok(result.aborted.length > 0, "should abort");
    assert.equal(result.softDeleted, 0, "nothing deleted while aborted");
    assert.equal(real.deleted_at, null, "even the real warmup is left until it is investigated");
  });

  await atest("disabled workspace only reports, writes nothing", async () => {
    const store = baseStore({ warmup: { auto_delete_enabled: false } });
    const warmup = msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true });
    store.messages.push(warmup);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.dryRun, true, "nothing written");
    assert.equal(result.softDeleted, 1, "reports what it WOULD delete");
    assert.equal(warmup.deleted_at, null, "but does not actually delete");
  });

  await atest("explicit dryRun previews without writing even when enabled", async () => {
    const store = baseStore();
    const warmup = msg({ from_email: "alice@mine.com", to_email: "bob@mine.com", is_warmup: true });
    store.messages.push(warmup);
    const result = await runWarmupPurge(new FakeSupabase(store) as never, { ...OPTS, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(warmup.deleted_at, null);
  });

  await atest("a newly connected account is included automatically", async () => {
    const store = baseStore();
    // Connect a third account after the fact.
    store.mailboxes.push({ id: "mb-c", workspace_id: WS, email: "carol@mine.com" });
    const withNew = msg({ from_email: "alice@mine.com", to_email: "carol@mine.com", is_warmup: true });
    const fromNew = msg({ from_email: "carol@mine.com", to_email: "bob@mine.com", is_warmup: true });
    store.messages.push(withNew, fromNew);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.softDeleted, 2, "warmup to/from the new account is recognised");
    assert.ok(withNew.deleted_at && fromNew.deleted_at);
  });

  await atest("hard-deletes only after the grace period, pool re-checked", async () => {
    const store = baseStore();
    const pastGrace = msg({
      from_email: "alice@mine.com",
      to_email: "bob@mine.com",
      is_warmup: true,
      deleted_at: "2026-08-10T12:00:00Z", // 20 days ago > 7-day grace
    });
    const withinGrace = msg({
      from_email: "alice@mine.com",
      to_email: "bob@mine.com",
      is_warmup: true,
      deleted_at: "2026-08-29T12:00:00Z", // 1 day ago
    });
    store.messages.push(pastGrace, withinGrace);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.hardDeleted, 1);
    assert.ok(!store.messages.includes(pastGrace), "past-grace row removed");
    assert.ok(store.messages.includes(withinGrace), "within-grace row kept");
  });

  await atest("per-account retention override is honoured", async () => {
    const store = baseStore();
    // alice deletes same-day; bob keeps 14 days.
    store.warmup_settings.push(
      { mailbox_id: "mb-a", workspace_id: WS, delete_after: "today" },
      { mailbox_id: "mb-b", workspace_id: WS, delete_after: "14d" },
    );
    // Sent yesterday: past 'today' for alice, within '14d' for bob.
    const aliceYesterday = msg({
      from_email: "alice@mine.com",
      to_email: "bob@mine.com",
      is_warmup: true,
      sent_at: "2026-08-29T12:00:00Z",
    });
    const bobYesterday = msg({
      from_email: "bob@mine.com",
      to_email: "alice@mine.com",
      is_warmup: true,
      sent_at: "2026-08-29T12:00:00Z",
    });
    store.messages.push(aliceYesterday, bobYesterday);

    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.softDeleted, 1, "only alice's same-day rule fires");
    assert.ok(aliceYesterday.deleted_at, "alice's warmup deleted (today rule)");
    assert.equal(bobYesterday.deleted_at, null, "bob's warmup kept (14d rule)");
  });

  await atest("does nothing when there is only one connected account", async () => {
    const store = baseStore();
    store.mailboxes = [{ id: "mb-a", workspace_id: WS, email: "alice@mine.com" }];
    const selfMail = msg({ from_email: "alice@mine.com", to_email: "alice@mine.com", is_warmup: true });
    store.messages.push(selfMail);
    const result = await runWarmupPurge(new FakeSupabase(store) as never, OPTS);
    assert.equal(result.softDeleted, 0);
    assert.equal(selfMail.deleted_at, null);
    assert.ok(result.skipped.some((s) => s.includes("fewer than 2")));
  });
}
