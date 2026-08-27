import net from "node:net";
import { emailDomain } from "@/lib/email";

/**
 * SMTP mailbox-existence probe — the "power mode" check.
 *
 * This is the one thing an MX lookup cannot tell you: does the individual
 * mailbox actually exist, or will the domain accept anything (catch-all)? It is
 * exactly what a paid verifier's deep mode does, and it is what actually drives
 * a cold-email bounce rate down.
 *
 * How it works: connect to the domain's lowest-priority MX on port 25, say
 * EHLO / MAIL FROM, then RCPT TO the real address. A 2xx means the server will
 * accept mail for it; a 5xx means "no such user". To detect a catch-all, a
 * second RCPT is sent to a random address that cannot exist — if the server
 * accepts *that* too, it accepts everything and the individual result is
 * unknowable, so the address is reported as catch-all rather than confirmed.
 *
 * IMPORTANT — port 25 outbound:
 *   Vercel and GitHub Actions (both AWS-hosted) block outbound port 25, so this
 *   probe CANNOT run from the deployed web app or the CI cron. It is meant to be
 *   driven by `scripts/verify-worker.ts` on a box where port 25 is open (a small
 *   VPS is the reliable choice — many home ISPs block it too). When the port is
 *   blocked the connect simply times out and this returns `connected: false`,
 *   which the engine treats as "indeterminate" (never as "invalid"), so a
 *   blocked environment never wrongly writes off a good address.
 *
 * No authentication, no mail is ever sent: the conversation is reset with RSET
 * and closed with QUIT before DATA. This is a read-only existence check.
 */

export interface SmtpProbeResult {
  /** Could we open an SMTP conversation with the MX at all? */
  connected: boolean;
  /** RCPT TO the real address was accepted (2xx). */
  accepted: boolean;
  /** The server accepts every address — individual existence is unknowable. */
  catchAll: boolean;
  /** A definite "no such mailbox" (5xx that is not a catch-all situation). */
  rejected: boolean;
  /** Mailbox exists but is over quota. */
  inboxFull: boolean;
  /** Mailbox/account is disabled or blocked by the provider. */
  disabled: boolean;
  /** Raw last response code seen for the real RCPT, for diagnostics. */
  code: number | null;
  /** Human-readable note (timeout, greylisted, refused, …). */
  detail: string;
}

const CRLF = "\r\n";

function blankResult(detail: string): SmtpProbeResult {
  return {
    connected: false,
    accepted: false,
    catchAll: false,
    rejected: false,
    inboxFull: false,
    disabled: false,
    code: null,
    detail,
  };
}

/** A random local part that is overwhelmingly unlikely to exist, for catch-all. */
function randomLocalPart(seed: string): string {
  // Deterministic-ish but unique per domain+run; no Math.random dependency so it
  // is testable and stable within a batch.
  let hash = 2166136261;
  const material = `${seed}:${process.pid}:catchall-probe`;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `zzz-nonexistent-${hash.toString(36)}`;
}

interface SmtpConversation {
  send(line: string): Promise<{ code: number; text: string }>;
  close(): void;
}

function openConversation(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ greeting: { code: number; text: string }; convo: SmtpConversation }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.setEncoding("utf8");

    let buffer = "";
    let pending: ((value: { code: number; text: string }) => void) | null = null;
    let greeted = false;

    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    // A multiline SMTP reply uses "250-" for intermediate lines and "250 " for
    // the last. Resolve only when the final line of the current reply arrives.
    const drain = () => {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        const isFinal = match[2] === " ";
        if (!isFinal) continue;
        const reply = { code: Number(match[1]), text: match[3] ?? "" };
        if (!greeted) {
          greeted = true;
          resolve({ greeting: reply, convo });
          continue;
        }
        const resolver = pending;
        pending = null;
        resolver?.(reply);
      }
    };

    const convo: SmtpConversation = {
      send(line) {
        return new Promise((res, rej) => {
          if (socket.destroyed) {
            rej(new Error("socket closed"));
            return;
          }
          pending = res;
          socket.write(line + CRLF, (err) => {
            if (err) rej(err);
          });
        });
      },
      close() {
        socket.destroy();
      },
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      drain();
    });
    socket.on("timeout", () => fail(new Error("smtp timeout")));
    socket.on("error", (err) => fail(err));
    socket.on("close", () => {
      if (!greeted) reject(new Error("connection closed before greeting"));
      else if (pending) {
        const resolver = pending;
        pending = null;
        resolver({ code: 0, text: "connection closed" });
      }
    });
  });
}

function classifyRcpt(code: number, text: string): {
  accepted: boolean;
  rejected: boolean;
  inboxFull: boolean;
  disabled: boolean;
} {
  const message = text.toLowerCase();
  const accepted = code >= 200 && code < 300;

  // Over-quota / mailbox full — the mailbox exists but cannot receive now.
  const inboxFull =
    /full|quota|over.?quota|insufficient (system )?storage|exceeded/.test(message) ||
    code === 452 ||
    code === 552;

  // Disabled / blocked account.
  const disabled =
    /disabled|suspended|blocked|deactivat|no longer (active|in use)|account.*(closed|inactive)/.test(
      message,
    );

  // A hard 5xx that names the recipient is "no such user".
  const rejected =
    !accepted &&
    code >= 500 &&
    !inboxFull &&
    !disabled;

  return { accepted, rejected: rejected || (!accepted && code >= 500), inboxFull, disabled };
}

/**
 * Runs the probe against one MX host. `mailFrom` should be a real, deliverable
 * address on a domain you control (the sending mailbox), because some servers
 * reject an empty or bogus MAIL FROM outright.
 */
export async function probeMailbox(
  email: string,
  options: {
    mxHost: string;
    mailFrom: string;
    heloName?: string;
    timeoutMs?: number;
    port?: number;
  },
): Promise<SmtpProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const port = options.port ?? 25;
  const helo = options.heloName ?? (emailDomain(options.mailFrom) || "localhost");
  const domain = emailDomain(email);

  let convo: SmtpConversation | null = null;
  try {
    const opened = await openConversation(options.mxHost, port, timeoutMs);
    convo = opened.convo;
    if (opened.greeting.code !== 220) {
      return {
        ...blankResult(`MX did not greet (${opened.greeting.code})`),
        connected: true,
      };
    }

    // Prefer EHLO; fall back to HELO for old servers.
    let hello = await convo.send(`EHLO ${helo}`);
    if (hello.code >= 400) hello = await convo.send(`HELO ${helo}`);
    if (hello.code >= 400) {
      return { ...blankResult(`HELO refused (${hello.code})`), connected: true };
    }

    const mailFrom = await convo.send(`MAIL FROM:<${options.mailFrom}>`);
    if (mailFrom.code >= 400) {
      // Server refuses the envelope sender — often greylisting or policy, not a
      // statement about the recipient. Treat as indeterminate.
      return {
        ...blankResult(`MAIL FROM refused (${mailFrom.code})`),
        connected: true,
      };
    }

    // The real recipient.
    const rcpt = await convo.send(`RCPT TO:<${email}>`);
    const realVerdict = classifyRcpt(rcpt.code, rcpt.text);

    // Greylisting: a 4xx here means "try later", not a verdict. Report as
    // indeterminate so the caller can retry rather than record a false result.
    if (rcpt.code >= 400 && rcpt.code < 500) {
      await convo.send("RSET").catch(() => undefined);
      await convo.send("QUIT").catch(() => undefined);
      return {
        ...blankResult(`greylisted or deferred (${rcpt.code})`),
        connected: true,
        code: rcpt.code,
      };
    }

    // Catch-all probe: only worth doing when the real address was accepted.
    let catchAll = false;
    if (realVerdict.accepted) {
      const bogus = `${randomLocalPart(domain)}@${domain}`;
      const rcpt2 = await convo.send(`RCPT TO:<${bogus}>`);
      catchAll = rcpt2.code >= 200 && rcpt2.code < 300;
    }

    await convo.send("RSET").catch(() => undefined);
    await convo.send("QUIT").catch(() => undefined);

    return {
      connected: true,
      accepted: realVerdict.accepted,
      catchAll,
      rejected: realVerdict.rejected,
      inboxFull: realVerdict.inboxFull,
      disabled: realVerdict.disabled,
      code: rcpt.code,
      detail: catchAll
        ? "domain is catch-all (accepts all addresses)"
        : realVerdict.accepted
          ? "mailbox accepts mail"
          : realVerdict.inboxFull
            ? "mailbox full"
            : realVerdict.disabled
              ? "mailbox disabled"
              : "mailbox rejected",
    };
  } catch (error) {
    return blankResult(error instanceof Error ? error.message : String(error));
  } finally {
    convo?.close();
  }
}
