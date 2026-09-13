export type BackendId = "opencode" | "codex" | "pi" | "deepseek";
export type AgentState = "idle" | "working" | "ready" | "attention" | "error";
export type AgentStatus = {
  run: string;
  backend: BackendId;
  state: AgentState | "unknown";
  event?: { id: string; state: "ready" | "attention" | "error" };
};
export type Backend = {
  id: BackendId;
  label: string;
  available: boolean;
  initialPrompt: boolean;
};
export type Pane = {
  id: string;
  windowId: string;
  windowName: string;
  index: string;
  command: string;
  backend?: BackendId;
  cwd: string;
  active: boolean;
  dead: boolean;
  title?: string;
  pid?: number;
  windowActive?: boolean;
  status?: AgentStatus;
};
export type Session = {
  id: string;
  name: string;
  created: number;
  attached: number;
  panes: Pane[];
};
export type Snapshot = {
  sessions: Session[];
  projectsRoot: string;
  voiceReady: boolean;
  backends: Backend[];
};
