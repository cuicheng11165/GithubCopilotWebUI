export interface HubEvent {
  cursor: number;
  sessionId: string;
  turnId: string | null;
  kind: string;
  data: unknown;
  createdAt: string;
}

interface Subscription {
  sessionId: string;
  after: number;
  listener: (events: HubEvent[]) => void;
}

export interface SessionEventHub {
  subscribe(sessionId: string, after: number, listener: (events: HubEvent[]) => void): () => void;
  publish(events: HubEvent[]): void;
  notify(): void;
  close(): void;
}

export function createSessionEventHub(options: {
  pollIntervalMs: number;
  maxPollIntervalMs?: number;
  loadEvents: (subscriptions: Array<{ sessionId: string; after: number }>) => Promise<HubEvent[]>;
  onError?: (error: unknown) => void;
}): SessionEventHub {
  const maxPollIntervalMs = options.maxPollIntervalMs ?? Math.max(options.pollIntervalMs, 2_000);
  const subscriptions = new Set<Subscription>();
  let stopped = false;
  let wake: (() => void) | null = null;
  let currentDelay = options.pollIntervalMs;
  let polling = false;
  let rerun = false;

  const requests = () => {
    const mins = new Map<string, number>();
    for (const subscription of subscriptions) {
      const current = mins.get(subscription.sessionId);
      if (current === undefined || subscription.after < current) mins.set(subscription.sessionId, subscription.after);
    }
    return [...mins.entries()].map(([sessionId, after]) => ({ sessionId, after }));
  };

  const dispatch = (events: HubEvent[]) => {
    if (events.length === 0) return;
    const bySession = new Map<string, HubEvent[]>();
    for (const event of events) {
      const list = bySession.get(event.sessionId) ?? [];
      list.push(event);
      bySession.set(event.sessionId, list);
    }
    for (const subscription of subscriptions) {
      const relevant = (bySession.get(subscription.sessionId) ?? [])
        .filter((event) => event.cursor > subscription.after)
        .sort((left, right) => left.cursor - right.cursor);
      if (relevant.length === 0) continue;
      subscription.after = relevant[relevant.length - 1]!.cursor;
      try { subscription.listener(relevant); } catch (error) { options.onError?.(error); }
    }
  };

  const poll = async () => {
    if (polling) {
      rerun = true;
      return;
    }
    polling = true;
    try {
      do {
        rerun = false;
        const pending = requests();
        if (pending.length === 0) break;
        const events = await options.loadEvents(pending);
        dispatch(events);
        currentDelay = events.length > 0 ? options.pollIntervalMs : Math.min(maxPollIntervalMs, Math.max(options.pollIntervalMs, currentDelay * 2));
        if (events.length >= 2_000) rerun = true;
      } while (rerun && !stopped);
    } finally {
      polling = false;
    }
  };

  const sleepUntilWake = (ms?: number) => new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (wake === finish) wake = null;
      resolve();
    };
    if (ms !== undefined) timer = setTimeout(finish, ms);
    wake = finish;
  });

  const loop = async () => {
    while (!stopped) {
      if (subscriptions.size === 0) {
        await sleepUntilWake();
        continue;
      }
      try {
        await poll();
      } catch (error) {
        options.onError?.(error);
        currentDelay = Math.min(maxPollIntervalMs, Math.max(options.pollIntervalMs, currentDelay * 2));
      }
      if (stopped || subscriptions.size === 0) continue;
      await sleepUntilWake(currentDelay);
    }
  };
  void loop();

  return {
    subscribe(sessionId, after, listener) {
      const subscription: Subscription = { sessionId, after, listener };
      subscriptions.add(subscription);
      wake?.();
      void poll().catch((error) => options.onError?.(error));
      return () => subscriptions.delete(subscription);
    },
    publish(events) {
      dispatch(events);
    },
    notify() {
      currentDelay = options.pollIntervalMs;
      wake?.();
      void poll().catch((error) => options.onError?.(error));
    },
    close() {
      stopped = true;
      subscriptions.clear();
      wake?.();
    }
  };
}
