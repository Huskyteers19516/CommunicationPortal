// BIOBUZZ Edition: applies the saved theme before first paint (new file, not part of upstream).
// A file rather than an inline <script> in index.html, so a Content-Security-Policy of
// script-src 'self' (the Huskyteers Portal serves the planner with one) lets it run.
// Mirrors App.svelte's applyTheme(); settings live in localStorage
// "biobuzz_pp_settings" as { version, settings: { theme } }. index.html loads it
// blocking in <head>, so dark mode never flashes white.
(function () {
  try {
    var raw = localStorage.getItem("biobuzz_pp_settings");
    var settings = raw ? JSON.parse(raw).settings || {} : {};
    var theme = settings.theme || "light";
    var dark =
      theme === "dark" ||
      (theme === "auto" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute("content", dark ? "#171717" : "#fafafa");
    }
  } catch (e) {
    /* storage blocked or malformed: keep the light default */
  }
})();
