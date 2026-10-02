import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDuplicateDetector } from "../src/server/duplicates/index";

// Real local embeddings + real budgeted Jev/CLI, against synthetic public posts.
// No original chats or real forum inserts. Results never include model evidence.
const directory = resolve("data/duplicates/evaluation");
mkdirSync(directory, { recursive: true });
const db = new Database(":memory:");
db.exec(
  "CREATE TABLE posts(id TEXT PRIMARY KEY,title TEXT,body TEXT,tags TEXT,status TEXT)",
);
const first = {
  id: "mask",
  title: "펌웨어 1.0의 XOR 값 복원",
  body: "펌웨어 1.0은 부호 없는 32비트 값을 0x55와 XOR한 상태로 저장합니다. 저장된 값에 0x55를 다시 XOR하면 원래 값으로 돌아옵니다. 같은 마스크를 두 번 적용하면 서로 상쇄되기 때문입니다.",
  tags: ["펌웨어", "XOR"],
};
const second = {
  id: "endian",
  title: "리틀 엔디언 4바이트 정수 읽기",
  body: "리틀 엔디언 4바이트 부호 없는 정수는 메모리 순서의 바이트 b0, b1, b2, b3을 b0 + 256*b1 + 65536*b2 + 16777216*b3으로 합쳐 읽습니다. b0이 가장 먼저 저장된 바이트입니다.",
  tags: ["엔디언", "메모리"],
};
const third = {
  id: "breakpoint",
  title: "관찰용 DLL 중단점",
  body: "승인된 학습용 DLL의 실행 흐름을 관찰할 때 알려진 함수 진입점에 중단점을 설정합니다. 해당 함수가 실행되면 디버거가 멈추므로 호출 스택과 인수를 읽을 수 있습니다. 중단점은 함수를 호출하게 만드는 기능이 아니므로 실행되지 않는 함수에서는 멈추지 않습니다.",
  tags: ["DLL", "디버깅"],
};
for (const post of [first, second, third])
  db.prepare("INSERT INTO posts VALUES(?,?,?,?, 'published')").run(
    post.id,
    post.title,
    post.body,
    JSON.stringify(post.tags),
  );
const cases = [
  {
    name: "한국어 재표현",
    duplicate: true,
    title: "같은 XOR 마스크로 값 되돌리기",
    body: "펌웨어 1.0에서 unsigned 32비트 저장값은 XOR 0x55 처리가 돼 있습니다. 복원할 때도 0x55를 한 번 XOR합니다. 동일한 마스크의 XOR을 반복하면 효과가 없어져 초기 값이 나옵니다.",
    tags: first.tags,
  },
  {
    name: "문단 재배열과 빈말",
    duplicate: true,
    title: "복원 방법 다시 정리",
    body: "이 방법을 알아 두면 편리합니다. 같은 마스크를 두 번 XOR하면 서로 상쇄됩니다. 따라서 펌웨어 1.0의 unsigned 32비트 저장값을 복원할 때는 0x55를 다시 XOR하면 됩니다. 저장 단계에 XOR 0x55가 적용됐기 때문입니다. 차근차근 살펴보세요.",
    tags: first.tags,
  },
  {
    name: "여러 글 짜깁기",
    duplicate: true,
    title: "정수 읽기와 XOR 복원",
    body: second.body + "\n\n" + first.body,
    tags: ["메모리", "XOR"],
  },
  {
    name: "상수와 환경 변경",
    duplicate: false,
    title: "펌웨어 2.0의 마스크 변경",
    body: "펌웨어 2.0에서는 저장 마스크가 0x55에서 0xAA로 바뀌었습니다. 2.0 값은 XOR 0xAA로 복원해야 합니다. 이전의 0x55를 그대로 적용하면 원래 값이 나오지 않습니다. 버전에 따라 마스크를 선택해야 합니다.",
    tags: first.tags,
  },
  {
    name: "새 정정과 한계",
    duplicate: false,
    title: "XOR 설명의 적용 조건 정정",
    body: "0x55를 다시 XOR하면 값이 복원된다는 설명은 저장값 전체에 같은 32비트 마스크를 적용했을 때만 맞습니다. 실제 형식이 바이트마다 다른 마스크를 사용한다면 32비트 0x55 한 번으로 복원되지 않습니다. 원래 설명에서 이 조건을 생략하면 오해할 수 있으므로 저장 형식을 먼저 확인해야 합니다.",
    tags: first.tags,
  },
  {
    name: "다른 실패 조건",
    duplicate: false,
    title: "같은 DLL을 여러 프로세스가 읽는 경우",
    body: "학습용 DLL을 부모와 자식 프로세스가 각각 로드하는 실험에서 부모 프로세스의 중단점은 자식 프로세스의 호출을 관찰하지 못했습니다. 실제로 함수를 호출하는 자식 프로세스에 디버거를 연결해야 했습니다. 이 실험에서는 부모와 자식을 구별하는 것이 추가 조건입니다.",
    tags: third.tags,
  },
  {
    name: "공통 코드지만 새 설명",
    duplicate: false,
    title: "엔디언 계산의 입력 범위 확인",
    body:
      second.body +
      "\n\n이 수식의 각 입력은 0부터 255까지의 부호 없는 바이트여야 합니다. signed char의 음수를 그대로 넣으면 합계가 틀립니다. 예를 들어 첫 바이트가 0xFF일 때 -1이 아니라 255로 변환한 뒤 계산해야 한다는 점을 확인합니다.",
    tags: second.tags,
  },
];
const detector = createDuplicateDetector({ store: db });
const results: unknown[] = [];
const selected = process.argv[2]
  ? cases.filter((c) => c.name === process.argv[2])
  : cases;
if (!selected.length) throw new Error("unknown-evaluation-case");
try {
  for (const item of selected) {
    const started = Date.now();
    const result = await detector.assessDuplicate({
      title: item.title,
      body: item.body,
      tags: item.tags,
    });
    const passed = item.duplicate
      ? result.verdict === "duplicate"
      : ["distinct", "related", "overlap"].includes(result.verdict);
    const record = {
      case: item.name,
      expectedDuplicate: item.duplicate,
      verdict: result.verdict,
      passed,
      relatedPostIds: result.relatedPostIds,
      elapsedMs: Date.now() - started,
    };
    results.push(record);
    console.log(JSON.stringify(record));
    writeFileSync(
      resolve(directory, "results.json"),
      JSON.stringify(results, null, 2),
    );
    if (!passed) process.exitCode = 1;
  }
} finally {
  db.close();
}
