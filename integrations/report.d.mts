import type { AgentState } from "../src/types";
export function report(
  state: AgentState,
  env?: NodeJS.ProcessEnv,
): Promise<void>;
