// gmux pi session extension
// ----------------------------------------------------------------------------
// The authoritative source of session state for pi. pi knows exactly which
// conversation it holds and what it's doing; this hook forwards that to the
// gmux runner so attribution, title, and status are all push-based and exact.
//
// The runner also exposes an owner-only reverse-control broker on the same
// Unix socket. A control loop exists only while a pi session is active. Rename
// commands are applied through pi's extension API (never through PTY input) and
// are guarded by both the extension instance and active session-file identity.
// All transport failures are swallowed: gmux must never break pi.
// ----------------------------------------------------------------------------

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const http = require("http");

export default function (pi) {
  const sock = process.env.GMUX_SESSION_SOCK;
  if (!sock) return; // not launched by gmux → no-op

  let activeControl;
  let instanceSeq = 0;

  function reportSession(reason, ctx) {
    let file, id, name, cwd;
    try {
      const sm = ctx.sessionManager;
      file = sm.getSessionFile();
      id = sm.getSessionId();
      name = sm.getSessionName();
      cwd = sm.getCwd();
    } catch {
      return;
    }
    if (!file) return;
    post(sock, { op: "session", path: String(file), id, name, cwd, reason });
  }

  // session_start is authoritative for both bind reporting and control-loop
  // ownership. session_shutdown aborts the outstanding long poll before pi can
  // bind another conversation, so a stale command cannot rename the new one.
  pi.on("session_start", (ev, ctx) => {
    reportSession(ev?.reason ?? "start", ctx);
    activeControl?.abort();
    const controller = new AbortController();
    const instance = `${process.pid}-${Date.now()}-${++instanceSeq}`;
    const token = { controller, instance, ctx };
    activeControl = { abort: () => controller.abort(), token };
    void controlLoop(sock, pi, token, () => activeControl?.token === token);
  });

  pi.on("session_shutdown", () => {
    activeControl?.abort();
    activeControl = undefined;
  });

  // pi emits this when its canonical display metadata changes (including
  // setSessionName). Report the getter value rather than trusting event shape.
  pi.on("session_info_changed", (_ev, ctx) => {
    let title, file;
    try {
      title = pi.getSessionName();
      file = ctx.sessionManager.getSessionFile();
    } catch {}
    if (title && file) post(sock, { op: "title", title: String(title), path: String(file) });
  });

  pi.on("agent_start", () => post(sock, { op: "turn", phase: "start" }));

  pi.on("agent_end", (ev, ctx) => {
    let stopReason;
    const msgs = ev.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        stopReason = msgs[i].stopReason;
        break;
      }
    }
    let name;
    try { name = ctx.sessionManager.getSessionName(); } catch {}
    const outcome =
      stopReason === "stop" ? "completed" : stopReason === "error" ? "error" : "aborted";
    post(sock, { op: "turn", phase: "end", outcome, title: name || undefined });
    reportSession("activity", ctx);
  });
}

async function controlLoop(socketPath, pi, token, isActive) {
  const { controller, instance, ctx } = token;
  while (!controller.signal.aborted && isActive()) {
    let expectedSessionFile;
    try { expectedSessionFile = ctx.sessionManager.getSessionFile(); } catch {}
    if (!expectedSessionFile) {
      await delay(100, controller.signal);
      continue;
    }

    let command;
    try {
      command = await requestJSON(socketPath, "/hook/control/next", "POST", {
        extension_instance: instance,
        expected_session_file: String(expectedSessionFile),
      }, controller.signal);
    } catch {
      if (!controller.signal.aborted) await delay(100, controller.signal);
      continue;
    }
    if (!command || command.op !== "set_session_name") continue;

    const result = {
      id: command.id,
      extension_instance: instance,
      expected_session_file: command.expected_session_file,
      ok: false,
    };
    try {
      if (!isActive() || command.extension_instance !== instance) {
        throw new Error("stale extension instance");
      }
      const current = ctx.sessionManager.getSessionFile();
      if (!current || String(current) !== command.expected_session_file) {
        throw new Error("session changed");
      }
      // These calls intentionally remain synchronous: the runner responds to
      // the user only after this setter ACK and returns the canonical getter.
      pi.setSessionName(command.name);
      const canonical = pi.getSessionName();
      if (!canonical) throw new Error("name was not applied");
      result.ok = true;
      result.name = String(canonical);
    } catch (err) {
      result.error = err instanceof Error ? err.message : "rename failed";
    }

    try {
      await requestJSON(socketPath, "/hook/control/result", "POST", result, controller.signal);
    } catch {
      // Transport errors are never allowed to surface into pi.
    }
  }
}

function requestJSON(socketPath, path, method, payload, signal) {
  return new Promise((resolve, reject) => {
    let req;
    const onAbort = () => req?.destroy(new Error("aborted"));
    try {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      req = http.request({
        socketPath,
        path,
        method,
        headers: { "content-type": "application/json", "content-length": body.length },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          signal?.removeEventListener("abort", onAbort);
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`runner returned ${res.statusCode}`));
            return;
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!raw) { resolve(undefined); return; }
          try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
        });
      });
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      req.end(body);
    } catch (err) {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    }
  });
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function post(socketPath, event) {
  try {
    const body = Buffer.from(JSON.stringify(event), "utf8");
    const req = http.request({
      socketPath,
      path: "/hook/event",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length },
    });
    req.on("error", () => {});
    req.end(body);
  } catch {
    // swallow — the extension must never break pi
  }
}
