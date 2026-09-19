(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const GIB = 1024 ** 3;
  const CONCURRENCY = 4; // parts uploaded at the same time
  const MAX_TRIES = 5; // tries per part before giving up

  /* ---------- Text in both languages ---------- */
  const T = {
    en: {
      headline: "Upload a file, get a link that stays",
      sub: "Your file is stored on Cloudflare and the direct link never expires.",
      choose: "Choose file",
      upload: "Upload",
      another: "Upload another file",
      done: "Uploaded. Your direct link:",
      linksTitle: "Your links",
      linksSub: "Every file uploaded from this device.",
      empty: "No files yet. Upload one and its link appears here.",
      tabUpload: "Upload",
      tabLinks: "Links",
      deploy: "Deploy to Cloudflare",
      deployHint: "Get your own copy of this site in one click.",
      copy: "Copy link",
      open: "Open file",
      remove: "Remove file",
      copied: "Link copied",
      copyFail: "Copy failed. Select the link and copy it by hand.",
      limit: (gb) => `Each file can be up to ${gb} GB.`,
      errBig: (gb) => `This file is larger than ${gb} GB. Choose a smaller file.`,
      errEmpty: "This file is empty. Choose another file.",
      errNet: "The connection dropped and the upload was cancelled. Check your internet and try again.",
      errFail: "The upload failed. Try again in a moment.",
      finishing: "Finishing up",
      perSec: "/s",
      units: ["B", "KB", "MB", "GB"],
      locale: "en",
      title: "Upload in Claudefler",
    },
    fa: {
      headline: "فایل را آپلود کن، لینکی بگیر که می‌ماند",
      sub: "فایل شما روی کلودفلر ذخیره می‌شود و لینک مستقیم آن هرگز منقضی نمی‌شود.",
      choose: "انتخاب فایل",
      upload: "آپلود",
      another: "آپلود فایل دیگر",
      done: "آپلود شد. لینک مستقیم شما:",
      linksTitle: "لینک‌های شما",
      linksSub: "همه فایل‌هایی که از این دستگاه آپلود شده‌اند.",
      empty: "هنوز فایلی نیست. یک فایل آپلود کن تا لینکش اینجا بیاید.",
      tabUpload: "آپلود",
      tabLinks: "لینک‌ها",
      deploy: "استقرار روی کلودفلر",
      deployHint: "با یک کلیک نسخه اختصاصی خودت از این سایت را داشته باش.",
      copy: "کپی لینک",
      open: "باز کردن فایل",
      remove: "حذف فایل انتخاب‌شده",
      copied: "لینک کپی شد",
      copyFail: "کپی انجام نشد. لینک را انتخاب و دستی کپی کن.",
      limit: (gb) => `حجم هر فایل تا ${gb} گیگابایت مجاز است.`,
      errBig: (gb) => `حجم این فایل بیشتر از ${gb} گیگابایت است. فایل کوچک‌تری انتخاب کن.`,
      errEmpty: "این فایل خالی است. فایل دیگری انتخاب کن.",
      errNet: "اتصال قطع شد و آپلود لغو شد. اینترنت را بررسی کن و دوباره تلاش کن.",
      errFail: "آپلود انجام نشد. کمی بعد دوباره تلاش کن.",
      finishing: "در حال نهایی‌سازی",
      perSec: " در ثانیه",
      units: ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"],
      locale: "fa",
      title: "آپلود در کلودفلر",
    },
  };

  /* ---------- Device identity (survives clearing cookies or one storage) ---------- */
  const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const idb = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("uicf", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const idbGet = async (key) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  };
  const idbSet = async (key, value) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  };
  const readCookie = () => (document.cookie.match(/(?:^|; )uicf_device=([^;]+)/) || [])[1];
  const writeCookie = (v) => {
    document.cookie = `uicf_device=${v}; max-age=34560000; path=/; SameSite=Lax`;
  };
  const makeId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  async function getDeviceId() {
    const found = [];
    try { found.push(localStorage.getItem("uicf.device")); } catch {}
    found.push(readCookie());
    try { found.push(await idbGet("device")); } catch {}
    let id = found.find((v) => v && ID_RE.test(v));
    if (!id) id = makeId();
    try { localStorage.setItem("uicf.device", id); } catch {}
    writeCookie(id);
    try { await idbSet("device", id); } catch {}
    try { navigator.storage?.persist?.(); } catch {}
    return id;
  }

  /* ---------- State ---------- */
  let lang = "en";
  try { lang = localStorage.getItem("uicf.lang") || ""; } catch {}
  if (!T[lang]) lang = "en";

  let deviceId = "";
  let config = { repo: "", maxGb: 20 };
  let picked = null;
  let files = [];
  let lastResult = null;
  let busy = false;

  const t = (key, ...args) => {
    const v = T[lang][key];
    return typeof v === "function" ? v(...args) : v;
  };

  /* ---------- Formatting ---------- */
  function fmtSize(bytes) {
    const nf = new Intl.NumberFormat(t("locale"), { maximumFractionDigits: 1 });
    let n = bytes;
    let u = 0;
    while (n >= 1024 && u < 3) { n /= 1024; u++; }
    return `${nf.format(n)} ${t("units")[u]}`;
  }
  const fmtDate = (ms) =>
    new Intl.DateTimeFormat(t("locale"), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  const fmtNum = (n) => new Intl.NumberFormat(t("locale")).format(n);

  /* ---------- Language ---------- */
  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
    document.title = t("title");
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-label]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nLabel)));
    $("#limitText").textContent = t("limit", fmtNum(config.maxGb));
    $("#lang").dataset.active = lang;
    $$("#lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    if (picked) $("#chosenSize").textContent = fmtSize(picked.size);
    renderList();
  }

  $("#lang").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b || b.dataset.lang === lang) return;
    lang = b.dataset.lang;
    try { localStorage.setItem("uicf.lang", lang); } catch {}
    applyLang();
  });

  /* ---------- Views ---------- */
  function setView(name) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    $$(".dock button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === name)));
    $(".dock").dataset.active = name;
    if (name === "links") loadFiles();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $(".dock").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });

  /* ---------- Toast and copy ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
    }
    if (!ok) return toast(t("copyFail"));
    toast(t("copied"));
    if (btn) {
      const use = btn.querySelector("use");
      btn.classList.add("done");
      use.setAttribute("href", "#i-check");
      setTimeout(() => {
        btn.classList.remove("done");
        use.setAttribute("href", "#i-copy");
      }, 1600);
    }
  }

  /* ---------- Talking to the server ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { "x-device-id": deviceId, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw { network: true };
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw { status: res.status, code: data.error, data };
    return data;
  }

  // Upload one part with XHR so we get live progress.
  function putPart(id, n, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/upload/chunk?id=${encodeURIComponent(id)}&n=${n}`);
      xhr.setRequestHeader("x-device-id", deviceId);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject({ status: xhr.status, code: body.error });
      };
      xhr.onerror = () => reject({ network: true });
      xhr.ontimeout = () => reject({ network: true });
      xhr.send(blob);
    });
  }

  async function putPartWithRetry(id, n, blob, onProgress) {
    for (let attempt = 1; ; attempt++) {
      try {
        await putPart(id, n, blob, onProgress);
        return;
      } catch (err) {
        onProgress(0);
        const retriable = err.network || err.status >= 500 || err.status === 429;
        if (!retriable || attempt >= MAX_TRIES) throw err;
        await sleep(700 * attempt);
      }
    }
  }

  /* ---------- Upload ---------- */
  function showError(msg) {
    $("#errorText").textContent = msg;
    const el = $("#error");
    el.hidden = true;
    void el.offsetWidth;
    el.hidden = false;
  }
  const clearError = () => { $("#error").hidden = true; };

  function setPicked(file) {
    clearError();
    if (!file) return;
    if (file.size === 0) return showError(t("errEmpty"));
    if (file.size > config.maxGb * GIB) return showError(t("errBig", fmtNum(config.maxGb)));
    picked = file;
    $("#chosenName").textContent = file.name;
    $("#chosenSize").textContent = fmtSize(file.size);
    $("#pickBox").hidden = true;
    $("#chosen").hidden = false;
    $("#result").hidden = true;
  }

  function clearPicked() {
    picked = null;
    $("#file").value = "";
    $("#chosen").hidden = true;
    $("#pickBox").hidden = false;
  }

  async function uploadInParts(file) {
    const start = await api("POST", "/api/upload/start", {
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
    });
    const { id, chunkSize, chunks } = start;

    const loaded = new Array(chunks).fill(0);
    const began = Date.now();
    let lastPaint = 0;

    function paint(force) {
      const now = Date.now();
      if (!force && now - lastPaint < 120) return;
      lastPaint = now;
      const sum = loaded.reduce((a, b) => a + b, 0);
      const pct = Math.min(100, Math.floor((sum / file.size) * 100));
      const speed = sum / Math.max((now - began) / 1000, 0.5);
      $("#bar").style.width = `${pct}%`;
      $("#pct").textContent = `${fmtNum(pct)}%`;
      $("#detail").textContent =
        pct >= 100
          ? t("finishing")
          : `${fmtSize(sum)} / ${fmtSize(file.size)}   ${fmtSize(speed)}${t("perSec")}`;
    }

    const blobOf = (n) => file.slice(n * chunkSize, Math.min((n + 1) * chunkSize, file.size));

    async function runParts(list) {
      let cursor = 0;
      let failure = null;
      const lane = async () => {
        while (!failure) {
          const idx = cursor++;
          if (idx >= list.length) return;
          const n = list[idx];
          const blob = blobOf(n);
          try {
            await putPartWithRetry(id, n, blob, (l) => { loaded[n] = l; paint(false); });
            loaded[n] = blob.size;
            paint(false);
          } catch (err) {
            failure = err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, lane));
      if (failure) throw failure;
    }

    try {
      await runParts(Array.from({ length: chunks }, (_, n) => n));
      paint(true);
      // Ask the server to verify every part. If some are missing, send only those again.
      for (let round = 0; ; round++) {
        try {
          return await api("POST", `/api/upload/finish?id=${encodeURIComponent(id)}`);
        } catch (err) {
          if (err.code === "incomplete" && round < 2) {
            const missing = err.data?.missing || [];
            missing.forEach((n) => { loaded[n] = 0; });
            await runParts(missing);
          } else if (err.network && round < 3) {
            await sleep(1000 * (round + 1));
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      // Clean up the unfinished parts so nothing is left behind.
      fetch(`/api/upload/abort?id=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "x-device-id": deviceId },
        keepalive: true,
      }).catch(() => {});
      throw err;
    }
  }

  async function startUpload() {
    if (!picked || busy) return;
    busy = true;
    clearError();
    $("#chosen").hidden = true;
    $("#limit").hidden = true;
    $("#progress").hidden = false;
    $("#bar").style.width = "0%";
    $("#pct").textContent = `${fmtNum(0)}%`;
    $("#detail").textContent = "";
    $("#drop").classList.add("uploading");
    try {
      const saved = await uploadInParts(picked);
      lastResult = saved;
      files.unshift(saved);
      updateCount();
      $("#resultLink").href = saved.url;
      $("#resultLink").textContent = saved.url;
      $("#progress").hidden = true;
      $("#result").hidden = false;
      picked = null;
      $("#file").value = "";
    } catch (err) {
      $("#progress").hidden = true;
      $("#chosen").hidden = false;
      $("#limit").hidden = false;
      if (err.network) showError(t("errNet"));
      else if (err.code === "too_big") showError(t("errBig", fmtNum(config.maxGb)));
      else if (err.code === "empty") showError(t("errEmpty"));
      else showError(t("errFail"));
    } finally {
      busy = false;
      $("#drop").classList.remove("uploading");
    }
  }

  window.addEventListener("beforeunload", (e) => {
    if (busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  $("#pick").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => setPicked(e.target.files[0]));
  $("#clear").addEventListener("click", () => { clearError(); clearPicked(); });
  $("#send").addEventListener("click", startUpload);
  $("#resultCopy").addEventListener("click", (e) => lastResult && copyText(lastResult.url, e.currentTarget));
  $("#another").addEventListener("click", () => {
    $("#result").hidden = true;
    $("#limit").hidden = false;
    clearPicked();
  });

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((n) =>
    drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("dragging"); })
  );
  ["dragleave", "drop"].forEach((n) =>
    drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("dragging"); })
  );
  drop.addEventListener("drop", (e) => {
    if (busy) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) setPicked(f);
  });

  /* ---------- List ---------- */
  function updateCount() {
    const c = $("#count");
    c.hidden = files.length === 0;
    c.textContent = fmtNum(files.length);
  }

  function svg(name) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("class", "i");
    const u = document.createElementNS(ns, "use");
    u.setAttribute("href", `#i-${name}`);
    s.appendChild(u);
    return s;
  }

  function renderList() {
    const list = $("#files");
    list.replaceChildren();
    $("#empty").hidden = files.length > 0;
    updateCount();

    files.forEach((f, n) => {
      const li = document.createElement("li");
      li.className = "file";
      li.style.setProperty("--n", Math.min(n, 12));

      const head = document.createElement("div");
      head.className = "file-head";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.appendChild(svg("file"));
      const meta = document.createElement("div");
      meta.className = "file-meta";
      const name = document.createElement("div");
      name.className = "file-name";
      name.dir = "auto";
      name.textContent = f.name;
      const info = document.createElement("div");
      info.className = "file-info";
      info.textContent = `${fmtSize(f.size)}  |  ${fmtDate(f.created_at)}`;
      meta.append(name, info);
      head.append(icon, meta);

      const row = document.createElement("div");
      row.className = "linkrow";
      const link = document.createElement("a");
      link.className = "link";
      link.href = f.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = f.url;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "icon-btn";
      copy.setAttribute("aria-label", t("copy"));
      copy.appendChild(svg("copy"));
      copy.addEventListener("click", () => copyText(f.url, copy));
      const open = document.createElement("a");
      open.className = "icon-btn";
      open.href = f.url;
      open.target = "_blank";
      open.rel = "noopener";
      open.setAttribute("aria-label", t("open"));
      open.appendChild(svg("open"));
      row.append(link, copy, open);

      li.append(head, row);
      list.appendChild(li);
    });
  }

  async function loadFiles() {
    try {
      const res = await fetch("/api/files", { headers: { "x-device-id": deviceId } });
      if (!res.ok) return;
      files = (await res.json()).files || [];
      renderList();
    } catch {}
  }

  /* ---------- Start ---------- */
  async function init() {
    applyLang();
    deviceId = await getDeviceId();
    try {
      const res = await fetch("/api/config");
      if (res.ok) config = { ...config, ...(await res.json()) };
    } catch {}
    $("#limitText").textContent = t("limit", fmtNum(config.maxGb));
    if (config.repo) $("#deploy").href = `https://deploy.workers.cloudflare.com/?url=${config.repo}`;
    loadFiles();
  }
  init();
})();
