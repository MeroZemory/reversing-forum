import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getViewer } from "./auth";
import { db } from "./db";
import { ForumError } from "./forum";
import { controlPublication } from "./publication-control";
import { recordPublishedRelations } from "./duplicates/index";

type Versions = {
  basisVersion: string;
  rightsVersion: string;
  rulesVersion: string;
};
type PublicData = {
  title: string;
  body: string;
  kind: "share";
  tags: string[];
  provenance: {
    type: "chat-editorial" | "independent-guide";
    period: string;
    verificationSummary: string;
  };
};
type Evidence = {
  referenceIds: string[];
  checks: {
    meaning: boolean;
    privacy: boolean;
    rights: boolean;
    externalTransfer: boolean;
  };
};
type DraftInput = Versions & {
  candidateKey: string;
  revision: number;
  sourceAliases: string[];
  publicData: PublicData;
  privateEvidence: Evidence;
};
type Review = {
  hash: string;
  epoch: number;
  basisGeneration: number;
  suppression: string;
  referenceId: string;
};
type Draft = DraftInput & {
  hash: string;
  epoch: number;
  state: "draft" | "approved" | "published" | "held" | "withdrawn";
  review: Review | null;
  approval: Review | null;
  screening: {
    hash: string;
    epoch: number;
    status: "pending" | "held" | "published";
    attempts: number;
    evidence?: string;
  } | null;
};
type Basis = { versions: string; allowed: number; generation: number };
type User = NonNullable<Awaited<ReturnType<typeof getViewer>>>;
const conflict = () =>
  new ForumError(409, "현재 초안과 검토 조건을 다시 확인해 주세요.");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ForumError(400, "허용된 필드만 입력해 주세요.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 1): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw new ForumError(400, "문자열 길이를 확인해 주세요.");
  return value.trim();
}
function opaque(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result))
    throw new ForumError(400, "불투명 ID 형식을 확인해 주세요.");
  return result;
}
function strings(
  value: unknown,
  max: number,
  parse: (value: unknown) => string,
): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ForumError(400, "목록 길이를 확인해 주세요.");
  return [...new Set(value.map(parse))].sort();
}
function versions(data: Record<string, unknown>): Versions {
  return {
    basisVersion: opaque(data.basisVersion),
    rightsVersion: opaque(data.rightsVersion),
    rulesVersion: opaque(data.rulesVersion),
  };
}
const versionKeys = ["basisVersion", "rightsVersion", "rulesVersion"];
const inputKeys = [
  "candidateKey",
  "revision",
  "sourceAliases",
  ...versionKeys,
  "publicData",
  "privateEvidence",
];
function draftInput(value: unknown): DraftInput {
  const d = object(value, inputKeys);
  if (!Number.isSafeInteger(d.revision) || (d.revision as number) < 1)
    throw new ForumError(400, "버전은 양의 정수여야 합니다.");
  const p = object(d.publicData, [
    "title",
    "body",
    "kind",
    "tags",
    "provenance",
  ]);
  const provenance = object(p.provenance, [
    "type",
    "period",
    "verificationSummary",
  ]);
  if (
    p.kind !== "share" ||
    !["chat-editorial", "independent-guide"].includes(provenance.type as string)
  )
    throw new ForumError(400, "출처와 글 종류를 확인해 주세요.");
  const e = object(d.privateEvidence, ["referenceIds", "checks"]);
  const checks = object(e.checks, [
    "meaning",
    "privacy",
    "rights",
    "externalTransfer",
  ]);
  if (
    Object.keys(checks).length !== 4 ||
    Object.values(checks).some((v) => typeof v !== "boolean")
  )
    throw new ForumError(400, "검토 항목을 확인해 주세요.");
  const result: DraftInput = {
    candidateKey: opaque(d.candidateKey),
    revision: d.revision as number,
    sourceAliases: strings(d.sourceAliases, 100, opaque),
    ...versions(d),
    publicData: {
      title: text(p.title, 160, 2),
      body: text(p.body, 30_000, 10),
      kind: "share",
      tags: strings(p.tags, 5, (v) => text(v, 24)),
      provenance: {
        type: provenance.type as PublicData["provenance"]["type"],
        period: text(provenance.period, 80),
        verificationSummary: text(provenance.verificationSummary, 1000),
      },
    },
    privateEvidence: {
      referenceIds: strings(e.referenceIds, 100, opaque),
      checks: checks as Evidence["checks"],
    },
  };
  if (
    result.publicData.provenance.type === "chat-editorial" &&
    !result.sourceAliases.length
  )
    throw new ForumError(400, "대화 편집 자료에는 원본 별칭이 필요합니다.");
  if (Buffer.byteLength(JSON.stringify(result.publicData), "utf8") > 120_000)
    throw new ForumError(413, "최종 공개본이 너무 큽니다.");
  return result;
}
async function editor(): Promise<User> {
  const user = await getViewer();
  if (!user) throw new ForumError(401, "로그인이 필요합니다.");
  if (!process.env.EDITOR_USER_ID || user.id !== process.env.EDITOR_USER_ID)
    throw new ForumError(403, "편집 권한이 필요합니다.");
  return user;
}
function load(key: string, user: User): Draft {
  const row = db
    .prepare(
      "SELECT editor_id,state FROM editorial_drafts WHERE candidate_key=?",
    )
    .get(key) as { editor_id: string; state: string } | undefined;
  if (!row || row.editor_id !== user.id)
    throw new ForumError(404, "초안을 찾을 수 없습니다.");
  return JSON.parse(row.state) as Draft;
}
function author(key?: string): { id: string; name: string } {
  const id = process.env.EDITORIAL_AUTHOR_USER_ID;
  if (!id) throw new ForumError(403, "자료 작성 계정 설정이 필요합니다.");
  if (id === process.env.EDITOR_USER_ID)
    throw new ForumError(403, "자료 작성 계정과 승인 운영자를 분리해 주세요.");
  const account = db
    .prepare('SELECT id,name FROM "user" WHERE id=?')
    .get(id) as { id: string; name: string } | undefined;
  if (!account) throw new ForumError(403, "실제 자료 작성 계정이 필요합니다.");
  if (key) {
    const row = db
      .prepare("SELECT author_id FROM editorial_drafts WHERE candidate_key=?")
      .get(key) as { author_id: string } | undefined;
    if (row?.author_id !== id) throw conflict();
  }
  return account;
}
function save(d: Draft) {
  db.prepare("UPDATE editorial_drafts SET state=? WHERE candidate_key=?").run(
    JSON.stringify(d),
    d.candidateKey,
  );
}
function audit(user: User, action: string, d?: Draft) {
  db.prepare(
    "INSERT INTO editorial_audit(candidate_key,actor_id,action,revision,hash,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    d?.candidateKey ?? null,
    user.id,
    action,
    d?.revision ?? null,
    d?.hash ?? null,
    new Date().toISOString(),
  );
}
function receipt(d: Draft) {
  return db
    .prepare(
      "SELECT p.id,p.status FROM editorial_receipts r JOIN posts p ON p.id=r.post_id WHERE r.candidate_key=?",
    )
    .get(d.candidateKey) as { id: string; status: string } | undefined;
}
function preview(d: Draft) {
  return {
    candidateKey: d.candidateKey,
    revision: d.revision,
    hash: d.hash,
    ...versions(d),
    state: d.state,
    publicData: d.publicData,
    reviewed: Boolean(d.review),
    approved: Boolean(d.approval),
    screeningStatus: d.screening?.status ?? null,
    post: receipt(d) ?? null,
  };
}
function currentBasis(d: Draft): Basis {
  const b = db.prepare("SELECT * FROM editorial_basis WHERE id=1").get() as
    Basis | undefined;
  if (!b?.allowed || b.versions !== JSON.stringify(versions(d)))
    throw conflict();
  return b;
}
function suppression(d: Draft): string {
  const keys = [
    "candidate:" + d.candidateKey,
    ...d.sourceAliases.map((s) => "alias:" + s),
  ].sort();
  return digest(
    keys.map((key) => [
      key,
      (
        db
          .prepare(
            "SELECT generation FROM editorial_suppression WHERE source_key=?",
          )
          .get(key) as { generation: number } | undefined
      )?.generation ?? 0,
    ]),
  );
}
function expected(d: Draft, data: Record<string, unknown>) {
  if (
    data.revision !== d.revision ||
    data.hash !== d.hash ||
    JSON.stringify(versions(data)) !== JSON.stringify(versions(d))
  )
    throw conflict();
}
function validReview(d: Draft, r: Review | null): boolean {
  const b = currentBasis(d);
  return Boolean(
    r &&
    r.hash === d.hash &&
    r.epoch === d.epoch &&
    r.basisGeneration === b.generation &&
    r.suppression === suppression(d),
  );
}
function gates(d: Draft) {
  if (
    d.state === "withdrawn" ||
    d.state === "held" ||
    !validReview(d, d.review) ||
    !validReview(d, d.approval)
  )
    throw conflict();
}

// Invalidation follows the alias graph, including aliases from older revisions.
// Suppression is never removed; a new staff review binds to its current generation.
function invalidate(
  user: User,
  initial: Draft[],
  action: "withdraw" | "revise" | "basis" | "hold",
) {
  const all = (
    db.prepare("SELECT state FROM editorial_drafts").all() as {
      state: string;
    }[]
  ).map((r) => JSON.parse(r.state) as Draft);
  const affected = new Set(initial.map((d) => d.candidateKey));
  const sources = db
    .prepare("SELECT candidate_key,alias FROM editorial_sources")
    .all() as { candidate_key: string; alias: string }[];
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of sources)
      if (affected.has(s.candidate_key)) aliases.add(s.alias);
    for (const s of sources)
      if (aliases.has(s.alias) && !affected.has(s.candidate_key)) {
        affected.add(s.candidate_key);
        changed = true;
      }
  }
  for (const key of [
    ...[...affected].map((k) => "candidate:" + k),
    ...[...aliases].map((a) => "alias:" + a),
  ])
    db.prepare(
      "INSERT INTO editorial_suppression(source_key,generation) VALUES(?,1) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1",
    ).run(key);
  for (const d of all.filter((d) => affected.has(d.candidateKey))) {
    d.epoch++;
    d.review = null;
    d.approval = null;
    d.screening = null;
    d.state =
      action === "withdraw" || d.state === "withdrawn" ? "withdrawn" : "held";
    save(d);
    db.prepare(
      "UPDATE posts SET status='held' WHERE id=(SELECT post_id FROM editorial_receipts WHERE candidate_key=?)",
    ).run(d.candidateKey);
    audit(user, action, d);
  }
}

export async function getEditorial(key: string) {
  const user = await editor();
  return preview(load(opaque(key), user));
}

export async function editorialCollectionAction(value: unknown) {
  const user = await editor();
  const data = object(value, ["action", ...inputKeys, "allowed"]);
  if (data.action === "basis") {
    object(data, ["action", ...versionKeys, "allowed"]);
    const tuple = versions(data);
    if (typeof data.allowed !== "boolean")
      throw new ForumError(400, "허용 여부가 필요합니다.");
    return db
      .transaction(() => {
        const old = db
          .prepare("SELECT * FROM editorial_basis WHERE id=1")
          .get() as Basis | undefined;
        if (
          old?.versions !== JSON.stringify(tuple) ||
          Boolean(old.allowed) !== data.allowed
        ) {
          const drafts = (
            db.prepare("SELECT state FROM editorial_drafts").all() as {
              state: string;
            }[]
          ).map((r) => JSON.parse(r.state) as Draft);
          invalidate(user, drafts, "basis");
          db.prepare(
            "INSERT INTO editorial_basis(id,versions,allowed,generation) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET versions=excluded.versions,allowed=excluded.allowed,generation=excluded.generation",
          ).run(
            JSON.stringify(tuple),
            data.allowed ? 1 : 0,
            (old?.generation ?? 0) + 1,
          );
          audit(user, "basis");
        }
        return { ...tuple, allowed: data.allowed };
      })
      .immediate();
  }
  if (data.action !== "ingest")
    throw new ForumError(400, "지원하지 않는 작업입니다.");
  const { action: _action, ...payload } = data;
  const input = draftInput(payload);
  return db
    .transaction(() => {
      const account = author();
      const old = db
        .prepare(
          "SELECT candidate_key FROM editorial_drafts WHERE candidate_key=?",
        )
        .get(input.candidateKey);
      if (old) {
        const d = load(input.candidateKey, user);
        const r = db
          .prepare(
            "SELECT payload_hash FROM editorial_revisions WHERE candidate_key=? AND revision=?",
          )
          .get(input.candidateKey, input.revision) as
          { payload_hash: string } | undefined;
        if (r?.payload_hash !== digest(input)) throw conflict();
        return preview(d);
      }
      if (input.revision !== 1) throw conflict();
      const d: Draft = {
        ...input,
        hash: digest(input.publicData),
        epoch: 0,
        state: "draft",
        review: null,
        approval: null,
        screening: null,
      };
      db.prepare(
        "INSERT INTO editorial_drafts(candidate_key,author_id,editor_id,state) VALUES(?,?,?,?)",
      ).run(input.candidateKey, account.id, user.id, JSON.stringify(d));
      registerRevision(input);
      audit(user, "ingest", d);
      return preview(d);
    })
    .immediate();
}
function registerRevision(input: DraftInput) {
  db.prepare(
    "INSERT INTO editorial_revisions(candidate_key,revision,payload_hash,hash,versions) VALUES(?,?,?,?,?)",
  ).run(
    input.candidateKey,
    input.revision,
    digest(input),
    digest(input.publicData),
    JSON.stringify(versions(input)),
  );
  for (const alias of input.sourceAliases)
    db.prepare(
      "INSERT OR IGNORE INTO editorial_sources(candidate_key,alias) VALUES(?,?)",
    ).run(input.candidateKey, alias);
}

export async function editorialAction(key: string, value: unknown) {
  const user = await editor();
  key = opaque(key);
  const data = object(value, [
    "action",
    "revision",
    "hash",
    ...versionKeys,
    "review",
    "draft",
  ]);
  const action = data.action;
  if (
    !["review", "approve", "publish", "revise", "withdraw", "hold"].includes(
      action as string,
    )
  )
    throw new ForumError(400, "지원하지 않는 작업입니다.");
  object(data, [
    "action",
    "revision",
    "hash",
    ...versionKeys,
    ...(action === "review"
      ? ["review"]
      : action === "revise"
        ? ["draft"]
        : []),
  ]);
  if (
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 1 ||
    typeof data.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.hash)
  )
    throw new ForumError(400, "초안 버전과 해시를 확인해 주세요.");
  versions(data);
  if (action === "publish") {
    const requestKey = digest([
      user.id,
      key,
      data.revision,
      data.hash,
      versions(data),
    ]);
    const existing = publicationsInFlight.get(requestKey);
    if (existing) return existing;
    const work = publish(key, data, user);
    publicationsInFlight.set(requestKey, work);
    try {
      return await work;
    } finally {
      publicationsInFlight.delete(requestKey);
    }
  }
  return db
    .transaction(() => {
      let d = load(key, user);
      // A repeated withdrawal returns the current state after response loss.
      if (action === "revise") {
        const input = draftInput(data.draft);
        const prior = db
          .prepare(
            "SELECT hash,versions FROM editorial_revisions WHERE candidate_key=? AND revision=?",
          )
          .get(key, data.revision as number) as
          { hash: string; versions: string } | undefined;
        if (
          !prior ||
          input.candidateKey !== key ||
          input.revision !== (data.revision as number) + 1 ||
          prior.hash !== data.hash ||
          prior.versions !== JSON.stringify(versions(data))
        )
          throw conflict();
        const repeated = db
          .prepare(
            "SELECT payload_hash FROM editorial_revisions WHERE candidate_key=? AND revision=?",
          )
          .get(key, input.revision) as { payload_hash: string } | undefined;
        if (repeated) {
          if (repeated.payload_hash !== digest(input)) throw conflict();
          return preview(d);
        }
      }
      expected(d, data);
      if (action === "hold") {
        if (d.state !== "held" && d.state !== "withdrawn")
          invalidate(user, [d], "hold");
        return preview(load(key, user));
      }
      if (action === "withdraw") {
        if (d.state !== "withdrawn") invalidate(user, [d], "withdraw");
        return preview(load(key, user));
      }
      if (action === "revise") {
        const input = draftInput(data.draft);
        if (input.candidateKey !== key || input.revision !== d.revision + 1)
          throw conflict();
        invalidate(user, [d], "revise");
        d = {
          ...input,
          hash: digest(input.publicData),
          epoch: load(key, user).epoch,
          state: "draft",
          review: null,
          approval: null,
          screening: null,
        };
        registerRevision(input);
        save(d);
        audit(user, "revise", d);
        return preview(d);
      }
      if (d.state === "withdrawn" || d.state === "published") throw conflict();
      const basis = currentBasis(d);
      if (action === "review") {
        const r = object(data.review, [
          "model",
          "effort",
          "referenceId",
          "compared",
          "checks",
        ]);
        const checks = object(r.checks, [
          "meaning",
          "privacy",
          "rights",
          "externalTransfer",
        ]);
        if (
          r.model !== "sol" ||
          r.effort !== "xhigh" ||
          r.compared !== true ||
          Object.keys(checks).length !== 4 ||
          Object.values(checks).some((v) => v !== true) ||
          Object.values(d.privateEvidence.checks).some((v) => v !== true) ||
          !d.privateEvidence.referenceIds.length
        )
          throw new ForumError(400, "최종본 대조와 검토 기록이 필요합니다.");
        d.epoch++;
        d.review = {
          hash: d.hash,
          epoch: d.epoch,
          basisGeneration: basis.generation,
          suppression: suppression(d),
          referenceId: opaque(r.referenceId),
        };
        d.approval = null;
        d.screening = null;
        d.state = "draft";
      } else {
        if (!validReview(d, d.review)) throw conflict();
        d.approval = { ...d.review! };
        d.state = "approved";
      }
      save(d);
      audit(user, action as string, d);
      return preview(d);
    })
    .immediate();
}

const publicationsInFlight = new Map<
  string,
  Promise<ReturnType<typeof preview>>
>();

async function publish(key: string, data: Record<string, unknown>, user: User) {
  const start = db
    .transaction(() => {
      const d = load(key, user);
      author(key);
      // A publication retry returns the post's current status, including held.
      const published = db
        .prepare(
          "SELECT hash,versions FROM editorial_publications WHERE candidate_key=? AND revision=?",
        )
        .get(key, data.revision as number) as
        { hash: string; versions: string } | undefined;
      if (published) {
        if (
          published.hash !== data.hash ||
          published.versions !== JSON.stringify(versions(data))
        )
          throw conflict();
        const recorded = db
          .prepare(
            "SELECT payload_hash FROM editorial_revisions WHERE candidate_key=? AND revision=?",
          )
          .get(key, data.revision as number);
        if (!recorded) throw conflict();
        return { result: preview(d) };
      }
      expected(d, data);
      gates(d);
      if (d.screening?.status === "held" || (d.screening?.attempts ?? 0) >= 3)
        throw conflict();
      const attempt = (d.screening?.attempts ?? 0) + 1;
      d.screening = {
        hash: d.hash,
        epoch: d.epoch,
        status: "pending",
        attempts: attempt,
      };
      save(d);
      audit(user, "screen", d);
      return { draft: d, attempt };
    })
    .immediate();
  if (start.result) return start.result;
  const snapshot = start.draft!;
  let currentUser = user;
  return controlPublication(
    {
      key: `editorial:${key}:${snapshot.revision}:${digest([snapshot.publicData, versions(snapshot)])}`,
      lane: "editorial",
      snapshot: snapshot.publicData,
      excludePostId: receipt(snapshot)?.id,
    },
    (result) => {
      const d = load(key, currentUser);
      const account = author(key);
      const published = db
        .prepare(
          "SELECT hash FROM editorial_publications WHERE candidate_key=? AND revision=?",
        )
        .get(key, snapshot.revision) as { hash: string } | undefined;
      if (published?.hash === snapshot.hash) return preview(d);
      if (
        d.revision !== snapshot.revision ||
        d.hash !== snapshot.hash ||
        d.epoch !== snapshot.epoch
      )
        throw conflict();
      gates(d);
      // Only the latest outstanding attempt may commit a result.
      if (d.screening?.attempts !== start.attempt) throw conflict();
      d.screening.status = result.status;
      d.screening.evidence = result.evidence;
      if (result.status !== "published") {
        save(d);
        audit(user, "screen-result", d);
        return preview(d);
      }
      const old = receipt(d);
      const id = old?.id ?? randomUUID();
      const p = d.publicData;
      // The public editorial contract uses purpose; legacy post storage uses kind.
      const storedKind = "analysis";
      if (old) {
        db.prepare(
          "UPDATE posts SET title=?,body=?,kind=?,tags=?,status='published',screening_evidence=NULL WHERE id=?",
        ).run(p.title, p.body, storedKind, JSON.stringify(p.tags), id);
      } else {
        db.prepare(
          "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",
        ).run(
          id,
          account.id,
          account.name,
          p.title,
          p.body,
          storedKind,
          JSON.stringify(p.tags),
          new Date().toISOString(),
        );
      }
      db.prepare(
        "INSERT INTO editorial_receipts(candidate_key,post_id,revision,hash,provenance) VALUES(?,?,?,?,?) ON CONFLICT(candidate_key) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,provenance=excluded.provenance",
      ).run(key, id, d.revision, d.hash, JSON.stringify(p.provenance));
      recordPublishedRelations(
        id,
        result.relatedPublishedIds ?? [],
        result.corpusHash,
      );
      db.prepare(
        "INSERT INTO editorial_publications(candidate_key,revision,hash,versions,post_id) VALUES(?,?,?,?,?)",
      ).run(key, d.revision, d.hash, JSON.stringify(versions(d)), id);
      d.state = "published";
      save(d);
      audit(user, "publish", d);
      return preview(d);
    },
    async () => {
      currentUser = await editor();
      if (currentUser.id !== user.id) throw conflict();
    },
  );
}
