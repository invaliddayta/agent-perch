import { report } from "./report.mjs";

// Pi 0.85.1 notification-only lifecycle hooks. Never handle input or permissions.
export function observePi(pi, emit = report) {
  let running = false;
  let stopReason;
  pi.on("session_start", () => {
    running = false;
    stopReason = undefined;
    return emit("idle");
  });
  pi.on("agent_start", () => {
    running = true;
    stopReason = undefined;
    return emit("working");
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      stopReason = event.message.stopReason;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) return;
    running = false;
    // Aborts and tool-only endings are not successful completed replies.
    return emit(
      stopReason === "stop"
        ? "ready"
        : stopReason === "error"
          ? "error"
          : "idle",
    );
  });
  pi.on("ui_prompt_start", () => emit("attention"));
  pi.on("ui_prompt_end", () => emit(running ? "working" : "idle"));
}

export default function (pi) {
  observePi(pi);
}
