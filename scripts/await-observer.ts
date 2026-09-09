// A crashed/unavailable observer must never prevent the requested agent starting.
const waiter = Bun.spawn(
  [process.env.PERCH_TMUX!, "wait-for", process.env.PERCH_RUN_ID!],
  {
    stdout: "ignore",
    stderr: "ignore",
  },
);
const timer = setTimeout(() => waiter.kill(), 2500);
await waiter.exited;
clearTimeout(timer);
export {};
