export const reportReasons = {
  privacy: "개인정보·삭제 요청",
  copyright: "저작권·권리 침해",
  cheat: "치트 배포·판매",
  spam: "스팸·도배",
  accuracy: "내용 오류·정정",
  other: "기타 이의 요청",
} as const;
export type ReportReason = keyof typeof reportReasons;
export type ReportCommand = {
  postId?: string;
  reason: ReportReason;
  detail: string;
};
export type ReportFormState = {
  busy: boolean;
  error: string;
  sent: boolean;
  submit(reason: ReportReason, detail: string): Promise<void>;
};
export type OperatorReport = {
  id: string;
  postId: string | null;
  postTitle: string | null;
  reason: ReportReason;
  detail: string;
  createdAt: string;
};
