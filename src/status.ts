import type { AgentStatus, BackendId, Session } from "./types";

export function paneStatus(
  run: string,
  backend: string,
  ownerPid: string,
  pid: string,
  value: string,
  event: string,
): AgentStatus | undefined {
  if (
    !/^[a-f0-9-]{36}$/.test(run) ||
    ownerPid !== pid ||
    !["opencode", "codex", "deepseek"].includes(backend)
  )
    return;
  const state = value?.startsWith(run + ":") ? value.slice(37) : "";
  const parts = event?.split(":");
  return {
    run,
    backend: backend as BackendId,
    state: ["idle", "working", "ready", "attention", "error"].includes(state)
      ? (state as AgentStatus["state"])
      : "unknown",
    ...(parts?.[0] === run &&
    /^[a-f0-9-]{36}$/.test(parts[1]) &&
    ["ready", "attention", "error"].includes(parts[2]) &&
    parts.length === 3
      ? {
          event: {
            id: parts[1],
            state: parts[2] as NonNullable<AgentStatus["event"]>["state"],
          },
        }
      : {}),
  };
}

export const eventLabel = {
  ready: "Turn finished",
  attention: "Needs attention",
  error: "Agent error",
};
export const stateLabel = {
  unknown: "No status",
  idle: "Idle",
  working: "Working",
  ready: "Turn done",
  attention: "Attention",
  error: "Error",
};

export function unreadEvents(
  sessions: Session[],
  seen: Record<string, string>,
) {
  return sessions.flatMap((session) =>
    session.panes.flatMap((pane) => {
      const event = pane.status?.event;
      const key = `${session.id}@${session.created}:${pane.id}:${pane.status?.run}`;
      return !pane.dead && event && seen[key] !== event.id
        ? [{ session, pane, event, key }]
        : [];
    }),
  );
}
