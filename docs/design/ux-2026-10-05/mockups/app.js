/* Reversing All 목업 · 상태·화면 전환·이벤트·검토 툴바 */
(function () {
  "use strict";
  const V = window.VIEWS;
  const R = window.RA;
  const app = document.getElementById("app");
  const device = document.getElementById("device");
  const scaler = document.getElementById("scaler");
  const scroller = document.getElementById("scroll");

  const ID = {
    short: "38fd49d0-8916-4e74-a430-337e0c9ac319",
    supp: "16daebf1-972e-4e62-abce-6744926531c6",
    q: "80c24945-af64-4297-8ba5-eaec4bf2cc70",
  };
  // 툴바 "화면" 바로가기 → 상태
  const SCREENS = {
    home: { screen: "home" },
    open: { screen: "open" },
    topics: { screen: "topics" },
    guide: { screen: "topic", guide: "executables" },
    tag: { screen: "topic", tag: "리버싱" },
    search: { screen: "search", q: "IAT" },
    "search-empty": { screen: "search", q: "Ghidra" },
    "post-short": { screen: "post", id: ID.short },
    "post-supp": { screen: "post", id: ID.supp },
    "post-prov": { screen: "post", id: ID.supp, prov: 1 },
    "post-q": { screen: "post", id: ID.q },
    "post-long": { screen: "post", id: "ex-long" },
    "post-held": { screen: "post", id: "ex-held", from: "me" },
    new: { screen: "new" },
    me: { screen: "me" },
    "search-sheet": { screen: "home", sheet: "search" },
    zoom: { screen: "post", id: "ex-long", sheet: "zoom" },
  };
  const KEYS = ["size", "theme", "auth", "state", "screen", "id", "q", "tag", "guide", "purpose", "page", "prov", "sheet", "from", "full", "preview", "kind", "mest"];
  const DEFAULTS = { size: "mobile", theme: "light", appTheme: "system", auth: "guest", state: "normal", screen: "home", page: 1 };
  const st = { ...DEFAULTS };

  // 해시가 곧 전체 상태다(검토·스크린샷 재현용). 해시에 없는 값은 기본값으로 되돌린다.
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, DEFAULTS);
    KEYS.forEach((k) => { if (h.has(k)) st[k] = h.get(k); });
    if (h.has("go") && SCREENS[h.get("go")]) Object.assign(st, SCREENS[h.get("go")]);
    st.page = Number(st.page) || 1;
    st.prov = st.prov === "1" || st.prov === 1 || st.prov === true;
    st.preview = st.preview === "1" || st.preview === true;
  }
  function writeHash() {
    const h = new URLSearchParams();
    KEYS.forEach((k) => {
      const v = st[k];
      if (v === undefined || v === "" || v === null || v === false || (k === "page" && v === 1)) return;
      h.set(k, v === true ? "1" : v);
    });
    history.replaceState(null, "", "#" + h.toString());
  }

  function main() {
    switch (st.screen) {
      case "open": return V.vOpen(st);
      case "topics": return V.vTopics(st);
      case "topic": return V.vTopic(st);
      case "search": return V.vSearch(st);
      case "post": return V.vPost(st);
      case "new": return V.vNew(st);
      case "me": return V.vMe(st);
      default: return V.vHome(st);
    }
  }
  const WITH_SUBNAV = new Set(["home", "open", "topics", "topic", "search"]);

  function render(keepScroll) {
    const y = scroller.scrollTop;
    device.dataset.size = st.size;
    device.dataset.full = st.full === "1" ? "1" : "0";
    app.dataset.theme = st.theme;
    app.innerHTML = `<div class="app-inner">${V.header(st)}${WITH_SUBNAV.has(st.screen) ? V.subnav(st) : ""}<main id="main">${main()}</main>${V.footer(st)}${V.sheet(st)}</div>`;
    scroller.scrollTop = keepScroll ? y : 0;
    if (st.anchor) {
      const el = app.querySelector("#" + st.anchor);
      if (el) scroller.scrollTop = el.offsetTop - 70;
      st.anchor = "";
    }
    // 디스어셈블리 바이트 열: Compact(<600)에서는 처음에 숨긴다
    if (app.offsetWidth < 600) app.querySelectorAll('.code [data-act="bytes"]').forEach((b) => { b.setAttribute("aria-pressed", "false"); b.closest(".code").classList.add("code--nobytes"); });
    syncToolbar();
    writeHash();
    fit();
  }

  function fit() {
    const avail = document.querySelector(".stage").clientWidth - 32;
    const w = device.offsetWidth;
    const k = Math.min(1, avail / w);
    scaler.style.transform = k < 1 ? `scale(${k})` : "";
    scaler.style.width = w + "px";
    scaler.style.margin = k < 1 ? "0" : "0 auto";
    scaler.style.height = k < 1 ? device.offsetHeight * k + "px" : "";
  }

  /* ───────── 앱 안 동작 ───────── */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || !app.contains(t)) return;
    const a = t.dataset.act;
    const d = t.dataset;
    if (["go", "page", "purpose", "noop", "open-tag", "mest", "all-topics", "copy-link", "theme", "close", "sheet", "zoom", "toc", "prov", "wrap", "bytes", "copy", "ins", "preview", "close-bg"].includes(a) && t.tagName !== "INPUT") e.preventDefault();
    switch (a) {
      case "go": {
        const prev = { screen: st.screen, q: st.q, tag: st.tag, guide: st.guide, purpose: st.purpose, page: st.page };
        ["id", "q", "tag", "guide", "purpose", "from", "title", "kind"].forEach((k) => (st[k] = d[k] !== undefined ? d[k] : k === "title" || k === "kind" ? undefined : ""));
        if (d.screen === "post" && !d.from) { st.from = ["home", "open", "topic", "search", "topics"].includes(prev.screen) ? prev.screen : "home"; st.fromArgs = prev.screen === st.from ? { q: prev.q, tag: prev.tag, guide: prev.guide } : {}; }
        if (d.screen !== "post") st.fromArgs = {};
        if (d.screen === "new" && d.title !== undefined) { st.title = d.title; st.draft = ""; st.tags = []; }
        if (d.screen === "new" && d.title === undefined) { st.title = undefined; st.draft = undefined; st.tags = undefined; }
        st.screen = d.screen;
        st.page = 1;
        st.prov = false;
        st.sheet = "";
        st.preview = false;
        st.anchor = d.anchor || "";
        render();
        break;
      }
      case "page": st.page = Number(d.v); render(); scroller.scrollTop = 0; break;
      case "purpose": st.purpose = d.v; st.page = 1; render(true); break;
      case "open-tag": st.tag = d.v; st.page = 1; render(true); break;
      case "mest": st.mest = d.v; render(true); break;
      case "theme": st.appTheme = d.v; st.theme = d.v === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : d.v; render(true); break;
      case "all-topics": st.allTopics = true; document.getElementById("tcloud").innerHTML = V.topicCloud(st.tf, true); break;
      case "sheet": st.sheet = d.v; render(true); setTimeout(() => { const i = app.querySelector("#qs"); if (i) i.focus(); }); break;
      case "zoom": st.sheet = "zoom"; render(true); break;
      case "close": st.sheet = ""; render(true); break;
      case "close-bg": if (e.target === t) { st.sheet = ""; render(true); } break;
      case "prov": {
        st.prov = t.getAttribute("aria-expanded") !== "true";
        t.setAttribute("aria-expanded", String(st.prov));
        app.querySelector("#prov").hidden = !st.prov;
        writeHash();
        break;
      }
      case "toc": {
        const el = app.querySelector(t.getAttribute("href"));
        if (el) scroller.scrollTop = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 72;
        app.querySelectorAll(".toc a").forEach((x) => x.setAttribute("aria-current", String(x.getAttribute("href") === t.getAttribute("href"))));
        break;
      }
      case "wrap": {
        const f = t.closest(".code");
        const on = t.getAttribute("aria-pressed") !== "true";
        t.setAttribute("aria-pressed", String(on));
        f.classList.toggle("code--wrap", on);
        break;
      }
      case "bytes": {
        const f = t.closest(".code");
        const on = t.getAttribute("aria-pressed") !== "true";
        t.setAttribute("aria-pressed", String(on));
        f.classList.toggle("code--nobytes", !on);
        break;
      }
      case "copy": {
        const text = window.CODE[d.id] || "";
        try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (_) {}
        t.textContent = "복사했어요";
        t.classList.add("code__btn--done");
        setTimeout(() => { t.textContent = "복사"; t.classList.remove("code__btn--done"); }, 1800);
        break;
      }
      case "copy-link": {
        const old = t.innerHTML;
        t.textContent = "링크를 복사했어요";
        setTimeout(() => (t.innerHTML = old), 1800);
        break;
      }
      case "kind": st.kind = t.value; render(true); break;
      case "preview": {
        const ta = app.querySelector("#nb");
        if (ta) st.draft = ta.value;
        const ti = app.querySelector("#nt");
        if (ti) st.title = ti.value;
        st.preview = d.v === "1";
        render(true);
        break;
      }
      case "ins": {
        const ta = app.querySelector("#nb");
        if (!ta) break;
        const tpl = {
          code: "\n```c\n// 코드\n```\n",
          disasm: "\n```disasm\n0000000140001000  6B C1 03   imul  eax, ecx, 3\n```\n",
          table: "\n| 항목 | 값 |\n| --- | --- |\n|  |  |\n",
          link: "[링크 이름](https://)",
        }[d.v];
        const s = ta.selectionStart;
        ta.value = ta.value.slice(0, s) + tpl + ta.value.slice(ta.selectionEnd);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = s + tpl.length;
        st.draft = ta.value;
        break;
      }
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!app.contains(t)) return;
    if (t.dataset.act === "tfilter") {
      st.tf = t.value;
      document.getElementById("tcloud").innerHTML = V.topicCloud(st.tf, st.allTopics);
    }
    if (t.dataset.act === "ntitle") {
      st.title = t.value;
      document.getElementById("similar").innerHTML = V.similarBox(V.similarTo(t.value));
    }
    if (t.dataset.act === "nbody") st.draft = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (app.contains(t) && t.dataset.act === "kind") { st.kind = t.value; render(true); }
  });
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if (!app.contains(f) || f.dataset.act !== "search-form") return;
    e.preventDefault();
    const q = (new FormData(f).get("q") || "").toString().trim();
    if (!q) return;
    st.q = q; st.screen = "search"; st.purpose = ""; st.page = 1; st.sheet = "";
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.sheet) { st.sheet = ""; render(true); }
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      const i = app.querySelector(".hdr__search input");
      if (i && i.offsetParent) { e.preventDefault(); i.focus(); }
    }
  });

  /* ───────── 검토 툴바 ───────── */
  function syncToolbar() {
    document.querySelectorAll(".review__group[data-r] button").forEach((b) => {
      const g = b.parentElement.dataset.r;
      b.setAttribute("aria-pressed", String(st[g] === b.dataset.v));
    });
    document.getElementById("r-state").value = st.state;
    const cur = Object.entries(SCREENS).find(([, v]) => Object.entries(v).every(([k, x]) => String(st[k] ?? "") === String(x)) && (v.sheet || "") === (st.sheet || ""));
    document.getElementById("r-screen").value = cur ? cur[0] : "";
  }
  document.querySelector(".review").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    const g = b.parentElement.dataset.r;
    st[g] = b.dataset.v;
    if (g === "theme") st.appTheme = b.dataset.v;
    render(true);
  });
  document.getElementById("r-state").addEventListener("change", (e) => { st.state = e.target.value; render(true); });
  document.getElementById("r-screen").addEventListener("change", (e) => {
    const s = SCREENS[e.target.value];
    if (!s) return;
    ["id", "q", "tag", "guide", "purpose", "from", "sheet", "title", "kind"].forEach((k) => (st[k] = ""));
    st.title = undefined; st.kind = undefined; st.prov = false; st.page = 1; st.fromArgs = {};
    Object.assign(st, s);
    st.prov = !!s.prov;
    render();
  });
  addEventListener("resize", fit);
  addEventListener("hashchange", () => { readHash(); render(); });

  readHash();
  render();
})();
