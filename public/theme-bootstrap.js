(() => {
  let theme = "system";
  try {
    const saved = localStorage.getItem("reversing-all:theme");
    if (saved === "system" || saved === "light" || saved === "dark")
      theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme;
})();
