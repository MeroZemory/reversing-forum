// Use only synthetic, nonpersonal technical content for access and usage checks.
export {};
delete process.env.JEV_MOCK;
process.env.JEV_BUDGET_USD = "10";
process.env.JEV_BUDGET_PATH = "data/chat-pipeline/jev-budget.sqlite";
const { screenPost } = await import("../src/server/jev");
const result = await screenPost(
  JSON.stringify({
    title: "분석 도구를 비교할 때 확인할 항목",
    body: "분석 대상의 실행 환경과 파일 형식을 기록하고, 도구가 지원하는 환경을 확인합니다. 도구의 결과는 별도의 근거와 함께 검토합니다.",
    kind: "share",
    tags: ["분석 도구"],
    provenance: {
      type: "independent-guide",
      period: "합성 검증 자료",
      verificationSummary: "실제 대화에서 얻은 자료가 아닌 합성 예제입니다.",
    },
  }),
);
const evidence = JSON.parse(result.evidence);
console.log(
  JSON.stringify({
    status: result.status,
    reason: evidence.reason ?? null,
    requestedModel: evidence.requestedModel ?? null,
    resolvedModel: evidence.resolvedModel ?? null,
    usage: evidence.usage ?? null,
  }),
);
