/* Shared boot, nav, toast, smooth hash scroll */

export function boot() {
  document.documentElement.classList.add("is-booted");
}

export function toast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function samePage(url) {
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const there = (url.pathname.split("/").pop() || "index.html").toLowerCase();
  const hereKey = here === "" || here === "index.html" ? "index.html" : here;
  const thereKey = there === "" || there === "index.html" ? "index.html" : there;
  return hereKey === thereKey;
}

export function initNav() {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (!toggle || !links) return;

  const setOpen = (open) => {
    links.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  toggle.addEventListener("click", () => setOpen(!links.classList.contains("is-open")));
  links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
}

export function initHashScroll() {
  const scrollToHash = () => {
    if (!location.hash) return;
    const el = document.querySelector(location.hash);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href*="#"]');
    if (!a) return;
    let url;
    try {
      url = new URL(a.getAttribute("href"), location.href);
    } catch {
      return;
    }
    if (!url.hash || url.hash === "#") return;
    if (!samePage(url)) return;
    const target = document.querySelector(url.hash);
    if (!target) return;
    e.preventDefault();
    history.pushState(null, "", url.hash);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  addEventListener("hashchange", scrollToHash);
  if (document.readyState === "complete") scrollToHash();
  else addEventListener("load", scrollToHash, { once: true });
}

function initTawkOffset() {
  window.Tawk_API = window.Tawk_API || {};
  window.Tawk_API.customStyle = {
    visibility: {
      desktop: { position: "br", xOffset: 18, yOffset: 18 },
      mobile: { position: "br", xOffset: 10, yOffset: 86 },
    },
  };
}

export function initApp() {
  boot();
  initTawkOffset();
  initNav();
  initHashScroll();
  dispatchEvent(new Event("app:ready"));
}