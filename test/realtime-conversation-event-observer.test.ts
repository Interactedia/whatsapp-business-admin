/**
 * WA-ERA4-08 (rework) — Active QueryClient observer integration.
 *
 * Proves that an ACTIVE observer (a mounted `QueryObserver` against a
 * real `@tanstack/react-query` QueryClient) automatically refetches
 * when a `conversation:updated` event arrives — without the test
 * code manually invoking `fetchList()`.
 *
 * Pattern:
 *   1. Create a real QueryClient.
 *   2. Mount a `QueryObserver` and `subscribe()` it. The mounted
 *      observer makes the query "active" — on `invalidateQueries`
 *      the observer triggers a refetch automatically. This is the
 *      same code path the Inbox client uses via `useQuery` (which
 *      internally creates and subscribes a `QueryObserver`).
 *   3. Drive the queryFn to return Agent A initially.
 *   4. Drive the SAME queryFn to return Agent B on the next call.
 *   5. Dispatch a `conversation:updated` event through the same
 *      handler the Inbox client uses (processEvent +
 *      invalidateQueries).
 *   6. Assert: a refetch fires automatically (queryFn was invoked
 *      a second time, WITHOUT the test calling any fetch function).
 *   7. Assert: the observed list converges to Agent B.
 *
 * The same flow is repeated for a `conversation:updated` triggered
 * by a status change, and for duplicate notifications (which must
 * be harmless — at-least-once is acceptable, idempotency is the
 * client's job).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import {
  OrderingGuard,
  RequestToken,
  SeenSet,
  processEvent,
  type SyncAction,
} from "@/lib/realtime/sync";

type List = Array<{
  id: string;
  assignedUserId: string;
  status: "OPEN" | "CLOSED";
}>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Resolver<T> = ReturnType<typeof deferred<T>>;
type ListCall = { token: number; deferred: Resolver<List> };

class Harness {
  readonly qc: QueryClient;
  readonly seen = new SeenSet();
  readonly ordering = new OrderingGuard();
  readonly listToken = new RequestToken();
  tenantId: string;
  activeConversationId: string | null;
  readonly inflightList: ListCall[] = [];
  queryFnCalls = 0;
  // Track each observed result so the test can assert the latest
  // snapshot delivered to subscribers.
  observedSnapshots: Array<List | undefined> = [];
  unsubscribe: (() => void) | null = null;

  constructor(tenantId: string, activeConversationId: string | null = null) {
    this.qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchInterval: 30_000,
          staleTime: 0,
        },
      },
    });
    this.tenantId = tenantId;
    this.activeConversationId = activeConversationId;
  }

  listKey(): readonly unknown[] {
    return ["conversations", this.tenantId];
  }

  fetchList = async (): Promise<List> => {
    this.queryFnCalls++;
    const token = this.listToken.next();
    const d = deferred<List>();
    this.inflightList.push({ token, deferred: d });
    const result = await d.promise;
    if (!this.listToken.isCurrent(token)) {
      const cached = this.qc.getQueryData<List>(this.listKey());
      return (cached ?? result) as List;
    }
    return result;
  };

  /**
   * Mount a real `QueryObserver` and subscribe to it. This is the
   * exact same observer class `useQuery` creates internally; once
   * subscribed, the observer is ACTIVE and will re-run queryFn on
   * invalidation without any further action from the test.
   */
  mountActiveObserver(): QueryObserver<List, Error> {
    const observer = new QueryObserver<List, Error>(this.qc, {
      queryKey: this.listKey(),
      queryFn: this.fetchList,
    });
    this.unsubscribe = observer.subscribe((result) => {
      this.observedSnapshots.push(result.data);
    });
    return observer;
  }

  handleRealtime(msg: { type: string; payload: unknown }): void {
    const verdict = processEvent(
      msg,
      this.activeConversationId,
      this.seen,
      this.ordering,
      [
        "message:new",
        "message:status",
        "message:image-enriched",
        "conversation:updated",
      ],
    );
    if (!verdict.admitted) return;
    const action: SyncAction = verdict.action;
    if (action.kind === "ignore") return;
    if (
      action.kind === "refetch-list" ||
      action.kind === "refetch-list-and-thread"
    ) {
      this.listToken.next();
      void this.qc.invalidateQueries({ queryKey: this.listKey() });
    }
  }

  resolveLatest(data: List) {
    const d = this.inflightList[this.inflightList.length - 1];
    if (!d) throw new Error("no inflight list call to resolve");
    d.deferred.resolve(data);
  }

  async drainInflight() {
    for (const c of [...this.inflightList]) {
      try {
        c.deferred.resolve([]);
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  latestData(): List | undefined {
    const last = this.observedSnapshots[this.observedSnapshots.length - 1];
    return last;
  }
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("WA-ERA4-08 — active QueryClient observer (no manual fetchList)", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness("t1", "c1");
  });

  afterEach(async () => {
    if (h.unsubscribe) h.unsubscribe();
    await h.drainInflight();
    h.qc.clear();
  });

  it("assignment change: list converges to Agent B via automatic refetch", async () => {
    h.mountActiveObserver();

    // Initial fetch returns Agent A.
    await waitFor(() => h.inflightList.length >= 1, 2000, 5);
    h.resolveLatest([
      { id: "c1", assignedUserId: "Agent A", status: "OPEN" },
    ]);
    await waitFor(() => h.latestData() !== undefined, 2000, 5);
    expect(h.latestData()).toEqual([
      { id: "c1", assignedUserId: "Agent A", status: "OPEN" },
    ]);
    expect(h.queryFnCalls).toBe(1);

    // Server-side: Agent A → Agent B. The PATCH handler publishes
    // a tenant-scoped `conversation:updated` event with payload
    // { conversationId }. The Inbox client receives it via
    // useRealtime and routes it through processEvent +
    // invalidateQueries.
    const callsBefore = h.queryFnCalls;
    h.handleRealtime({
      type: "conversation:updated",
      payload: { conversationId: "c1" },
    });

    // The active observer MUST have triggered a refetch
    // automatically. We assert by waiting for the queryFn counter
    // to advance, without ever calling fetchList ourselves.
    await waitFor(() => h.queryFnCalls > callsBefore, 3000, 10);
    expect(h.queryFnCalls).toBe(callsBefore + 1);

    // Canonical backend now reports Agent B. Resolve the refetch.
    h.resolveLatest([
      { id: "c1", assignedUserId: "Agent B", status: "OPEN" },
    ]);
    await waitFor(
      () => h.latestData()?.[0]?.assignedUserId === "Agent B",
      2000,
      5,
    );

    expect(h.latestData()).toEqual([
      { id: "c1", assignedUserId: "Agent B", status: "OPEN" },
    ]);
  });

  it("status change: list converges to status CLOSED via automatic refetch", async () => {
    h.mountActiveObserver();

    await waitFor(() => h.inflightList.length >= 1, 2000, 5);
    h.resolveLatest([
      { id: "c1", assignedUserId: "Agent A", status: "OPEN" },
    ]);
    await waitFor(() => h.latestData() !== undefined, 2000, 5);
    expect(h.latestData()?.[0]?.status).toBe("OPEN");

    const callsBefore = h.queryFnCalls;
    // conversation:updated from a status PATCH (status → CLOSED).
    h.handleRealtime({
      type: "conversation:updated",
      payload: { conversationId: "c1" },
    });
    await waitFor(() => h.queryFnCalls > callsBefore, 3000, 10);
    expect(h.queryFnCalls).toBe(callsBefore + 1);

    h.resolveLatest([
      { id: "c1", assignedUserId: "Agent A", status: "CLOSED" },
    ]);
    await waitFor(
      () => h.latestData()?.[0]?.status === "CLOSED",
      2000,
      5,
    );
    expect(h.latestData()?.[0]?.status).toBe("CLOSED");
  });

  it("duplicate conversation:updated is harmless: no refetch loop", async () => {
    h.mountActiveObserver();

    await waitFor(() => h.inflightList.length >= 1, 2000, 5);
    h.resolveLatest([
      { id: "c1", assignedUserId: "Agent A", status: "OPEN" },
    ]);
    await waitFor(() => h.latestData() !== undefined, 2000, 5);

    const callsBefore = h.queryFnCalls;

    // Two duplicate notifications. The client MUST NOT enter a
    // refetch loop. We assert a bounded count after several
    // invalidation attempts.
    for (let i = 0; i < 5; i++) {
      h.handleRealtime({
        type: "conversation:updated",
        payload: { conversationId: "c1" },
      });
    }

    // Let any queued refetches settle.
    await new Promise((r) => setTimeout(r, 100));

    const totalCalls = h.queryFnCalls;
    // Bounded: at most a small number of additional refetches.
    // TanStack Query may coalesce duplicates, so we allow up to
    // a small multiple of the number of dispatches.
    expect(totalCalls).toBeLessThan(callsBefore + 10);
  });
});
