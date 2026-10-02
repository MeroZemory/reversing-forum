import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  duplicate: vi.fn(),
  jev: vi.fn(),
  corpus: vi.fn(),
}));
vi.mock("@/server/duplicates/index", () => ({
  assessDuplicate: mocks.duplicate,
  publicCorpusHash: mocks.corpus,
}));
vi.mock("@/server/jev", () => ({ screenPost: mocks.jev }));
let api: typeof import("@/server/publication-control");
let db: (typeof import("@/server/db"))["db"];
const snapshot = {
  title: "Synthetic analysis",
  body: "Synthetic complete technical explanation",
  kind: "analysis",
  tags: ["test"],
  provenance: { period: "synthetic" },
};
const run = (
  key = "test",
  commit = (r: import("@/server/publication-control").PublicationResult) => r,
) => api.controlPublication({ key, snapshot }, commit);
const assessment = (verdict = "distinct") => ({
  verdict,
  relatedPostIds: [],
  evidence: "private evidence",
  corpusHash: "corpus-1",
});
beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  ({ db } = await import("@/server/db"));
  api = await import("@/server/publication-control");
  (await import("@/server/publication-control")).initPublicationTables();
});
beforeEach(() => {
  vi.useRealTimers();
  db.exec(
    "DELETE FROM publication_lease; DELETE FROM publication_limits; DELETE FROM publication_attempts; DELETE FROM comments; DELETE FROM posts;",
  );
  mocks.duplicate.mockReset().mockResolvedValue(assessment());
  mocks.jev
    .mockReset()
    .mockResolvedValue({ status: "published", evidence: "private Jev" });
  mocks.corpus.mockReset().mockReturnValue("corpus-1");
});
afterAll(() => {
  vi.useRealTimers();
  db.close();
});

it("gives authenticated editorial batches their own rate lane while sharing the lease", async () => {
  for (let n = 0; n < 6; n++)
    expect((await run(`member-${n}`)).status).toBe("published");
  expect((await run("member-blocked")).status).toBe("pending");
  for (let n = 0; n < 7; n++) {
    expect(
      (
        await api.controlPublication(
          { key: `editorial-${n}`, snapshot, lane: "editorial" },
          (r) => r,
        )
      ).status,
    ).toBe("published");
  }
  expect(mocks.duplicate).toHaveBeenCalledTimes(13);
  db.prepare(
    "UPDATE publication_limits SET attempts=120 WHERE scope='editorial:minute'",
  ).run();
  expect(
    (
      await api.controlPublication(
        { key: "editorial-minute-blocked", snapshot, lane: "editorial" },
        (r) => r,
      )
    ).status,
  ).toBe("pending");
  db.prepare(
    "UPDATE publication_limits SET attempts=0 WHERE scope='editorial:minute'",
  ).run();
  db.prepare(
    "UPDATE publication_limits SET attempts=2000 WHERE scope='editorial:hour'",
  ).run();
  expect(
    (
      await api.controlPublication(
        { key: "editorial-hour-blocked", snapshot, lane: "editorial" },
        (r) => r,
      )
    ).status,
  ).toBe("pending");
  expect(mocks.jev).toHaveBeenCalledTimes(13);
});

it("leaves a 15s duplicate judge plus 90s CLI plus 15s minimum gate private at the member deadline", async () => {
  vi.useFakeTimers();
  mocks.duplicate.mockImplementationOnce(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(assessment()), 105_000),
      ),
  );
  mocks.jev.mockImplementationOnce(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "published",
              evidence: "synthetic bounded gate",
            }),
          15_000,
        ),
      ),
  );
  const result = run("bounded-long-comparison");
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await result).status).toBe("pending");
  expect(db.prepare("SELECT * FROM publication_lease").get()).toBeTruthy();
});

it("passes the full snapshot to Jev and commits under a SQLite transaction", async () => {
  const result = await run("full", (r) => {
    expect(db.inTransaction).toBe(true);
    return r;
  });
  expect(result.status).toBe("published");
  expect(JSON.parse(mocks.jev.mock.calls[0][0])).toEqual(snapshot);
  expect(mocks.duplicate).toHaveBeenCalledWith(
    {
      title: snapshot.title,
      body: snapshot.body,
      tags: snapshot.tags,
      excludePostId: undefined,
    },
    { independentReview: undefined },
  );
  expect(db.prepare("SELECT * FROM publication_lease").all()).toEqual([]);
});

it("allows a 90s CLI comparison followed by the 15s minimum gate within member headroom", async () => {
  vi.useFakeTimers();
  mocks.duplicate.mockImplementationOnce(
    () =>
      new Promise((resolve) => setTimeout(() => resolve(assessment()), 90_000)),
  );
  mocks.jev.mockImplementationOnce(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "published",
              evidence: "synthetic bounded gate",
            }),
          15_000,
        ),
      ),
  );
  const result = run("cli-and-minimum");
  await vi.advanceTimersByTimeAsync(105_000);
  expect((await result).status).toBe("published");
  expect(db.prepare("SELECT * FROM publication_lease").get()).toBeUndefined();
});

it.each(["distinct", "related", "overlap"])(
  "allows %s only together with Jev pass",
  async (verdict) => {
    mocks.duplicate.mockResolvedValue(assessment(verdict));
    expect((await run()).status).toBe("published");
    mocks.jev.mockResolvedValue({
      status: "pending",
      evidence: "budget exhausted",
    });
    expect((await run("other")).status).toBe("pending");
  },
);

it.each(["duplicate", "uncertain"])(
  "keeps %s private without a Jev call",
  async (verdict) => {
    mocks.duplicate.mockResolvedValue(assessment(verdict));
    expect((await run()).status).toBe(
      verdict === "duplicate" ? "held" : "pending",
    );
    expect(mocks.jev).not.toHaveBeenCalled();
  },
);

it("fails closed on detector and Jev errors and uncertainty", async () => {
  mocks.duplicate.mockRejectedValueOnce(new Error("synthetic unavailable"));
  expect((await run()).status).toBe("pending");
  mocks.jev.mockRejectedValueOnce(new Error("synthetic unavailable"));
  expect((await run()).status).toBe("pending");
  mocks.jev.mockResolvedValueOnce({
    status: "held",
    evidence: JSON.stringify({ answers: { spam: { choice: "uncertain" } } }),
  });
  expect((await run()).status).toBe("pending");
});

it("holds only a confirmed Jev violation and leaves ambiguous violations pending", async () => {
  const evidence = (confidence: number) =>
    JSON.stringify({
      answers: {
        spam: {
          type: "choice",
          choice: "violation",
          confidence,
          probabilities: { violation: 0.98, allowed: 0.01, uncertain: 0.01 },
        },
      },
    });
  mocks.jev.mockResolvedValueOnce({ status: "held", evidence: evidence(0.5) });
  expect((await run("uncertain-violation")).status).toBe("pending");
  mocks.jev.mockResolvedValueOnce({ status: "held", evidence: evidence(0.98) });
  expect((await run("confirmed-violation")).status).toBe("held");
});

it("serializes paid work globally and a retry sees the changed corpus", async () => {
  let release!: (value: ReturnType<typeof assessment>) => void;
  mocks.duplicate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = run("normal", (r) => {
    mocks.corpus.mockReturnValue("corpus-2");
    return r;
  });
  expect((await run("editorial")).status).toBe("pending");
  expect(mocks.duplicate).toHaveBeenCalledTimes(1);
  expect(mocks.jev).not.toHaveBeenCalled();
  release(assessment());
  expect((await first).status).toBe("published");
  mocks.duplicate.mockResolvedValue({
    ...assessment("duplicate"),
    corpusHash: "corpus-2",
  });
  expect((await run("editorial")).status).toBe("held");
  expect(mocks.jev).toHaveBeenCalledTimes(1);
});

it("rejects a stale corpus inside commit and fences a replaced token", async () => {
  mocks.jev.mockImplementationOnce(async () => {
    mocks.corpus.mockReturnValue("corpus-2");
    return { status: "published", evidence: "pass" };
  });
  expect((await run()).evidence).toContain("corpus_changed");
  mocks.jev.mockImplementationOnce(async () => {
    db.prepare("UPDATE publication_lease SET token='successor'").run();
    return { status: "published", evidence: "pass" };
  });
  expect((await run()).evidence).toContain("lease_lost");
  expect(db.prepare("SELECT token FROM publication_lease").get()).toEqual({
    token: "successor",
  });
});

it("heartbeats, bounds time, quarantines late work and never starts Jev after timeout", async () => {
  vi.useFakeTimers();
  let release!: (value: ReturnType<typeof assessment>) => void;
  mocks.duplicate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = run();
  const initial = db
    .prepare("SELECT expires_at FROM publication_lease")
    .get() as { expires_at: number };
  await vi.advanceTimersByTimeAsync(20_000);
  const extended = db
    .prepare("SELECT expires_at FROM publication_lease")
    .get() as { expires_at: number };
  expect(extended.expires_at).toBeGreaterThan(initial.expires_at);
  await vi.advanceTimersByTimeAsync(90_000);
  expect((await first).evidence).toContain("screening_timeout");
  expect((await run("second")).evidence).toContain("publication_busy");
  release(assessment());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.jev).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150_000);
  expect((await run("second")).status).toBe("published");
});

it("bounds per-snapshot retries, global calls, and rejected author attempts", async () => {
  mocks.jev.mockResolvedValue({ status: "pending", evidence: "missing key" });
  for (let n = 0; n < 3; n++) await run();
  expect((await run()).evidence).toContain("attempt_limit");
  for (let n = 0; n < 3; n++) await run(`other-${n}`);
  expect((await run("global-blocked")).evidence).toContain("global_call_limit");
  expect(mocks.jev).toHaveBeenCalledTimes(6);
  for (let n = 0; n < 10; n++)
    expect(api.allowWriteAttempt("author")).toBe(true);
  expect(api.allowWriteAttempt("author")).toBe(false);
  expect(api.allowWriteAttempt("another")).toBe(true);
});

it("retains only public related IDs and excludes only the explicit prior post", async () => {
  const insert = db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,'author','name','title','body','analysis','[]',?,'synthetic')",
  );
  insert.run("public", "published");
  insert.run("private", "pending");
  insert.run("prior", "published");
  mocks.duplicate.mockResolvedValue({
    ...assessment("related"),
    relatedPostIds: ["public", "private", "prior", "missing"],
  });
  const result = await api.controlPublication(
    { key: "revision", snapshot, excludePostId: "prior" },
    (r) => r,
  );
  expect(JSON.parse(result.evidence).duplicate.relatedPostIds).toEqual([
    "public",
  ]);
  expect(mocks.corpus).toHaveBeenCalledWith("prior");
  expect(mocks.duplicate.mock.calls[0][0].excludePostId).toBe("prior");
});

it("rolls back the callback's writes and releases the lease on failure", async () => {
  await expect(
    run("rollback", () => {
      db.prepare("INSERT INTO publication_limits VALUES('rollback',0,1)").run();
      throw new Error("synthetic commit failure");
    }),
  ).rejects.toThrow("synthetic commit failure");
  expect(
    db.prepare("SELECT * FROM publication_limits WHERE scope='rollback'").get(),
  ).toBeUndefined();
  expect(db.prepare("SELECT * FROM publication_lease").get()).toBeUndefined();
});
