/* Reversing All 목업 · 공통 계산, 본문 렌더러, 예시 자료(EX_*)
   구현 때 같은 규칙을 서버(또는 공용 lib)의 같은 이름 함수로 옮긴다. */
(function () {
  "use strict";
  const S = window.SNAPSHOT;

  /* ───────── 글 목적 ───────── */
  // 저장 유형(kind) → 화면 목적(purpose). 기존 lib/types.ts postKindToPurpose 와 같다.
  const PURPOSE = { question: "question", analysis: "share", workflow: "share", discussion: "free" };
  const PURPOSE_LABEL = { question: "질문", share: "공유", free: "자유" };
  const purposeOf = (p) => PURPOSE[p.k] || "free";

  /* ───────── 주제 별칭(표시 단계에서만 합침, 저장된 태그는 바꾸지 않음) ───────── */
  // 실제 태그 497개에서 찾은 표기 차이. 의미가 다른 말(디버거/디버깅 등)은 합치지 않는다.
  const ALIASES = {
    "리버싱": ["리버스 엔지니어링", "역공학"],
    "악성코드 분석": ["악성 코드 분석"],
    "악성코드": ["악성 코드"],
    "Windows": ["윈도우"],
    "Linux": ["리눅스"],
    "OllyDbg": ["올리디버거"],
    "IDA": ["IDA Pro"],
    "Android": ["안드로이드"],
    "PEview": ["PEView"],
    "운영체제": ["운영 체제"],
    "Windows API": ["윈도 API"],
  };
  const CANON = {};
  Object.entries(ALIASES).forEach(([c, list]) => list.forEach((a) => (CANON[a.toLowerCase()] = c)));
  const canon = (t) => CANON[t.toLowerCase()] || t;

  function topicIndex(posts) {
    const m = new Map();
    posts.forEach((p) =>
      new Set(p.g.map(canon)).forEach((t) => {
        const e = m.get(t) || { tag: t, n: 0 };
        e.n++;
        m.set(t, e);
      })
    );
    return [...m.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, "ko"));
  }

  /* ───────── 글자 처리 ───────── */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function markText(htmlSafe, q) {
    if (!q) return htmlSafe;
    const re = new RegExp("(" + reEsc(esc(q)) + ")", "gi");
    return htmlSafe.replace(re, "<mark>$1</mark>");
  }

  // 인라인: `code`, [text](url), **bold**. 링크는 rel=nofollow ugc noopener (기존 MarkdownBody 규칙)
  function inline(s, q) {
    const parts = String(s).split(/(`[^`]+`)/);
    return parts
      .map((part) => {
        if (/^`[^`]+`$/.test(part)) return "<code>" + markText(esc(part.slice(1, -1)), q) + "</code>";
        let h = esc(part);
        h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" rel="nofollow ugc noopener noreferrer" target="_blank">${t}</a>`);
        h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        return markText(h, q);
      })
      .join("");
  }

  const SUPP_RE = /\n#{2,3} 편집자 보충/;
  const hasSupp = (p) => SUPP_RE.test("\n" + p.b);
  const srcLinks = (p) => {
    const line = (p.b.match(/^출처:.*$/m) || [""])[0];
    return [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ title: m[1], url: m[2] }));
  };

  // 목록 미리보기: 기록 부분(편집자 보충 앞)의 평문. 검색어가 있으면 첫 일치 주변.
  function plain(b) {
    let rec = ("\n" + b).split(SUPP_RE)[0];
    rec = rec
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,4} .*$/gm, "")
      .replace(/^\s*[-*] /gm, "")
      .replace(/^\s*\d+\. /gm, "")
      .replace(/^\|.*\|$/gm, "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^출처:.*$/gm, "");
    return rec.replace(/\s+/g, " ").trim();
  }
  function preview(p, q, max = 200) {
    let t = plain(p.b);
    if (q) {
      const i = t.toLowerCase().indexOf(q.toLowerCase());
      if (i > 60) t = "…" + t.slice(i - 40);
    }
    if (t.length > max) t = t.slice(0, max).replace(/\s\S*$/, "") + "…";
    return inline(t, q);
  }

  /* ───────── 날짜 ───────── */
  const NOW = new Date("2026-10-05T15:00:00+09:00");
  function fmtDate(iso, withYear) {
    const d = new Date(iso);
    const y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
    return (withYear || y !== NOW.getFullYear() ? y + "년 " : "") + m + "월 " + dd + "일";
  }
  function relDate(iso) {
    const diff = (NOW - new Date(iso)) / 60000;
    if (diff < 60) return Math.max(1, Math.round(diff)) + "분 전";
    if (diff < 1440) return Math.round(diff / 60) + "시간 전";
    if (diff < 1440 * 7) return Math.round(diff / 1440) + "일 전";
    return fmtDate(iso);
  }

  /* ───────── 검색 ───────── */
  // 순위: 제목 3 · 주제 정확 3 · 주제 부분 2 · 본문 1, 같으면 최신. (기존 서버는 최신순만)
  function search(posts, q) {
    const ql = q.toLowerCase();
    return posts
      .map((p) => {
        let s = 0;
        if (p.t.toLowerCase().includes(ql)) s += 3;
        if (p.g.some((t) => canon(t).toLowerCase() === canon(q).toLowerCase())) s += 3;
        else if (p.g.some((t) => t.toLowerCase().includes(ql))) s += 2;
        if (p.b.toLowerCase().includes(ql)) s += 1;
        return { p, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.p.d.localeCompare(a.p.d))
      .map((x) => x.p);
  }

  // 같은 주제 글: 겹치는 주제의 희소도(전체에서 적게 쓰인 주제일수록 큼)로 점수.
  function sameTopic(p, posts, n = 3) {
    const idx = new Map(topicIndex(posts).map((t) => [t.tag, t.n]));
    const mine = new Set(p.g.map(canon));
    return posts
      .filter((o) => o.id !== p.id)
      .map((o) => {
        let s = 0;
        new Set(o.g.map(canon)).forEach((t) => { if (mine.has(t)) s += 1 / Math.log2(1 + idx.get(t)); });
        return { o, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.o);
  }

  /* ───────── 코드 강조 ───────── */
  const CODE = (window.CODE = window.CODE || {});
  let codeSeq = 0;
  const REG = /\b(r[abcd]x|r[sd]i|r[sb]p|r(?:8|9|1[0-5])[dwb]?|e[abcd]x|e[sd]i|e[sb]p|[abcd][xlh]|[sd]il?|[sb]pl?|rip|eip|xmm\d+|[cdefgs]s)\b/i;
  const LANG_LABEL = { c: "C", cpp: "C++", asm: "x86-64 어셈블리", disasm: "x86-64 디스어셈블리", shell: "명령", python: "Python", text: "텍스트", json: "JSON" };

  function tokAsmOperands(s) {
    return esc(s)
      .replace(/\b(byte|word|dword|qword|ptr)\b/gi, '<span class="t-cmt" style="font-style:normal">$1</span>')
      .replace(new RegExp(REG.source, "gi"), '<span class="t-reg">$&</span>')
      .replace(/\b(0x[0-9a-f]+|[0-9a-f]{8,16}|[0-9][0-9a-f]*h|\d+)\b(?![^<]*>)/gi, '<span class="t-num">$1</span>');
  }
  function tokInstr(s) {
    const ci = s.indexOf(";");
    const ins = ci >= 0 ? s.slice(0, ci) : s;
    const cmt = ci >= 0 ? s.slice(ci) : "";
    const m = ins.match(/^(\s*)(\S+)(\s*)(.*)$/);
    let h = m ? m[1] + '<span class="t-mn">' + esc(m[2]) + "</span>" + m[3] + tokAsmOperands(m[4]) : esc(ins);
    if (cmt) h += '<span class="t-cmt">' + esc(cmt) + "</span>";
    return h;
  }
  function hlLine(lang, line) {
    if (lang === "disasm") {
      if (/^\S+:\s*$/.test(line)) return '<span class="t-lbl">' + esc(line) + "</span>";
      const m = line.match(/^(\s*)([0-9A-Fa-f`]{6,17})(\s+)((?:[0-9A-F]{2} )*[0-9A-F]{2})(\s{2,})(.*)$/);
      if (m) return m[1] + '<span class="t-addr">' + esc(m[2]) + "</span>" + m[3] + '<span class="t-by">' + esc(m[4]) + m[5] + "</span>" + tokInstr(m[6]);
      return tokInstr(line);
    }
    if (lang === "asm") {
      if (/^\S+:\s*$/.test(line)) return '<span class="t-lbl">' + esc(line) + "</span>";
      return tokInstr(line);
    }
    if (lang === "shell") {
      const m = line.match(/^(\s*[>$] )(.*)$/);
      if (m) return '<span class="t-pr">' + esc(m[1]) + "</span>" + esc(m[2]).replace(/(\s)(\/\w+)/g, '$1<span class="t-kw">$2</span>');
      return '<span class="t-cmt" style="font-style:normal">' + esc(line) + "</span>";
    }
    if (lang === "c" || lang === "cpp" || lang === "python") {
      const ci = lang === "python" ? line.indexOf("#") : line.indexOf("//");
      const code = ci >= 0 ? line.slice(0, ci) : line;
      const cmt = ci >= 0 ? line.slice(ci) : "";
      const KW = lang === "python"
        ? /\b(def|return|import|from|if|else|elif|for|while|in|not|and|or|None|True|False|with|as|class|try|except)\b/g
        : /\b(int|char|void|return|if|else|for|while|unsigned|const|struct|static|sizeof|long|short)\b/g;
      let h = esc(code)
        .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="t-str">$1</span>')
        .replace(/^(\s*#\w+)/, '<span class="t-kw">$1</span>')
        .replace(new RegExp(KW.source + "(?![^<]*>)", "g"), '<span class="t-kw">$1</span>')
        .replace(/\b(\d+)\b(?![^<]*>)/g, '<span class="t-num">$1</span>')
        .replace(/\b([a-z_]\w*)(?=\()(?![^<]*>)/gi, '<span class="t-fn">$1</span>');
      if (cmt) h += '<span class="t-cmt">' + esc(cmt) + "</span>";
      return h;
    }
    return esc(line);
  }

  // 펜스 정보: ```disasm title="check.exe · .text" {5,6}
  function codeHtml(info, text) {
    const lang = (info.match(/^(\w+)/) || [, "text"])[1].toLowerCase();
    const title = (info.match(/title="([^"]+)"/) || [])[1] || "";
    const hl = new Set(((info.match(/\{([\d,\-]+)\}/) || [])[1] || "").split(",").flatMap((r) => {
      const [a, b] = r.split("-").map(Number);
      return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : a ? [a] : [];
    }));
    const lines = text.split("\n");
    const num = (lang === "c" || lang === "cpp" || lang === "python") && lines.length > 4;
    const id = "code" + ++codeSeq;
    CODE[id] = text;
    const label = LANG_LABEL[lang] || lang;
    const body = lines.map((l, i) => `<span class="l${hl.has(i + 1) ? " l--hl" : ""}">${hlLine(lang, l) || " "}</span>`).join("");
    return `<figure class="code${num ? " code--num" : ""}" data-code="${id}">
<figcaption class="code__bar"><span class="code__lang">${esc(label)}</span>${title ? `<span class="code__file">${esc(title)}</span>` : ""}<span class="code__sp"></span>${lang === "disasm" ? `<button type="button" class="code__btn" data-act="bytes" aria-pressed="true">바이트</button>` : ""}<button type="button" class="code__btn" data-act="wrap" aria-pressed="false">줄바꿈</button><button type="button" class="code__btn" data-act="copy" data-id="${id}">복사</button></figcaption>
<pre tabindex="0" aria-label="코드 블록 · ${esc(label)}${title ? " · " + esc(title) : ""}"><code>${body}</code></pre></figure>`;
  }

  /* ───────── 본문 렌더러(Markdown 부분집합 + 편집자 보충 묶음) ───────── */
  // 구현: react-markdown + remark-gfm 은 그대로 두고, 아래 규칙만 remark/rehype 플러그인으로 추가한다.
  function mdToHtml(src, opts = {}) {
    const q = opts.q;
    const L = String(src).replace(/\r/g, "").split("\n");
    const blocks = [];
    let i = 0;
    const isStart = (l) => /^```|^#{1,4} |^\s*[-*] |^\s*\d+\. |^!\[|^> |^\|/.test(l);
    while (i < L.length) {
      const l = L[i];
      if (/^```/.test(l)) {
        const info = l.slice(3).trim();
        const buf = [];
        i++;
        while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
        i++;
        blocks.push({ t: "code", info, text: buf.join("\n") });
      } else if (/^#{1,4} /.test(l)) {
        const lv = l.match(/^#+/)[0].length;
        blocks.push({ t: "h", lv: Math.max(2, lv), text: l.replace(/^#+ /, "") });
        i++;
      } else if (/^\|/.test(l) && /^\|\s*:?-/.test(L[i + 1] || "")) {
        const rows = [];
        while (i < L.length && /^\|/.test(L[i])) rows.push(L[i++]);
        blocks.push({ t: "table", rows });
      } else if (/^\s*[-*] /.test(l) || /^\s*\d+\. /.test(l)) {
        const ordered = /^\s*\d+\. /.test(l);
        const items = [];
        while (i < L.length && (ordered ? /^\s*\d+\. /.test(L[i]) : /^\s*[-*] /.test(L[i]))) {
          items.push(L[i].replace(/^\s*([-*]|\d+\.) /, ""));
          i++;
          while (i < L.length && /^\s{2,}\S/.test(L[i]) && !isStart(L[i].trim())) items[items.length - 1] += " " + L[i++].trim();
        }
        blocks.push({ t: ordered ? "ol" : "ul", items });
      } else if (/^!\[/.test(l)) {
        const m = l.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/);
        blocks.push({ t: "fig", alt: m ? m[1] : "", src: m ? m[2] : "", cap: m ? m[3] : "" });
        i++;
      } else if (/^> /.test(l)) {
        const buf = [];
        while (i < L.length && /^> /.test(L[i])) buf.push(L[i++].slice(2));
        blocks.push({ t: "quote", text: buf.join(" ") });
      } else if (!l.trim()) {
        i++;
      } else {
        const buf = [];
        while (i < L.length && L[i].trim() && !isStart(L[i])) buf.push(L[i++]);
        blocks.push({ t: "p", text: buf.join(" ") });
      }
    }

    const toc = [];
    let hid = 0;
    const one = (b) => {
      switch (b.t) {
        case "code": return codeHtml(b.info, b.text);
        case "h": {
          const id = "h-" + ++hid;
          if (b.lv === 2) toc.push({ id, text: b.text });
          return `<h${b.lv} id="${id}">${inline(b.text, q)}</h${b.lv}>`;
        }
        case "ul": return "<ul>" + b.items.map((x) => "<li>" + inline(x, q) + "</li>").join("") + "</ul>";
        case "ol": return "<ol>" + b.items.map((x) => "<li>" + inline(x, q) + "</li>").join("") + "</ol>";
        case "quote": return "<blockquote>" + inline(b.text, q) + "</blockquote>";
        case "fig": return figHtml(b);
        case "table": return tableHtml(b.rows, q);
        case "p": {
          if (/^출처:/.test(b.text)) return srcHtml(b.text);
          return "<p>" + inline(b.text, q) + "</p>";
        }
      }
      return "";
    };

    // 편집자 보충: 제목이 정확히 "편집자 보충"인 머리부터 다음 같은 수준 머리 전까지 묶는다.
    let html = "";
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.t === "h" && b.text.trim() === "편집자 보충") {
        const inner = [];
        let j = k + 1;
        while (j < blocks.length && !(blocks[j].t === "h" && blocks[j].lv <= b.lv)) inner.push(blocks[j++]);
        html += `<section class="supp" aria-labelledby="supp-${k}"><div class="supp__head"><h2 id="supp-${k}">편집자 보충</h2><span>공개 문서로 확인해 덧붙인 내용</span></div><div class="supp__body">${inner.map(one).join("")}</div></section>`;
        k = j - 1;
      } else html += one(b);
    }
    return { html, toc };
  }

  function srcHtml(text) {
    const links = [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)];
    if (!links.length) return "<p>" + inline(text) + "</p>";
    return `<div class="srcs"><p class="srcs__t">출처 ${links.length}</p><ol>${links
      .map((m) => {
        const dom = m[2].replace(/^https?:\/\//, "").split("/")[0];
        return `<li><span><a href="${m[2]}" rel="nofollow ugc noopener noreferrer" target="_blank">${esc(m[1])} ↗</a><span class="dom">${esc(dom)}</span></span></li>`;
      })
      .join("")}</ol></div>`;
  }

  function tableHtml(rows, q) {
    const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(rows[0]);
    const align = cells(rows[1]).map((c) => (/-:$/.test(c) ? "n" : ""));
    const body = rows.slice(2).map(cells);
    let cap = "";
    return `<div class="tbl"><div class="tbl__wrap" tabindex="0" role="region" aria-label="본문 표"><table><thead><tr>${head
      .map((h) => `<th scope="col">${inline(h, q)}</th>`)
      .join("")}</tr></thead><tbody>${body
      .map((r) => "<tr>" + r.map((c, ci) => `<td class="${align[ci] || ""}${c.length > 28 ? " wrap" : ""}">${inline(c, q)}</td>`).join("") + "</tr>")
      .join("")}</tbody></table></div>${cap}</div>`;
  }

  function figHtml(b) {
    const art = window.FIGURES && window.FIGURES[b.src];
    return `<figure class="fig"><button type="button" class="fig__img" data-act="zoom" data-src="${esc(b.src)}" aria-label="${esc(b.alt)} 크게 보기">${art || ""}</button><figcaption><span>${esc(b.cap || b.alt)}</span><span>누르면 크게</span></figcaption></figure>`;
  }

  /* ───────── 예시 자료(실제 공개 글 아님) ───────── */
  // 긴 기술 글의 읽기 경험(코드·디스어셈블리·표·그림)을 검토하기 위한 작성 예시.
  // 현재 공개 330개에는 코드 블록·표·이미지가 0개다(인라인 코드 97개, 최장 971자).
  const EX_LONG = {
    id: "ex-long",
    ex: true,
    t: "x64 호출 규약으로 main의 인자를 따라가 보기",
    k: "analysis",
    g: ["x64", "호출 규약", "디스어셈블", "Visual Studio"],
    d: "2026-10-04T11:20:00+09:00",
    author: "회원 A",
    n: 2,
    b: [
      "직접 만든 작은 프로그램에서 `main`이 받은 `argc`가 어느 레지스터를 거쳐 비교까지 가는지 따라가 봤습니다. 소스와 디스어셈블리, 디버거 화면을 차례로 대조합니다.",
      "",
      "## 확인할 프로그램",
      "",
      "```c title=\"check.c\" {2}",
      "#include <stdio.h>",
      "int check(int a, int b) { return a * 3 + b == 42; }",
      "",
      "int main(int argc, char **argv) {",
      "    if (check(argc, 39)) puts(\"ok\");   // 인자 없이 실행하면 argc = 1",
      "    return 0;",
      "}",
      "```",
      "",
      "인라인 확장을 끄고 빌드했습니다.",
      "",
      "```shell",
      "> cl /O1 /Ob0 /Zi check.c",
      "```",
      "",
      "## 디스어셈블리에서 인자 따라가기",
      "",
      "```disasm title=\"check.exe · .text · 설명용으로 정리\" {2,11}",
      "check:",
      "0000000140001000  6B C1 03              imul  eax, ecx, 3        ; a * 3",
      "0000000140001003  03 C2                 add   eax, edx           ; + b",
      "0000000140001005  83 F8 2A              cmp   eax, 2Ah           ; == 42 ?",
      "0000000140001008  0F 94 C0              sete  al",
      "000000014000100B  0F B6 C0              movzx eax, al",
      "000000014000100E  C3                    ret",
      "main:",
      "0000000140001010  48 83 EC 28           sub   rsp, 28h",
      "0000000140001014  BA 27 00 00 00        mov   edx, 27h           ; b = 39",
      "0000000140001019  E8 E2 FF FF FF        call  check              ; ecx = argc 그대로",
      "000000014000101E  85 C0                 test  eax, eax",
      "0000000140001020  74 0C                 je    000000014000102E",
      "0000000140001022  48 8D 0D D7 0F 00 00  lea   rcx, [rip+0FD7h]   ; \"ok\"",
      "0000000140001029  E8 4D 00 00 00        call  puts",
      "000000014000102E  33 C0                 xor   eax, eax",
      "0000000140001030  48 83 C4 28           add   rsp, 28h",
      "0000000140001034  C3                    ret",
      "```",
      "",
      "`main`은 `ecx`를 건드리지 않고 그대로 `check`를 부릅니다. 첫 번째 인자 자리가 같기 때문입니다. 두 번째 인자 39(`27h`)만 `edx`에 새로 넣습니다.",
      "",
      "| 인자 순서 | 정수·포인터 | 실수 | 이 예제에서 |",
      "| --- | --- | --- | --- |",
      "| 1 | `RCX` | `XMM0` | `argc` → `a` |",
      "| 2 | `RDX` | `XMM1` | 39 → `b` |",
      "| 3 | `R8` | `XMM2` | 쓰지 않음 |",
      "| 4 | `R9` | `XMM3` | 쓰지 않음 |",
      "| 5 이후 | 스택 | 스택 | 호출자가 32바이트 그림자 공간 뒤에 둡니다 |",
      "",
      "## 디버거에서 확인",
      "",
      "![cmp 직전 레지스터 창](ex:regs \"cmp eax, 2Ah 직전 · 인자 없이 실행\")",
      "",
      "`cmp` 직전에 `EAX`가 `2A`이면 비교가 참이 되어 `ok`를 출력합니다. 인자를 하나 주면 `argc`가 2가 되어 `EAX`는 `2D`입니다.",
      "",
      "## 정리",
      "",
      "- 첫 네 정수 인자는 `RCX`, `RDX`, `R8`, `R9` 순서로 들어갑니다.",
      "- 호출하는 쪽이 값을 그대로 넘기면 인자를 다시 넣는 명령이 보이지 않을 수 있습니다.",
      "- 최적화 단계에 따라 `check`가 `main` 안으로 들어가면 이 흐름이 보이지 않습니다.",
    ].join("\n"),
  };

  // 회원 활동이 생긴 뒤의 첫 화면 검토용(예시). 실제 회원·댓글이 아니다.
  const EX_MEMBER = [
    { id: "ex-m1", ex: true, t: "x64dbg에서 조건부 중단점이 한 번만 걸리는 이유", k: "question", g: ["x64dbg", "중단점"], d: "2026-10-05T13:40:00+09:00", author: "회원 B", n: 0, b: "루프 안 `cmp` 위치에 `ecx == 5` 조건으로 중단점을 걸었는데 첫 반복에서만 멈춥니다. 조건식 문법이 틀렸는지, 중단점 종류를 바꿔야 하는지 궁금합니다." },
    { id: "ex-long-ref", ex: true, ref: "ex-long", t: EX_LONG.t, k: "analysis", g: EX_LONG.g, d: EX_LONG.d, author: "회원 A", n: 2, b: EX_LONG.b, act: "댓글 2 · 1시간 전" },
    { id: "ex-m3", ex: true, t: "AI가 정리한 함수 설명을 디스어셈블리와 대조한 기록", k: "analysis", g: ["AI 활용", "IDA"], d: "2026-10-04T21:10:00+09:00", author: "회원 C", n: 1, b: "함수 12개에 대한 AI 설명 중 3개는 인자 수를 잘못 셌습니다. 스택 정리 방식과 호출 지점의 인자 준비 코드를 함께 확인한 과정입니다." },
  ];

  const EX_ANSWERS = {
    question: [
      { by: "회원 D", at: "2026-10-05T10:12:00+09:00", b: "서버가 `Connection: close` 없이 응답하면 연결을 바로 닫지 않습니다. 요청에 `Connection: close`를 넣거나 `Content-Length`만큼만 읽고 끝내 보세요.\n\n```python\nsock.sendall(b\"GET / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n\")\n```" },
      { by: "회원 E", at: "2026-10-05T11:30:00+09:00", reply: true, b: "브라우저는 응답 길이를 보고 바로 표시하니 차이가 나는 것도 같은 이유로 보여요." },
    ],
    share: [
      { by: "회원 F", at: "2026-10-05T09:02:00+09:00", b: "`/Ob0`를 빼고 `/O2`로 빌드하니 `check`가 `main` 안으로 들어가서 `call`이 사라졌습니다. 정리 마지막 줄과 같은 결과입니다." },
      { by: "회원 A", at: "2026-10-05T09:40:00+09:00", reply: true, b: "확인 고맙습니다. 본문에 빌드 옵션별 차이를 덧붙일게요." },
    ],
  };

  const EX_MY = [
    { id: "ex-my1", ex: true, t: "Themida로 보호된 실행 파일의 OEP 찾기 순서", k: "question", st: "published", d: "2026-10-03T20:10:00+09:00", n: 3 },
    { id: "ex-my2", ex: true, t: "IDA에서 구조체 오프셋을 한 번에 바꾸는 방법", k: "analysis", st: "pending", d: "2026-10-05T14:52:00+09:00", n: 0 },
    { id: "ex-held", ex: true, t: "OllyDbg에서 API 호출 목록 보기", k: "analysis", st: "held", d: "2026-10-05T12:31:00+09:00", n: 0, reason: "duplicate",
      b: "OllyDbg에서 `Search for > All intermodular calls`로 모듈 사이의 호출을 볼 수 있습니다.", g: ["OllyDbg", "API"] },
  ];

  window.RA = {
    S, PURPOSE_LABEL, purposeOf, ALIASES, canon, topicIndex, esc, inline, preview, plain, hasSupp, srcLinks,
    fmtDate, relDate, search, sameTopic, mdToHtml, codeHtml, EX_LONG, EX_MEMBER, EX_ANSWERS, EX_MY, NOW,
  };
})();
