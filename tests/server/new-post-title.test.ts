import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getViewer: vi.fn() }));
vi.mock("@/server/auth", () => auth);
vi.mock("@/server/forum", () => ({
  ForumError: class extends Error {},
  getPost: vi.fn(),
  getEditablePost: vi.fn(),
  listComments: vi.fn(),
  listMyPosts: vi.fn(),
  listPostPage: vi.fn(),
  listPublicTopics: vi.fn(),
  listAllPublicTopics: vi.fn(),
}));
vi.mock("@/server/duplicates/index", () => ({ relatedPublicPosts: vi.fn() }));
vi.mock("@/server/publication-notice", () => ({ publicationNotice: vi.fn() }));
vi.mock("@/server/resource-curation", () => ({
  currentResourceSelection: vi.fn(),
}));
import { loadNewPostScreen } from "@/server/screens";

beforeEach(() => auth.getViewer.mockResolvedValue(null));
describe("new post title destination", () => {
  it("preserves a bounded title, purpose and list destination through login", async () => {
    const title = "분석 & 디버깅? ".repeat(25);
    const result = await loadNewPostScreen({
      title,
      purpose: "question",
      from: "/resources",
    });
    expect(result.kind).toBe("redirect");
    if (result.kind !== "redirect") return;
    const returnTo = new URL(
      result.href,
      "https://example.test",
    ).searchParams.get("returnTo")!;
    const destination = new URL(returnTo, "https://example.test");
    expect(destination.pathname).toBe("/new");
    expect(destination.searchParams.get("title")).toBe(title.slice(0, 160));
    expect(destination.searchParams.get("purpose")).toBe("question");
    expect(destination.searchParams.get("from")).toBe("/resources");
  });
  it("passes the title only as composer data and ignores array parameters", async () => {
    auth.getViewer.mockResolvedValue({ id: "member", name: "회원" });
    const ready = await loadNewPostScreen({
      title: "HTTP 지연",
      purpose: "question",
    });
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready")
      expect(ready.data.initialTitle).toBe("HTTP 지연");
    const array = await loadNewPostScreen({ title: ["첫째", "둘째"] });
    if (array.kind === "ready") expect(array.data.initialTitle).toBeUndefined();
  });
  it.each([
    ["nicknameReady", "/onboarding"],
    ["emailVerified", "/account"],
  ])("keeps title through the %s gate", async (field, path) => {
    auth.getViewer.mockResolvedValue({ id: "member", [field]: false });
    const result = await loadNewPostScreen({ title: "HTTP 지연" });
    if (result.kind !== "redirect") throw new Error("Expected account gate");
    const gate = new URL(result.href, "https://example.test");
    expect(gate.pathname).toBe(path);
    expect(
      new URL(
        gate.searchParams.get("returnTo")!,
        "https://example.test",
      ).searchParams.get("title"),
    ).toBe("HTTP 지연");
  });
});
