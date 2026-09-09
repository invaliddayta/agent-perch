import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  root = resolve(import.meta.dir, ".."),
) {
  const port = Number(env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const home = env.HOME || homedir();
  const path = (value: string | undefined, fallback: string) =>
    resolve(
      root,
      value?.startsWith("~/") ? join(home, value.slice(2)) : value || fallback,
    );
  const origin = (name: string, value: string | undefined) => {
    if (!value) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid HTTP(S) origin.`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${name} must be an HTTP(S) origin without credentials, path, query, or fragment.`,
      );
    return url.origin;
  };
  const publicOrigin = origin("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN);
  const devOrigin = origin("DEV_ORIGIN", env.DEV_ORIGIN);
  return {
    port,
    publicOrigin,
    projectsRoot: path(env.PROJECTS_ROOT, home),
    stateDir: path(env.STATE_DIR, join(root, ".state")),
    distDir: path(env.DIST_DIR, join(root, "dist")),
    origins: new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...[publicOrigin, devOrigin].filter((value): value is string => !!value),
    ]),
  };
}
