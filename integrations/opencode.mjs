import { report } from "./report.mjs";

// Contract: anomalyco/opencode v1.18.3, src/plugin/index.ts,
// src/session/{prompt,status}.ts and src/{permission,question}/index.ts.
// Only one export: the legacy plugin loader invokes every exported function.
export default async function perchEvents() {
  const roots = new Map();
  const pendingUsers = new Map();
  let last;
  let disposed = false;
  const publish = () => {
    const states = [...roots.values()].map((root) =>
      root.requests.size ? "attention" : root.state,
    );
    const state = ["attention", "working", "error", "ready", "idle"].find((s) =>
      states.includes(s),
    );
    if (!state || state === last || disposed) return;
    last = state;
    // Never await status reporting on an agent callback, even if it hangs.
    try {
      Promise.resolve(report(state)).catch(() => {});
    } catch {}
  };

  return {
    async event(input) {
      try {
        const event = input?.event;
        if (disposed || !event?.properties) return;
        const p = event.properties;
        const info = p.info;
        if (
          event.type === "session.created" ||
          event.type === "session.updated"
        ) {
          if (typeof info?.id !== "string") return;
          if (info.parentID) {
            roots.delete(info.id);
          } else if (!roots.has(info.id)) {
            roots.set(info.id, {
              // An update establishes lineage, not current activity.
              state: event.type === "session.created" ? "idle" : undefined,
              requests: new Set(),
              tools: new Set(),
              active: false,
              user: pendingUsers.get(info.id),
            });
          }
          pendingUsers.delete(info.id);
          publish();
          return;
        }
        if (event.type === "session.deleted") {
          roots.delete(info?.id);
          pendingUsers.delete(info?.id);
          publish();
          return;
        }
        const root = roots.get(
          p.sessionID ?? info?.sessionID ?? p.part?.sessionID,
        );
        // No first-event guessing: unknown sessions might be delegated children.
        if (!root) {
          // Resuming can emit the user message before session.touch establishes
          // lineage. Retain only its identity, never publish for unknown roots.
          if (
            event.type === "message.updated" &&
            info?.role === "user" &&
            typeof info.sessionID === "string" &&
            typeof info.id === "string"
          ) {
            pendingUsers.set(info.sessionID, info.id);
            if (pendingUsers.size > 128)
              pendingUsers.delete(pendingUsers.keys().next().value);
          }
          return;
        }
        switch (event.type) {
          case "message.updated":
            if (info.role === "user" && typeof info.id === "string") {
              if (root.user && info.id < root.user) return;
              if (root.user !== info.id) {
                root.user = info.id;
                root.finished = false;
                root.failed = false;
                root.assistant = undefined;
                root.tools.clear();
              }
            } else if (
              root.active &&
              info.role === "assistant" &&
              root.user &&
              info.parentID === root.user &&
              info.summary !== true &&
              typeof info.id === "string"
            ) {
              if (root.assistant && info.id < root.assistant) return;
              if (root.assistant !== info.id) root.finished = false;
              root.assistant = info.id;
              if (info.error) {
                root.failed = true;
                root.finished = false;
                root.state = "error";
              } else {
                root.finished =
                  info.finish === "stop" &&
                  typeof info.time?.completed === "number";
              }
            }
            break;
          case "message.part.updated":
            if (root.active && p.part?.type === "tool")
              root.tools.add(p.part.messageID);
            break;
          case "session.status":
            if (p.status?.type === "busy" || p.status?.type === "retry") {
              if (!root.active) {
                root.active = true;
                root.finished = false;
                root.failed = false;
              }
              root.state = root.failed ? "error" : "working";
            } else if (p.status?.type === "idle" && root.active) {
              root.active = false;
              root.requests.clear();
              root.state = root.failed
                ? "error"
                : root.finished && !root.tools.has(root.assistant)
                  ? "ready"
                  : "idle";
            }
            break;
          case "session.error":
            root.failed = true;
            root.finished = false;
            root.requests.clear();
            root.state = "error";
            break;
          case "permission.asked":
          case "question.asked":
            if (typeof p.id === "string")
              root.requests.add(`${event.type.split(".")[0]}:${p.id}`);
            break;
          case "permission.replied":
          case "question.replied":
          case "question.rejected":
            root.requests.delete(`${event.type.split(".")[0]}:${p.requestID}`);
            break;
          default:
            return;
        }
        publish();
      } catch {}
    },
    async dispose() {
      disposed = true;
      roots.clear();
      pendingUsers.clear();
    },
  };
}
