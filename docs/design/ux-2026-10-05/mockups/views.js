/* Reversing All 목업 · 화면(문자열 템플릿). 실제 앱은 같은 구조를 React 서버 컴포넌트로 옮긴다. */
(function () {
  "use strict";
  const R = window.RA;
  const { S, esc, inline, preview, purposeOf, PURPOSE_LABEL, canon, topicIndex, fmtDate, relDate } = R;

  const POSTS = S.posts;
  const BY_ID = new Map(POSTS.map((p) => [p.id, p]));
  [R.EX_LONG, ...R.EX_MEMBER, ...R.EX_MY].forEach((p) => BY_ID.set(p.id, p));
  const OPEN = POSTS.filter((p) => p.k === "question" && p.n === 0);
  const TOPICS = topicIndex(POSTS);
  const PAGE = 30;
  // 운영 화면에서 확인된 "함께 읽을 글"(중복 판정이 연결한 관계). 스냅샷 API에는 없어 이 글만 옮겨 적었다.
  const CONFIRMED = { "16daebf1-972e-4e62-abce-6744926531c6": ["a534ee2e-815f-429b-8c07-792910dfbb1e"] };

  const I = (id, cls = "") => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const go = (attrs) => Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
  const link = (screen, extra = {}) => `href="#" data-act="go" ${go({ screen, ...extra })}`;

  /* ───────── 공통 조각 ───────── */
  function header(st) {
    const cur = (s) => (navOf(st) === s ? ' aria-current="page"' : "");
    const acct =
      st.auth === "member"
        ? `<a class="hdr__link hdr__link--me" ${link("me")}${st.screen === "me" ? ' aria-current="page"' : ""}>내 글</a><button class="hdr__icon" aria-label="계정 메뉴"><span class="avatar">예</span></button>`
        : `<a class="hdr__link" href="#" data-act="noop">로그인</a><a class="hdr__link hide-compact" href="#" data-act="noop">회원가입</a>`;
    return `<header class="hdr"><div class="shell hdr__in">
<a class="logo" ${link("home")} aria-label="Reversing All 처음으로"><svg class="logo__mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect class="a" x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4M17.5 10v4"/></svg>Reversing All</a>
<nav class="hdr__nav" aria-label="사이트 둘러보기"><a ${link("home")}${cur("home")}>최신 글</a><a ${link("open")}${cur("open")}>답을 기다리는 질문</a><a ${link("topics")}${cur("topics")}>주제</a></nav>
<form class="hdr__search" role="search" data-act="search-form"><label class="qbox"><span class="sr-only">글 검색</span>${I("search")}<input name="q" type="search" placeholder="제목·본문·주제 검색" value="${esc(st.screen === "search" ? st.q : "")}" autocomplete="off"><kbd aria-hidden="true">/</kbd></label></form>
<span class="hdr__sp"></span>
<button class="hdr__icon hdr__search-btn" data-act="sheet" data-v="search" aria-label="검색">${I("search")}</button>
<a class="btn btn--primary hdr__write" ${link("new")}>${I("plus", "ico--s")}글 쓰기</a>
${acct}
</div></header>`;
  }
  function navOf(st) {
    if (st.screen === "home") return "home";
    if (st.screen === "open") return "open";
    if (st.screen === "topics" || st.screen === "topic") return "topics";
    return "";
  }
  function subnav(st) {
    const cur = (s) => (navOf(st) === s ? ' aria-current="page"' : "");
    return `<nav class="subnav" aria-label="사이트 둘러보기"><div class="shell subnav__in"><a ${link("home")}${cur("home")}>최신 글</a><a ${link("open")}${cur("open")}>답 기다림 <span class="chip__n" aria-hidden="true">&nbsp;${OPEN.length}</span></a><a ${link("topics")}${cur("topics")}>주제</a></div></nav>`;
  }
  function footer(st) {
    const t = (v, l) => `<button type="button" data-act="theme" data-v="${v}" aria-pressed="${st.appTheme === v}">${l}</button>`;
    return `<footer class="ftr"><div class="shell ftr__in"><a href="#" data-act="noop">운영 안내</a><a href="#" data-act="noop">삭제·이의 요청</a><span class="seg" role="group" aria-label="화면 색">${t("system", "시스템")}${t("light", "밝게")}${t("dark", "어둡게")}</span></div></footer>`;
  }

  function stateOfRow(p) {
    const pur = purposeOf(p);
    if (pur === "question") return p.n === 0 ? `<span class="state state--open">답 기다림</span>` : `<span class="state state--ok">답변 ${p.n}</span>`;
    return "";
  }
  function metaOf(p, extra = "") {
    const bits = [];
    if (p.author) bits.push(`<span>${esc(p.author)}</span><span>${p.act || relDate(p.d)}</span>`);
    else bits.push(`<span>${esc(p.per)} 카톡 기록</span>`);
    const tags = [...new Set(p.g.map(canon))];
    if (tags.length) bits.push(tags.slice(0, 3).map((t) => `<a class="topic" ${link("topic", { tag: t })}>#${esc(t)}</a>`).join(" ") + (tags.length > 3 ? ` <span>+${tags.length - 3}</span>` : ""));
    if (!p.author && R.hasSupp(p)) bits.push(`<span>보충 출처 ${R.srcLinks(p).length}</span>`);
    if (purposeOf(p) !== "question" && p.n > 0 && !p.act) bits.push(`<span>댓글 ${p.n}</span>`);
    return `<div class="row__meta">${bits.join('<span class="sep" aria-hidden="true">·</span>')}${extra}</div>`;
  }
  function row(p, o = {}) {
    const pur = purposeOf(p);
    const target = p.ref || p.id;
    return `<article class="row${o.act ? " row--act" : ""}">
<div class="row__top"><span class="ptag ptag--${pur}">${PURPOSE_LABEL[pur]}</span>${stateOfRow(p)}${p.ex ? '<span class="ex">예시</span>' : ""}</div>
<h2 class="row__title"><a ${link("post", { id: target })}>${o.q ? R.inline(p.t, o.q) : esc(p.t)}</a></h2>
<p class="row__ans">${preview(p, o.q)}</p>
${metaOf(p)}
${o.act ? `<div class="row__act"><a class="btn btn--sm" ${link("post", { id: target, anchor: "answers" })}>답하기</a></div>` : ""}
</article>`;
  }
  function pager(st, total) {
    const n = Math.max(1, Math.ceil(total / PAGE));
    if (n < 2) return "";
    const p = Math.min(st.page || 1, n);
    const a = (to, label, rel) => (to < 1 || to > n ? `<span class="btn btn--quiet btn--sm" aria-disabled="true" style="opacity:.45">${label}</span>` : `<a class="btn btn--quiet btn--sm" href="#" data-act="page" data-v="${to}" rel="${rel}">${label}</a>`);
    return `<nav class="pager" aria-label="목록 페이지">${a(p - 1, I("left", "ico--s") + "이전", "prev")}<span><strong>${p}</strong> / ${n}</span>${a(p + 1, "다음" + I("right", "ico--s"), "next")}</nav>`;
  }
  function purposeChips(st, list, screen, extra = {}) {
    const c = { question: 0, share: 0, free: 0 };
    list.forEach((p) => c[purposeOf(p)]++);
    const ch = (v, l, n) => `<a class="chip" href="#" data-act="purpose" data-v="${v}" aria-pressed="${(st.purpose || "") === v}">${l}<span class="chip__n" aria-hidden="true">${n}</span></a>`;
    return `<div class="chips chips--scroll" role="group" aria-label="글 목적">${ch("", "전체", list.length)}${ch("question", "질문", c.question)}${ch("share", "공유", c.share)}${ch("free", "자유", c.free)}</div>`;
  }
  const byPurpose = (list, pur) => (pur ? list.filter((p) => purposeOf(p) === pur) : list);
  const pageSlice = (st, list) => {
    const n = Math.max(1, Math.ceil(list.length / PAGE));
    const p = Math.min(st.page || 1, n);
    return list.slice((p - 1) * PAGE, p * PAGE);
  };

  function aside(skip) {
    return `<aside class="aside" aria-label="둘러보기 도움">
${skip === "open" ? "" : `<section class="box"><h2>답을 기다리는 질문 <a ${link("open")}>${OPEN.length}개 모두</a></h2><ul class="mini">${OPEN.slice(0, 5)
      .map((p) => `<li><a ${link("post", { id: p.id })}>${esc(p.t)}</a><span class="m">${esc(p.per)} 카톡 기록</span></li>`)
      .join("")}</ul></section>`}
<section class="box"><h2>주제 <a ${link("topics")}>모든 주제</a></h2><div class="tcloud">${TOPICS.slice(0, 14)
      .map((t) => `<a ${link("topic", { tag: t.tag })}>${esc(t.tag)}<span>${t.n}</span></a>`)
      .join("")}</div></section>
<section class="box"><h2>무엇을 나누나요?</h2><dl class="note"><dt>질문</dt><dd>막힌 지점과 시도한 내용을 남겨요.</dd><dt>공유</dt><dd>분석 과정·도구 사용법·AI 활용 경험을 기록해요.</dd><dt>자유</dt><dd>소식과 생각을 나눠요.</dd></dl></section>
</aside>`;
  }

  function loadingList(n = 5) {
    return `<div class="list" aria-busy="true" aria-label="글 목록 불러오는 중">${Array.from({ length: n })
      .map(() => `<div class="row"><span class="sk" style="width:44px;height:20px"></span><span class="sk sk--t" style="margin-top:10px"></span><span class="sk" style="margin-top:10px"></span><span class="sk sk--s"></span></div>`)
      .join("")}</div>`;
  }
  const errorBox = (what) => `<div class="err" role="alert"><span>${what}을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.</span><button class="btn btn--sm" data-act="noop">다시 시도</button></div>`;

  /* ───────── 최신 글 ───────── */
  function vHome(st) {
    const active = st.state === "active";
    let head = `<div class="page-head"><div><h1>최신 글</h1><p>리버싱 질문과 답을 모았어요. 과거 카톡 기록을 정리한 편집 자료와 회원 글이 함께 있어요.</p></div><a class="btn btn--primary btn--sm only-narrow" ${link("new")}>${I("plus", "ico--s")}글 쓰기</a></div>`;
    let body;
    if (st.state === "loading") body = `<div class="count-line"><span class="sk" style="width:90px"></span></div>` + loadingList();
    else if (st.state === "error") body = errorBox("글 목록");
    else if (active) {
      const quiet = POSTS;
      body = `<section class="bundle" aria-labelledby="bundle-t"><h2 id="bundle-t">새로 정리한 편집 자료</h2><p>댓글이 아직 없는 편집 글 ${quiet.length}개를 묶었어요.</p><ul class="mini">${quiet
        .slice(0, 3)
        .map((p) => `<li><a ${link("post", { id: p.id })}>${esc(p.t)}</a><span class="m">${esc(p.per)} 카톡 기록</span></li>`)
        .join("")}</ul><a class="guide__all" ${link("topics")}>주제별로 보기 ›</a></section>
<div class="count-line"><span>회원 글과 댓글이 있는 글 <strong>${R.EX_MEMBER.length}</strong>개 <span class="ex">예시</span></span><span>최근 활동순</span></div>
<div class="list">${byPurpose(R.EX_MEMBER, st.purpose).map((p) => row(p)).join("")}</div>`;
    } else {
      const list = byPurpose(POSTS, st.purpose);
      body = `<div class="count-line"><span>공개 글 <strong>${list.length.toLocaleString("ko-KR")}</strong>개</span><span>최신순</span></div>
<div class="list">${pageSlice(st, list).map((p) => row(p)).join("")}</div>${pager(st, list.length)}`;
    }
    return `<div class="shell page"><div class="layout"><section aria-labelledby="h-home">${head.replace("<h1>", '<h1 id="h-home">')}${purposeChips(st, active ? R.EX_MEMBER : POSTS)}${body}</section>${aside()}</div></div>`;
  }

  /* ───────── 답을 기다리는 질문 ───────── */
  function vOpen(st) {
    const tops = topicIndex(OPEN).slice(0, 8);
    let list = st.tag ? OPEN.filter((p) => p.g.some((t) => canon(t) === st.tag)) : OPEN;
    const chips = `<div class="chips chips--scroll" role="group" aria-label="주제로 좁히기"><a class="chip" href="#" data-act="open-tag" data-v="" aria-pressed="${!st.tag}">전체<span class="chip__n" aria-hidden="true">${OPEN.length}</span></a>${tops
      .map((t) => `<a class="chip" href="#" data-act="open-tag" data-v="${esc(t.tag)}" aria-pressed="${st.tag === t.tag}">${esc(t.tag)}<span class="chip__n" aria-hidden="true">${t.n}</span></a>`)
      .join("")}</div>`;
    const body =
      st.state === "loading" ? loadingList() : st.state === "error" ? errorBox("질문 목록") :
      `<div class="count-line"><span>${st.tag ? `#${esc(st.tag)} 질문 ` : "답을 기다리는 질문 "}<strong>${list.length}</strong>개</span><span>최신순</span></div><div class="list">${pageSlice(st, list).map((p) => row(p, { act: true })).join("")}</div>${pager(st, list.length)}`;
    return `<div class="shell page"><div class="layout"><section><div class="page-head"><div><h1>답을 기다리는 질문</h1><p>답이 아직 없는 질문이에요. 아는 내용이 있으면 짧게라도 남겨 주세요. 한 줄 답도 다음 사람에게 도움이 돼요.</p></div></div>${chips}${body}</section>${aside("open")}</div></div>`;
  }

  /* ───────── 주제 ───────── */
  function vTopics(st) {
    const guides = S.guides.map((g) => {
      const posts = g.ids.map((id) => BY_ID.get(id)).filter(Boolean);
      return `<section class="guide"><h3><a ${link("topic", { guide: g.slug })}>${esc(g.title)}</a><span>글 ${posts.length}</span></h3><p>${esc(g.desc)}</p><ul class="mini">${posts
        .slice(0, 3)
        .map((p) => `<li><a ${link("post", { id: p.id })}>${esc(p.t)}</a></li>`)
        .join("")}</ul><a class="guide__all" ${link("topic", { guide: g.slug })}>${esc(g.title)} 글 모두 보기 ›</a></section>`;
    });
    const rawCount = new Set(POSTS.flatMap((p) => p.g)).size;
    return `<div class="shell page"><div class="page-head"><div><h1>주제</h1><p>운영자가 고른 길잡이로 시작하거나, 글에 붙은 주제로 찾아보세요.</p></div></div>
<h2 class="sec-title">길잡이 <small>운영자가 공개 글을 확인하고 묶었어요 · 정확성 인증 목록은 아니에요</small></h2>
<div class="guides">${guides.join("")}</div>
<h2 class="sec-title" id="all-topics">모든 주제 <small>${TOPICS.length}개</small></h2>
<div class="tfilter"><label class="sr-only" for="tf">주제 이름 찾기</label><input id="tf" class="field" type="search" placeholder="주제 이름 찾기 (예: PE, 패킹, 커널)" data-act="tfilter" value="${esc(st.tf || "")}" autocomplete="off"></div>
<div class="tindex"><div class="tcloud" id="tcloud">${topicCloud(st.tf, st.allTopics)}</div>
<p class="fhint" style="margin-top:12px">표기만 다른 주제는 합쳐 보여요: ${Object.entries(R.ALIASES)
      .slice(0, 5)
      .map(([c, a]) => `${a.join("·")} → ${esc(c)}`)
      .join(", ")} 외 ${Object.keys(R.ALIASES).length - 5}개. 글에 붙은 원래 표기(${rawCount}개)는 그대로 둬요.</p></div>
</div>`;
  }
  function topicCloud(filter, all) {
    const f = (filter || "").trim().toLowerCase();
    let list = TOPICS;
    if (f) list = TOPICS.filter((t) => t.tag.toLowerCase().includes(f) || (R.ALIASES[t.tag] || []).some((a) => a.toLowerCase().includes(f)));
    const shown = f || all ? list : list.filter((t) => t.n >= 2);
    const rest = list.length - shown.length;
    if (!shown.length) return `<p class="note">‘${esc(filter)}’ 주제가 없어요. <a ${link("search", { q: filter })}>글 본문에서 찾기 ›</a></p>`;
    return (
      shown.map((t) => `<a ${link("topic", { tag: t.tag })}${R.ALIASES[t.tag] ? ` title="${esc(R.ALIASES[t.tag].join(", "))} 포함"` : ""}>${esc(t.tag)}<span>${t.n}</span></a>`).join("") +
      (rest > 0 ? `<button class="more" type="button" data-act="all-topics" style="margin-left:4px">한 번만 쓰인 주제 ${rest}개 더 보기</button>` : "")
    );
  }

  function vTopic(st) {
    let title, desc, list, crumb = `<a class="crumb" ${link("topics")}>${I("left", "ico--s")}주제</a>`;
    if (st.guide) {
      const g = S.guides.find((x) => x.slug === st.guide) || S.guides[1];
      title = g.title;
      desc = esc(g.desc) + " 운영자가 공개 글을 확인하고 골랐어요.";
      list = g.ids.map((id) => BY_ID.get(id)).filter(Boolean);
    } else {
      const tag = st.tag || "PE";
      title = "#" + tag;
      const al = R.ALIASES[tag];
      desc = "이 주제가 붙은 공개 글이에요." + (al ? ` ‘${al.map(esc).join("’·‘")}’로 붙은 글도 함께 보여요.` : "");
      list = POSTS.filter((p) => p.g.some((t) => canon(t) === tag));
    }
    const within = byPurpose(list, st.purpose);
    const body =
      st.state === "loading" ? loadingList() : st.state === "error" ? errorBox("주제 글") :
      within.length
        ? `<div class="count-line"><span>${esc(title)} 글 <strong>${within.length}</strong>개</span><span>최신순</span></div><div class="list">${pageSlice(st, within).map((p) => row(p)).join("")}</div>${pager(st, within.length)}`
        : `<div class="empty"><h2>이 조건에 맞는 글이 없어요</h2><p>목적을 ‘전체’로 바꾸거나 다른 주제를 골라 보세요.</p><div class="acts"><a class="btn" href="#" data-act="purpose" data-v="">조건 지우기</a></div></div>`;
    return `<div class="shell page"><div class="layout"><section>${crumb}<div class="page-head"><div><h1>${esc(title)}</h1><p>${desc}</p></div></div>${purposeChips(st, list)}${body}</section>${aside()}</div></div>`;
  }

  /* ───────── 검색 ───────── */
  function vSearch(st) {
    const q = (st.q || "").trim();
    const all = q ? R.search(POSTS, q) : [];
    const list = byPurpose(all, st.purpose);
    const field = `<form class="only-narrow" role="search" data-act="search-form" style="margin-bottom:12px"><label class="sr-only" for="q2">글 검색</label><input id="q2" class="field" name="q" type="search" value="${esc(q)}" placeholder="제목·본문·주제 검색"></form>`;
    const topic = TOPICS.find((t) => t.tag.toLowerCase() === canon(q).toLowerCase());
    let body;
    if (st.state === "loading") body = loadingList();
    else if (st.state === "error") body = errorBox("검색 결과");
    else if (!all.length)
      body = `<div class="empty"><h2>‘${esc(q)}’에 맞는 글이 아직 없어요</h2><p>다른 표기나 더 넓은 말로 찾아보세요. 그래도 없다면 질문으로 남겨 주세요. 답을 아는 회원이 볼 수 있어요.</p>
<div class="acts"><a class="btn btn--primary" ${link("new", { title: q + " ", purpose: "question" })}>‘${esc(q)}’로 질문하기</a><a class="btn" ${link("topics")}>모든 주제 보기</a></div>
<p class="fhint" style="margin-top:16px">자주 찾는 주제</p><div class="tcloud" style="margin-top:6px">${TOPICS.slice(0, 8).map((t) => `<a ${link("topic", { tag: t.tag })}>${esc(t.tag)}<span>${t.n}</span></a>`).join("")}</div></div>`;
    else
      body = `${topic ? `<p class="guide-line" style="margin:0 0 12px"><a ${link("topic", { tag: topic.tag })}><b>#${esc(topic.tag)}</b> 주제 글 ${topic.n}개 모두 보기 ›</a></p>` : ""}${purposeChips(st, all)}
<div class="count-line"><span>검색 결과 <strong>${list.length}</strong>개</span><span>관련도순</span></div><div class="list">${list.map((p) => row(p, { q })).join("")}</div>`;
    return `<div class="shell page"><div class="layout"><section>${field}<div class="page-head"><div><h1>‘${esc(q)}’ 검색 결과</h1><p>제목·본문·주제에서 찾았어요.</p></div></div>${body}</section>${aside()}</div></div>`;
  }

  /* ───────── 글 ───────── */
  function vPost(st) {
    const p = BY_ID.get(st.id) || POSTS[0];
    if (st.state === "loading")
      return `<div class="shell page"><article class="article" aria-busy="true"><span class="sk" style="width:60px;height:22px"></span><span class="sk" style="height:30px;margin-top:12px"></span><span class="sk sk--s" style="margin-top:12px"></span>${'<span class="sk" style="margin-top:22px"></span><span class="sk"></span><span class="sk sk--t"></span>'.repeat(2)}</article></div>`;
    if (st.state === "error")
      return `<div class="shell page"><article class="article"><a class="crumb" ${link("home")}>${I("left", "ico--s")}목록으로</a><div class="empty"><h2>글을 찾을 수 없어요</h2><p>삭제됐거나, 공개 전이라 작성자만 볼 수 있는 글일 수 있어요.</p><div class="acts"><a class="btn" ${link("home")}>최신 글 보기</a></div></div></article></div>`;
    const pur = purposeOf(p);
    const mine = p.st !== undefined;
    const isEd = !p.author && !mine;
    const { html, toc } = R.mdToHtml(p.b || "", {});
    const hasToc = toc.length >= 3;
    const from = st.from || "home";
    const back = `<a class="crumb" ${link(from === "post" ? "home" : from, st.fromArgs || {})}>${I("left", "ico--s")}${mine ? "내 글로 돌아가기" : "목록으로 돌아가기"}</a>`;

    let notice = "";
    if (p.st === "held")
      notice = `<div class="notice notice--held" role="status"><h2>공개 보류 · 나에게만 보여요</h2><p>기존 글과 비교했을 때 새 정보가 확인되지 않아 공개가 보류됐어요. 아래 글과 다른 조건·근거가 있다면 본문에 더해 주세요.</p><ul>${["실행 파일의 Windows API 목록 확인", "Windows 10의 OllyDbg에서 Win32 API 보기 문제"]
        .map((t) => POSTS.find((x) => x.t === t))
        .filter(Boolean)
        .map((x) => `<li><a ${link("post", { id: x.id })}>${esc(x.t)}</a></li>`)
        .join("")}</ul><div class="acts" style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn--sm" href="#" data-act="noop">수정하기</a><a class="btn btn--sm btn--quiet" href="#" data-act="noop">다시 확인 요청</a></div></div>`;
    else if (p.st === "pending") notice = `<div class="notice notice--warn" role="status"><h2>확인 중 · 나에게만 보여요</h2><p>기본 확인이 끝나면 공개돼요. 보통 몇 분 걸려요.</p></div>`;

    const by = isEd
      ? `<span class="who">자료편집 <span class="staff">운영계정</span></span><span class="sep">·</span><span>${esc(p.per)} 카톡 기록</span><button type="button" class="prov-btn" data-act="prov" aria-expanded="${st.prov ? "true" : "false"}" aria-controls="prov">출처와 확인${I("down", "ico--s")}</button>`
      : `<span class="who"><span class="avatar" aria-hidden="true" style="width:24px;height:24px;font-size:11px">${esc((p.author || "나").slice(-1))}</span>${esc(p.author || "나")}</span><span class="sep">·</span><time>${fmtDate(p.d)}</time>${mine ? `<span class="sep">·</span><a href="#" data-act="noop">수정</a>` : ""}${p.ex && p.author ? ' <span class="ex">예시</span>' : ""}`;
    const prov = isEd
      ? `<div class="prov" id="prov"${st.prov ? "" : " hidden"}><dl><dt>자료</dt><dd>과거 리버싱 카톡방의 질문과 답을 정리한 글이에요. 대화 참여자 이름과 원문은 싣지 않아요.</dd><dt>기록 시점</dt><dd>${esc(p.per)}</dd><dt>웹 게시</dt><dd>${fmtDate(p.d, true)}</dd><dt>확인 내역</dt><dd>${esc(p.v || "확인 상태가 기록되지 않았어요.")}</dd>${R.hasSupp(p) ? `<dt>편집자 보충</dt><dd>있음 · 공개 문서 ${R.srcLinks(p).length}개를 출처로 달았어요</dd>` : ""}</dl><p style="margin-top:8px">당시 도구·환경 기준이라 지금은 다를 수 있어요.</p><div class="prov__links"><a href="#" data-act="noop">편집 자료 안내</a><a href="#" data-act="noop">정정·삭제 요청</a></div></div>`
      : "";

    const tocNav = hasToc ? `<nav class="toc" aria-label="목차"><h2>목차</h2>${toc.map((h, i) => `<a href="#${h.id}" data-act="toc"${i === 0 ? ' aria-current="true"' : ""}>${esc(h.text)}</a>`).join("")}</nav>` : "";
    const tocM = hasToc ? `<details class="toc-m"><summary>목차 ${toc.length}${I("down", "ico--s")}</summary><ol>${toc.map((h) => `<li><a href="#${h.id}" data-act="toc">${esc(h.text)}</a></li>`).join("")}</ol></details>` : "";
    const tags = [...new Set((p.g || []).map(canon))];

    const article = `<article class="article">${back}${notice}
<header class="post-head"><div class="post-head__tags"><span class="ptag ptag--${pur}">${PURPOSE_LABEL[pur]}</span>${!mine ? stateOfRow(p) : ""}${p.ex && !p.author ? '<span class="ex">예시</span>' : ""}</div>
<h1 class="post-title">${esc(p.t)}</h1><div class="byline">${by}</div>${prov}</header>
${tocM}<div class="prose">${html}</div>
${tags.length ? `<div class="post-tags" aria-label="주제">${tags.map((t) => `<a class="chip" ${link("topic", { tag: t })}>#${esc(t)}</a>`).join("")}</div>` : ""}
${p.st === "held" || p.st === "pending" ? "" : `<div class="post-acts"><button class="btn btn--quiet" data-act="copy-link">${I("link", "ico--s")}링크 복사</button><a class="btn btn--quiet" href="#" data-act="noop">${I("flag", "ico--s")}글 신고·삭제 요청</a></div>`}
</article>`;

    if (p.st === "held" || p.st === "pending") return `<div class="shell page"><div class="post-grid">${article}</div></div>`;

    const confirmed = (CONFIRMED[p.id] || []).map((id) => BY_ID.get(id)).filter(Boolean);
    const same = R.sameTopic(p, POSTS, 3).filter((x) => !confirmed.includes(x));
    const relList = (arr) => `<ul class="rel">${arr.map((x) => `<li><a ${link("post", { id: x.id })}><b>${esc(x.t)}</b><span>${preview(x, "", 120)}</span></a></li>`).join("")}</ul>`;
    const relBlk = (confirmed.length ? `<section class="blk" aria-labelledby="rel1"><h2 id="rel1">함께 읽을 글 <small>내용이 이어지는 글</small></h2>${relList(confirmed)}</section>` : "") +
      (same.length ? `<section class="blk" aria-labelledby="rel2"><h2 id="rel2">같은 주제의 글</h2>${relList(same)}</section>` : "");

    const isQ = pur === "question";
    let comments = [];
    if (p.id === "ex-long") comments = R.EX_ANSWERS.share;
    else if (st.state === "active") comments = isQ ? R.EX_ANSWERS.question : R.EX_ANSWERS.share;
    const noun = isQ ? "답변" : "댓글";
    const cHtml = comments
      .map((c) => `<div class="cmt${c.reply ? " cmt--reply" : ""}"><div class="cmt__by"><b>${esc(c.by)}</b><span>${relDate(c.at)}</span><span class="ex">예시</span></div><div class="prose">${R.mdToHtml(c.b).html}</div>${c.reply ? "" : `<div class="cmt__acts"><button class="btn btn--quiet btn--sm" data-act="noop">답글</button></div>`}</div>`)
      .join("");
    const composer =
      st.auth === "member"
        ? `<div class="composer"><label class="sr-only" for="cmt">${noun} 쓰기</label><textarea id="cmt" class="field" rows="4" placeholder="${isQ ? "확인한 사실과 추측을 나눠 적어 주세요." : "보충·정정·질문을 남겨 주세요."}"></textarea><p class="composer__hint">코드는 \`\`\` 로 감싸면 코드 블록으로 보여요.</p><div class="composer__row"><span class="fhint" style="margin:0">2,000자까지</span><button class="btn btn--primary" data-act="noop">${noun} 등록</button></div></div>`
        : `<div class="login-cta"><span>${noun}을 쓰려면 로그인이 필요해요.</span><a class="btn btn--primary" href="#" data-act="noop">로그인하고 ${noun} 쓰기</a></div>`;
    const ansBlk = `<section class="blk" id="answers" aria-labelledby="ans-t"><h2 id="ans-t">${noun} <small>${comments.length}</small></h2><div class="answers">${cHtml || `<p class="answers__empty">${isQ ? "아직 답변이 없어요. 아는 내용이 있으면 짧게라도 남겨 주세요." : "아직 댓글이 없어요. 다른 환경에서 확인한 결과나 정정할 점을 남겨 주세요."}</p>`}${composer}</div></section>`;

    return `<div class="shell page"><div class="post-grid${hasToc ? " post-grid--toc" : ""}">${article}${tocNav}</div>${isQ ? ansBlk + relBlk : relBlk + ansBlk}</div>`;
  }

  /* ───────── 글 쓰기 ───────── */
  const GUIDE = {
    question: "분석 환경, 시도한 내용과 막힌 지점을 적어 주세요. 확인한 사실과 추측을 나누면 답을 받기 쉬워요.",
    analysis: "재현 환경과 분석 과정, 확인한 근거를 함께 남겨 주세요. AI를 썼다면 제안받은 내용과 직접 확인한 결과를 나눠 주세요.",
    discussion: "리버싱에 관한 소식, 경험이나 생각을 자유롭게 나눠 주세요.",
  };
  function vNew(st) {
    if (st.auth !== "member")
      return `<div class="shell page"><div class="form"><a class="crumb" ${link("home")}>${I("left", "ico--s")}목록으로</a><div class="empty"><h2>글을 쓰려면 로그인이 필요해요</h2><p>로그인하면 이 화면으로 돌아와요. 글은 누구나 읽을 수 있어요.</p><div class="acts"><a class="btn btn--primary" href="#" data-act="noop">로그인</a><a class="btn" href="#" data-act="noop">회원가입</a></div></div></div></div>`;
    const kind = st.kind || "question";
    const title = st.title != null ? st.title : "IAT에서 API 주소 확인";
    const sim = similarTo(title);
    const radio = (k, l, h) => `<label><input type="radio" name="kind" value="${k}" data-act="kind" ${kind === k ? "checked" : ""}><b>${l}</b><small>${h}</small></label>`;
    const body = st.draft != null ? st.draft : "환경: Windows 10 x64, x64dbg\n\n시도한 것: IAT에서 `GetProcAddress` 항목을 찾아 주소를 확인했습니다.\n\n```asm\nmov  rax, qword ptr [rip+1F82h]   ; IAT 항목\ncall rax\n```\n\n막힌 곳: 실행할 때마다 이 주소가 달라지는 이유가 궁금합니다.";
    const tagsNow = st.tags || ["IAT", "Windows"];
    return `<div class="shell page"><form class="form" data-act="noop-form" onsubmit="return false"><a class="crumb" ${link("home")}>${I("left", "ico--s")}목록으로</a>
<div class="page-head"><div><h1>글 쓰기</h1></div></div>
<fieldset style="border:0;padding:0;margin:0"><legend class="flabel" style="margin-top:0">어떤 도움이나 반응을 원하나요?</legend><div class="purpose">${radio("question", "질문", "답변 요청")}${radio("analysis", "공유", "분석·방법")}${radio("discussion", "자유", "소식·생각")}</div></fieldset>
<p class="guide-line">${GUIDE[kind]}</p>
<label class="flabel" for="nt">제목</label><input id="nt" class="field" data-act="ntitle" value="${esc(title)}" maxlength="160" placeholder="${kind === "question" ? "어디에서 막혔는지 한 문장으로 적어 주세요" : "분석하거나 공유할 내용을 한 문장으로 적어 주세요"}">
<div id="similar">${similarBox(sim)}</div>
<div class="flabel-row"><label class="flabel" for="nb">본문</label><span class="seg" role="group" aria-label="본문 보기"><button type="button" data-act="preview" data-v="0" aria-pressed="${!st.preview}">작성</button><button type="button" data-act="preview" data-v="1" aria-pressed="${!!st.preview}">미리보기</button></span></div>
<div class="editor">${st.preview ? "" : `<div class="editor__bar" role="toolbar" aria-label="본문에 넣기"><button type="button" class="code__btn" data-act="ins" data-v="code">코드</button><button type="button" class="code__btn" data-act="ins" data-v="disasm">디스어셈블리</button><button type="button" class="code__btn" data-act="ins" data-v="table">표</button><button type="button" class="code__btn" data-act="ins" data-v="link">링크</button></div>`}
${st.preview ? `<div class="prose" aria-label="본문 미리보기">${R.mdToHtml(body).html}</div>` : `<textarea id="nb" class="field" data-act="nbody" rows="12">${esc(body)}</textarea>`}</div>
<p class="fhint">코드·디스어셈블리는 버튼으로 넣거나 \`\`\`로 감싸요. 이미지 첨부는 준비 중이에요.</p>
<label class="flabel" for="ntag">주제 <span class="alias">최대 5개</span></label>
<div class="chips" style="margin-bottom:8px">${tagsNow.map((t) => `<span class="chip chip--x" aria-pressed="true">#${esc(t)}<button type="button" class="icon-btn" style="width:24px;height:24px" aria-label="${esc(t)} 빼기" data-act="noop">${I("x", "ico--s")}</button></span>`).join("")}</div>
<input id="ntag" class="field" placeholder="주제 입력 (예: PE, 윈도우)" value="윈도우" data-act="noop">
<div class="similar" style="margin-top:6px"><div class="similar__h"><span>‘윈도우’는 <b>Windows</b> 주제로 붙어요</span></div><a href="#" data-act="noop">Windows <span class="chip__n" aria-hidden="true">23</span></a><a href="#" data-act="noop">Windows API <span class="chip__n" aria-hidden="true">3</span></a></div>
<div class="form-foot"><p class="fhint" style="margin:0;max-width:520px">등록하면 비공개로 저장되고, 기본 확인을 통과하면 공개돼요. 다른 사람의 대화 원문, 개인 정보, 게임 치트 배포 링크는 올리지 말아 주세요.</p><button class="btn btn--primary" type="button" data-act="noop">${I("send", "ico--s")}등록</button></div>
</form></div>`;
  }
  // 제목 낱말(조사 뗀 2자 이상)마다 검색해 많이 겹치는 순. 구현은 서버의 기존 검색을 그대로 부른다.
  function similarTo(title) {
    const words = String(title).split(/\s+/).map((w) => w.replace(/(에서|으로|에게|부터|까지|처럼|로|을|를|이|가|은|는|의|와|과|에|도)$/, "")).filter((w) => w.length >= 2);
    const score = new Map();
    words.forEach((w) => R.search(POSTS, w).forEach((p, i) => score.set(p, (score.get(p) || 0) + 10 - Math.min(i, 9) / 10)));
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  }
  function similarBox(sim) {
    if (!sim.length) return "";
    return `<div class="similar"><div class="similar__h"><span>비슷한 글이 있어요 · 먼저 확인해 보세요</span><span>${sim.length}</span></div>${sim.map((p) => `<a ${link("post", { id: p.id })}>${esc(p.t)}</a>`).join("")}</div>`;
  }

  /* ───────── 내 글 ───────── */
  function vMe(st) {
    if (st.auth !== "member") return vNew(st);
    const L = { published: ["공개", "ok"], pending: ["확인 중", "wait"], held: ["공개 보류", "held"] };
    const c = { published: 0, pending: 0, held: 0 };
    R.EX_MY.forEach((p) => c[p.st]++);
    const f = st.mest || "";
    const list = R.EX_MY.filter((p) => !f || p.st === f);
    const ch = (v, l, n) => `<a class="chip" href="#" data-act="mest" data-v="${v}" aria-pressed="${f === v}">${l}<span class="chip__n" aria-hidden="true">${n}</span></a>`;
    return `<div class="shell page"><div class="narrow"><section><div class="page-head"><div><h1>내 글 <span class="ex">예시</span></h1><p>확인 중이거나 공개 보류된 글은 나에게만 보여요.</p></div><a class="btn btn--primary btn--sm only-narrow" ${link("new")}>글 쓰기</a></div>
<div class="chips chips--scroll" role="group" aria-label="공개 상태">${ch("", "전체", R.EX_MY.length)}${ch("published", "공개", c.published)}${ch("pending", "확인 중", c.pending)}${ch("held", "공개 보류", c.held)}</div>
<div class="count-line"><span>내 글 <strong>${list.length}</strong>개</span><span>최근 작성순</span></div>
<div class="list">${list
      .map((p) => `<article class="row"><div class="row__top"><span class="ptag ptag--${purposeOf(p)}">${PURPOSE_LABEL[purposeOf(p)]}</span><span class="state state--${L[p.st][1]}">${L[p.st][0]}</span></div><h2 class="row__title"><a ${link("post", { id: p.id, from: "me" })}>${esc(p.t)}</a></h2><div class="row__meta"><span>${relDate(p.d)}</span>${p.st === "published" ? `<span class="sep">·</span><span>${purposeOf(p) === "question" ? "답변" : "댓글"} ${p.n}</span>` : ""}</div></article>`)
      .join("")}</div></section></div></div>`;
  }

  /* ───────── 시트 ───────── */
  function sheet(st) {
    if (st.sheet === "search")
      return `<div class="overlay" data-act="close-bg"><div class="sheet sheet--full" role="dialog" aria-modal="true" aria-label="검색"><form class="sheet__head" role="search" data-act="search-form"><button type="button" class="icon-btn" data-act="close" aria-label="닫기">${I("left")}</button><label class="sr-only" for="qs">글 검색</label><input id="qs" class="field" name="q" type="search" placeholder="제목·본문·주제 검색" autocomplete="off" style="flex:1"><button class="btn btn--primary" type="submit">검색</button></form>
<div class="sheet__body"><h3>최근 검색 <span class="alias">이 기기에만 남아요</span></h3><div class="chips">${["IAT", "OEP", "언패킹"].map((q) => `<a class="chip" ${link("search", { q })}>${q}</a>`).join("")}</div>
<h3>자주 찾는 주제</h3><div class="tcloud">${TOPICS.slice(0, 12).map((t) => `<a ${link("topic", { tag: t.tag })}>${esc(t.tag)}<span>${t.n}</span></a>`).join("")}</div>
<h3 style="margin-top:20px">답할 수 있는 질문이 있나요?</h3><a class="btn btn--block" ${link("open")}>답을 기다리는 질문 ${OPEN.length}개 보기</a></div></div></div>`;
    if (st.sheet === "zoom")
      return `<div class="overlay" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-label="그림 크게 보기"><div class="sheet__head"><b style="flex:1;font-size:15px">cmp 직전 레지스터 창 <span class="ex">예시 그림</span></b><button class="icon-btn" data-act="close" aria-label="닫기">${I("x")}</button></div><div class="sheet__body">${window.FIGURES["ex:regs"]}<p class="fhint">cmp eax, 2Ah 직전 · 인자 없이 실행. 두 손가락으로 확대할 수 있어요.</p></div></div></div>`;
    return "";
  }

  window.FIGURES = {
    "ex:regs": `<svg viewBox="0 0 640 250" role="img" aria-label="예시 그림: 레지스터 창. RAX 2A, RCX 1, RDX 27, RIP 140001005" style="font-family:var(--mono);font-size:15px">
<rect width="640" height="250" fill="var(--code-bg)"/><rect width="640" height="36" fill="var(--code-bar)"/>
<text x="16" y="24" fill="var(--text-2)" style="font-family:var(--font);font-size:14px;font-weight:700">레지스터 (FPU 숨김)</text><text x="624" y="24" text-anchor="end" fill="var(--text-3)" style="font-family:var(--font);font-size:13px">예시 그림 · 실제 화면 아님</text>
${[["RAX", "000000000000002A", 1], ["RBX", "0000000000000000"], ["RCX", "0000000000000001"], ["RDX", "0000000000000027"], ["RSP", "000000000014FF00"], ["RIP", "0000000140001005", 2]]
      .map(([r, v, h], i) => `${h === 1 ? `<rect x="8" y="${48 + i * 32}" width="420" height="28" rx="4" fill="var(--code-hl)"/>` : ""}<text x="20" y="${68 + i * 32}" fill="var(--code-reg)" font-weight="700">${r}</text><text x="80" y="${68 + i * 32}" fill="${h === 1 ? "var(--code-num)" : "var(--code-text)"}">${v}</text>${h === 2 ? `<text x="270" y="${68 + i * 32}" fill="var(--code-dim)">check+5</text>` : ""}`)
      .join("")}
<text x="450" y="68" fill="var(--code-dim)" style="font-family:var(--font);font-size:13px">← 3 × 1 + 39 = 42</text></svg>`,
  };

  window.VIEWS = { similarTo, header, subnav, footer, vHome, vOpen, vTopics, vTopic, vSearch, vPost, vNew, vMe, sheet, topicCloud, similarBox, BY_ID, POSTS, OPEN, TOPICS };
})();
