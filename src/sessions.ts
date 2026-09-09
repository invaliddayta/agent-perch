import { useEffect, useRef, useState } from "react";
import type { Session, Snapshot } from "./types";

export const sessionKey = (session: Session) =>
  `${session.id}@${session.created}`;
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Agent-Watch": "1",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function useSessions(onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [offline, setOffline] = useState(false);
  const revision = useRef(0);
  const pending = useRef<Promise<Snapshot> | undefined>(undefined);

  function invalidate() {
    ++revision.current;
    pending.current = undefined;
  }
  function refresh(): Promise<Snapshot> {
    if (pending.current) return pending.current;
    const request = revision.current;
    return (pending.current = (async () => {
      try {
        const next = await api<Snapshot>("/sessions");
        if (request === revision.current) {
          setSnapshot(next);
          setOffline(false);
        }
        return next;
      } catch (error) {
        if (request === revision.current) {
          setOffline(true);
          onError(errorText(error));
        }
        throw error;
      } finally {
        if (request === revision.current) pending.current = undefined;
      }
    })());
  }

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (polling) return;
      polling = true;
      await refresh().catch(() => {});
      polling = false;
      if (!cancelled) timer = setTimeout(poll, document.hidden ? 12000 : 3500);
    };
    const wake = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    void poll();
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      invalidate();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  return {
    snapshot,
    offline,
    async create(body: unknown) {
      const { id } = await api<{ id: string }>("/sessions", body);
      invalidate();
      const next = await refresh();
      const session = next.sessions.find((s) => s.id === id);
      if (!session)
        throw new Error(
          "The agent exited before it could be attached. Check its CLI setup on the host.",
        );
      return session;
    },
    async kill(session: Session) {
      await api("/sessions/kill", { id: session.id, created: session.created });
      // A poll begun before the confirmed mutation must not restore the session.
      invalidate();
      setSnapshot(
        (old) =>
          old && {
            ...old,
            sessions: old.sessions.filter(
              (s) => sessionKey(s) !== sessionKey(session),
            ),
          },
      );
    },
  };
}
