import { report } from "./report.mjs";

// deepseek-harness 76fda729799fe9b3848dbe2c211d4b231032b81e:
// packages/core/{agent,agent-loop}, packages/interaction/{user-approval,user-questions}.
// dsh-tui 8bdc850732464e2c10278f47b4f2b82da38d801e: src/startup.ts.
export const inject = ["agents", "tuiStartup"];

export function apply(ctx) {
  let root;
  let turn;
  let stepped = false;
  let userTurn = false;
  let open = false;
  let failed = false;
  let state;
  let last;
  const approvals = new Set();
  const questions = new Set();
  const observe = (fn) => {
    try {
      fn();
    } catch {}
  };
  const publish = () => {
    const value = approvals.size || questions.size ? "attention" : state;
    if (!value || value === last) return;
    last = value;
    try {
      Promise.resolve(report(value)).catch(() => {});
    } catch {}
  };
  const matches = (agent) =>
    agent &&
    agent.id === ctx.tuiStartup.sessionId &&
    ctx.agents.get(agent.id) === agent &&
    ctx.agents.roots().includes(agent);
  const attach = (agent) => {
    if (!matches(agent) || root === agent) return;
    root = agent;
    turn = undefined;
    stepped = false;
    userTurn = false;
    open = false;
    failed = false;
    approvals.clear();
    questions.clear();
    state =
      agent.status === "idle"
        ? "idle"
        : agent.status === "running"
          ? "working"
          : undefined;
    publish();
  };

  // ctx.on is the ctx.events.on alias; Cordis owns listener disposal.
  observe(() =>
    ctx.on("agent/created", (payload) => observe(() => attach(payload.agent))),
  );
  observe(() =>
    ctx.on("agent/inbox/claimed", (payload) =>
      observe(() => {
        const { agent, turn: claimed, message } = payload;
        if (
          agent === root &&
          matches(agent) &&
          open &&
          claimed === turn &&
          message?.source?.kind === "user"
        )
          userTurn = true;
      }),
    ),
  );
  observe(() =>
    ctx.on("agent/status", (payload) =>
      observe(() => {
        const { agent, status } = payload;
        if (agent !== root || !matches(agent)) return;
        // Idle includes setup/maintenance and cannot prove a completed turn.
        if (status === "running") {
          state = "working";
          publish();
        }
      }),
    ),
  );
  observe(() =>
    ctx.on("agent/error", (payload) =>
      observe(() => {
        const { agent, turn: ended } = payload;
        if (
          agent !== root ||
          !matches(agent) ||
          (turn !== undefined && ended !== turn)
        )
          return;
        failed = true;
        state = "error";
        approvals.clear();
        questions.clear();
        publish();
      }),
    ),
  );
  observe(() =>
    ctx.on("session/event", (session, event) =>
      observe(() => {
        if (!root || session !== root.session || !matches(root)) return;
        const data = event.data;
        switch (event.type) {
          case "turn/start":
            if (
              !Number.isSafeInteger(data.turn) ||
              (turn !== undefined && data.turn <= turn)
            )
              return;
            turn = data.turn;
            stepped = false;
            userTurn = false;
            open = true;
            failed = false;
            approvals.clear();
            questions.clear();
            state = "working";
            break;
          case "step/start":
            if (open && data.turn === turn) stepped = true;
            return;
          case "turn/end":
            if (!open || data.turn !== turn) return;
            open = false;
            approvals.clear();
            questions.clear();
            state =
              failed || data.reason?.kind === "error"
                ? "error"
                : data.reason?.kind === "completed" && stepped && userTurn
                  ? "ready"
                  : ["blocked", "max-tokens"].includes(data.reason?.kind)
                    ? "attention"
                    : "idle";
            // Keep the turn number as a watermark against late/duplicate events.
            stepped = false;
            break;
          case "approval/asked":
            if (open && typeof data.id === "string") approvals.add(data.id);
            break;
          case "approval/decided":
            approvals.delete(data.id);
            break;
          default:
            return;
        }
        publish();
      }),
    ),
  );
  // Approval has native audit notifications; never register approval/request.
  // Questions have no notification pair. Observe the waterfall without owning
  // a decision, touching the request, or waiting for the reporter.
  observe(() =>
    ctx.on(
      "user-questions/request",
      async (request, next) => {
        const token = {};
        observe(() => {
          if (request.agent !== root || !matches(root)) return;
          questions.add(token);
          publish();
        });
        try {
          return await next();
        } finally {
          observe(() => {
            if (questions.delete(token)) publish();
          });
        }
      },
      { prepend: true },
    ),
  );
  observe(() => attach(ctx.agents.get(ctx.tuiStartup.sessionId)));
}
