import { describe, expect, it } from "vitest";
import {
  feedHref,
  readFeedFilters,
  safeFeedReturn,
  safeListReturn,
} from "@/lib/feed-navigation";
import { safeReturnPath } from "@/lib/format";

describe("feed navigation", () => {
  it("preserves questions and the open filter through normalized list returns", () => {
    const from = "/questions?tag=IDA&q=api&page=2&open=1";
    expect(safeFeedReturn(from + "&token=private")).toBe(from);
    expect(safeListReturn(from)).toBe(from);
    expect(readFeedFilters({ open: "1" }).open).toBe(true);
    expect(readFeedFilters({ open: ["1"] }).open).toBeUndefined();
    expect(readFeedFilters({ open: "true" }).open).toBeUndefined();
    expect(safeFeedReturn("/questions/unknown?open=1")).toBe("/");
  });
  it("preserves exact resource routes and filters for shared post/write/auth return paths", () => {
    for (const path of [
      "/resources",
      "/resources/learning",
      "/resources/executables",
      "/resources/systems",
      "/resources/devices",
    ]) {
      const value =
        path +
        "?purpose=share&tag=Ghidra&q=analysis&page=2&private=hidden#comments";
      const expected = path + "?purpose=share&tag=Ghidra&q=analysis&page=2";
      expect(safeListReturn(value)).toBe(expected);
      expect(safeFeedReturn(value)).toBe(expected);
    }
    for (const value of [
      "//evil.test/resources",
      "/resources/unknown",
      "/resources/../api",
      "/resources\\evil",
      "/resources%2funknown",
      "https://evil.test/resources",
      "/resources\n",
    ]) {
      expect(safeListReturn(value)).toBe("/");
      expect(safeFeedReturn(value)).toBe("/");
    }
  });
  it("keeps the author's original status filter while preventing unrelated list return destinations", () => {
    expect(safeListReturn("/me?status=held&ignored=value")).toBe(
      "/me?status=held",
    );
    expect(safeListReturn("/me?status=held&status=published")).toBe("/me");
    expect(safeListReturn("/api/posts")).toBe("/");
    expect(safeListReturn("//other.example/me")).toBe("/");
  });
  it("handles duplicate auth return parameters and rejects control-character redirects", () => {
    expect(safeReturnPath(["/new", "/me"])).toBe("/");
    expect(safeReturnPath("/\n/other.example")).toBe("/");
    expect(safeReturnPath("/posts/id?from=%2F#comments")).toBe(
      "/posts/id?from=%2F#comments",
    );
  });
  it("keeps purpose, exact topic, search and page together across return navigation", () => {
    const filters = {
      purpose: "share" as const,
      tag: "Ghidra",
      query: "함수 & 분기",
      page: 2,
    };
    const href = feedHref(filters);
    expect(safeFeedReturn(href)).toBe(href);
    expect(
      readFeedFilters(
        Object.fromEntries(new URL(href, "https://example.com").searchParams),
      ),
    ).toEqual(filters);
  });
  it("rejects external, backslash and unrelated return destinations", () => {
    for (const value of [
      "https://other.example/",
      "//other.example/",
      "/\\other.example",
      "/login?returnTo=/new",
      "/posts/id",
      "/%2f%2fexample.com",
    ])
      expect(safeFeedReturn(value)).toBe("/");
  });
  it("normalizes legacy kinds without rewriting records and bounds malformed filters", () => {
    expect(readFeedFilters({ kind: "workflow" }).purpose).toBe("share");
    expect(
      readFeedFilters({
        purpose: "invalid",
        page: "Infinity",
        tag: ["private"],
      }),
    ).toEqual({
      purpose: undefined,
      tag: undefined,
      query: undefined,
      page: 1,
    });
    expect(
      readFeedFilters({ q: "a".repeat(400), tag: "b".repeat(100), page: "-2" })
        .query,
    ).toHaveLength(200);
    expect(readFeedFilters({ tag: "b".repeat(100) }).tag).toHaveLength(24);
  });
});
