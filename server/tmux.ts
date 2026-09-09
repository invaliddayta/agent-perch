import { realpath, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Session } from "../src/types";
import { paneStatus } from "../src/status";

export const tmuxPrefix = [
  Bun.which("tmux") || "tmux",
  ...(process.env.TMUX_SOCKET ? ["-S", process.env.TMUX_SOCKET] : []),
];
export const viewerPrefix = "__agent_watch_view_";
export async function tmux(...args: string[]) {
  const child = Bun.spawn([...tmuxPrefix, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMUX: "" },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || "tmux command failed");
  return out.trimEnd();
}

export async function sessions(): Promise<Session[]> {
  let text: string;
  try {
    text = await tmux(
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_id}\t#{window_id}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_active}\t#{pane_dead}\t#{pane_title}\t#{pane_pid}\t#{window_active}\t#{@perch_run}\t#{@perch_backend}\t#{@perch_pid}\t#{@perch_state}\t#{@perch_event}",
    );
  } catch (err) {
    if (
      /no server running|no sessions|error connecting.*No such file/.test(
        String(err),
      )
    )
      return [];
    throw err;
  }
  const list = new Map<string, Session>();
  for (const line of text.split("\n").filter(Boolean)) {
    const [id, name, created, attached, ...p] = line.split("\t");
    if (name.startsWith(viewerPrefix)) continue;
    let session = list.get(id);
    if (!session) {
      session = {
        id,
        name,
        created: Number(created),
        attached: Number(attached),
        panes: [],
      };
      list.set(id, session);
    }
    session.panes.push({
      id: p[0],
      windowId: p[1],
      windowName: p[2],
      index: p[3],
      command: p[4],
      cwd: p[5],
      active: p[6] === "1",
      dead: p[7] === "1",
      title: p[8],
      pid: Number(p[9]),
      windowActive: p[10] === "1",
      status:
        p[7] === "1"
          ? undefined
          : paneStatus(p[11], p[12], p[13], p[9], p[14], p[15]),
    });
  }
  return [...list.values()];
}

export function validSessionId(id: string) {
  return /^\$\d+$/.test(id) && id.trim() === id;
}

// Callers validate these values before embedding them in tmux's format language.
export function sessionIdentity(session: Pick<Session, "id" | "created">) {
  return `#{&&:#{&&:#{==:#{session_id},${session.id}},#{==:#{session_created},${session.created}}},#{!=:#{m:${viewerPrefix}*,#{session_name}},1}}`;
}
export function validName(name: unknown): name is string {
  return (
    typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)
  );
}
export async function projectPath(root: string, input: string, create = false) {
  if (!input.trim() || /[\x00-\x1f\x7f]/.test(input))
    throw new Error("Enter a directory path without control characters");
  if (input.startsWith("~") && input !== "~" && !input.startsWith("~/"))
    throw new Error("Use ~/ for your home directory, or an absolute path");
  const home = process.env.HOME || homedir();
  const target = resolve(
    root,
    input === "~"
      ? home
      : input.startsWith("~/")
        ? home + input.slice(1)
        : input,
  );
  try {
    if (create) await mkdir(target, { recursive: true });
    const path = await realpath(target);
    // tmux's pane metadata is tab/newline separated, including resolved symlinks.
    if (/[\x00-\x1f\x7f]/.test(path))
      throw new Error("Directory path contains control characters");
    await readdir(path);
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new Error(
        "Directory does not exist. Enable 'Create directory' to create it.",
      );
    if (code === "ENOTDIR" || code === "EEXIST")
      throw new Error("Path is not a directory");
    if (code === "EACCES" || code === "EPERM")
      throw new Error("Permission denied for this directory");
    throw error;
  }
}
