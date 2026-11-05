"use client";

/**
 * Client store.
 *
 * One bootstrap fetch gives the shell everything it needs to render without a
 * request waterfall; individual screens then poll their own narrow endpoint.
 * There are no websockets in this deployment, so `usePoll` is the single
 * mechanism for liveness — intervals are tuned per screen (fast for the floor
 * and KDS, slow for reports).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api";
import { can, type Permission } from "@/domain/permissions";
import type { BootstrapState, SessionUser } from "@/types";

interface StoreValue {
  state: BootstrapState | null;
  loading: boolean;
  error: string | null;
  user: SessionUser | null;
  /** Permission check that is safe before the bootstrap resolves. */
  allowed: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  signIn: (pin: string, clockIn: boolean) => Promise<SessionUser>;
  signOut: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<BootstrapState>("bootstrap");
      setState(next);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (pin: string, clockIn: boolean) => {
      const result = await api.post<{ user: SessionUser }>("session/signin", { pin, clockIn });
      await refresh();
      return result.user;
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("session/signout");
    } finally {
      setState(null);
      router.push("/login");
      router.refresh();
    }
  }, [router]);

  const allowed = useCallback(
    (permission: Permission) => can(state?.user.permissions ?? [], permission),
    [state],
  );

  const value = useMemo<StoreValue>(
    () => ({ state, loading, error, user: state?.user ?? null, allowed, refresh, signIn, signOut }),
    [state, loading, error, allowed, refresh, signIn, signOut],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useStore must be used inside <StoreProvider>");
  return context;
}

/** Convenience accessor for the loaded bootstrap, or null while it resolves. */
export function useBootstrap(): BootstrapState | null {
  return useStore().state;
}

// --------------------------------------------------------------------- polling
export interface PollOptions {
  /** Milliseconds between refreshes. 0 disables polling. */
  interval?: number;
  /** Skip the request entirely (e.g. a modal is open, or an id is missing). */
  enabled?: boolean;
  /** Keep the previous payload while refetching, so the UI never flashes empty. */
  keepPrevious?: boolean;
}

/**
 * Fetch `path` immediately and then every `interval` ms.
 *
 * Requests are skipped while the tab is hidden and while one is still in
 * flight, so a slow response can never pile up behind the next tick.
 */
export function usePoll<T>(path: string | null, options: PollOptions = {}) {
  const { interval = 0, enabled = true, keepPrevious = true } = options;
  const [data, setData] = useState<T | null>(keepPrevious ? null : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!path || !enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await api.get<T>(path);
      setData(result);
      setError(null);
    } catch (caught) {
      // A 401 mid-session means the cookie expired; surface it rather than
      // silently polling a dead endpoint forever.
      setError(errorMessage(caught));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    setPending(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!interval || !enabled || !path) return;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, enabled, path, load]);

  return { data, error, pending, reload: load };
}

/** A ticking clock, for live table and KDS timers. */
export function useTicker(intervalMs = 15000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
