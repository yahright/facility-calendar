/* 施設利用カレンダー
 * - ログインなしでも日付カレンダーとして動く（祝日は計算で表示）
 * - 「Google の予定を取り込む」を押した人だけ、自分の Google カレンダーの予定が各日に重なる
 * - 選んだ日は端末の localStorage に保存。Google ログイン時は Drive のアプリ専用領域にも同期
 */
(() => {
  "use strict";
  const CFG = Object.assign({ clientId: "", driveSync: true, defaultTarget: 20 }, window.FC_CONFIG || {});
  const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
    .concat(CFG.driveSync ? ["https://www.googleapis.com/auth/drive.appdata"] : []).join(" ");
  const DRIVE_NAME = "facility-calendar.json";

  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const keyOf = (y, m) => `${y}-${pad(m + 1)}`;
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const todayKey = dateKey(new Date());

  // ---------------------------------------------------------------- 祝日（計算）
  const holidayCache = {};
  function jpHolidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    const h = {};
    const put = (m, d, name) => { h[`${y}-${pad(m)}-${pad(d)}`] = name; };
    const nthMon = (m, n) => { const first = new Date(y, m - 1, 1).getDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
    put(1, 1, "元日");
    put(1, nthMon(1, 2), "成人の日");
    put(2, 11, "建国記念の日");
    put(2, 23, "天皇誕生日");
    put(3, Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)), "春分の日");
    put(4, 29, "昭和の日");
    put(5, 3, "憲法記念日"); put(5, 4, "みどりの日"); put(5, 5, "こどもの日");
    put(7, nthMon(7, 3), "海の日");
    put(8, 11, "山の日");
    put(9, nthMon(9, 3), "敬老の日");
    put(9, Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)), "秋分の日");
    put(10, nthMon(10, 2), "スポーツの日");
    put(11, 3, "文化の日"); put(11, 23, "勤労感謝の日");
    // 振替休日: 日曜の祝日の直後の平日
    for (const k of Object.keys(h)) {
      const d = new Date(k + "T00:00:00");
      if (d.getDay() !== 0) continue;
      do { d.setDate(d.getDate() + 1); } while (h[dateKey(d)]);
      h[dateKey(d)] = "振替休日";
    }
    // 国民の休日: 祝日に挟まれた平日
    for (const k of Object.keys(h)) {
      const d = new Date(k + "T00:00:00"); d.setDate(d.getDate() + 2);
      const mid = new Date(d); mid.setDate(mid.getDate() - 1);
      if (h[dateKey(d)] && !h[dateKey(mid)] && mid.getDay() !== 0) h[dateKey(mid)] = "国民の休日";
    }
    holidayCache[y] = h;
    return h;
  }

  // ---------------------------------------------------------------- 状態
  const now = new Date();
  let view = { y: now.getFullYear(), m: now.getMonth() };
  let userKey = "local";
  let data = emptyData();
  let selectedDay = null;
  const auth = { token: null, exp: 0, client: null, email: null };
  let calendars = [];          // {id, name, color, selected, primary, holiday}
  let hidden = new Set();      // 非表示カレンダー id
  const evCache = {};          // monthKey -> { calId -> [event] }
  let evStatus = { kind: "plain" };
  let loadToken = 0;
  const drive = { fileId: null, status: "off", at: 0, timer: null, busy: Promise.resolve() };

  function emptyData() { return { version: 1, target: CFG.defaultTarget, hiddenCalendars: null, months: {}, updatedAt: 0 }; }
  function normalize(d) {
    const out = emptyData();
    if (!d || typeof d !== "object") return out;
    if (typeof d.target === "number") out.target = d.target;
    if (Array.isArray(d.hiddenCalendars)) out.hiddenCalendars = d.hiddenCalendars.slice();
    if (d.months && typeof d.months === "object") {
      for (const k of Object.keys(d.months)) {
        const m = d.months[k] || {};
        out.months[k] = { days: Object.assign({}, m.days || {}), target: typeof m.target === "number" ? m.target : out.target, updatedAt: Number(m.updatedAt) || 0 };
      }
    }
    out.updatedAt = Number(d.updatedAt) || 0;
    return out;
  }
  function monthKey() { return keyOf(view.y, view.m); }
  function month() { return data.months[monthKey()] || { days: {}, target: data.target, updatedAt: 0 }; }
  function writeMonth(patch) {
    const cur = month();
    data.months[monthKey()] = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    saveData();
  }

  // ---------------------------------------------------------------- 保存
  function storageKey() { return "fc:data:" + userKey; }
  function loadData() {
    try { const raw = localStorage.getItem(storageKey()); data = raw ? normalize(JSON.parse(raw)) : emptyData(); }
    catch (e) { data = emptyData(); }
  }
  function saveLocal() { try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (e) {} }
  function saveData() {
    data.updatedAt = Date.now();
    saveLocal();
    scheduleDriveSave();
  }

  // ---------------------------------------------------------------- 描画
  function visibleCalendars() { return calendars.filter((c) => !hidden.has(c.id)); }

  function eventsForMonth() {
    const byDay = {}, hol = Object.assign({}, jpHolidays(view.y));
    const cache = evCache[monthKey()] || {};
    for (const cal of visibleCalendars()) {
      for (const ev of (cache[cal.id] || [])) {
        if (cal.holiday) { hol[ev.day] = ev.title; continue; }
        (byDay[ev.day] ||= []).push(Object.assign({ color: cal.color, cal: cal.name }, ev));
      }
    }
    for (const k in byDay) byDay[k].sort((a, b) => a.ts - b.ts);
    return { byDay, hol };
  }

  function render() {
    const md = month();
    const target = Number(md.target) || 0;
    const count = Object.values(md.days).filter(Boolean).length;
    $("#title").textContent = `${view.y}年${view.m + 1}月`;
    $("#count").textContent = count;
    $("#goal").textContent = target;
    if ($("#target") !== document.activeElement) $("#target").value = target;
    const rest = $("#rest");
    rest.classList.remove("over", "done");
    if (count > target) { rest.textContent = `超過 ${count - target} 日`; rest.classList.add("over"); }
    else if (count === target && target > 0) { rest.textContent = "ちょうど目標どおり"; rest.classList.add("done"); }
    else rest.textContent = `あと ${target - count} 日`;
    const bar = $("#bar");
    bar.style.width = target ? Math.min(100, count / target * 100) + "%" : "0%";
    bar.classList.toggle("over", count > target);

    const { byDay, hol } = eventsForMonth();
    const first = new Date(view.y, view.m, 1);
    const daysIn = new Date(view.y, view.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push(`<div class="day blank" aria-hidden="true"></div>`);
    for (let d = 1; d <= daysIn; d++) {
      const dt = new Date(view.y, view.m, d);
      const k = dateKey(dt);
      const dow = dt.getDay();
      const cls = ["day"];
      if (dow === 0) cls.push("sun");
      if (dow === 6) cls.push("sat");
      if (hol[k]) cls.push("hol");
      if (k === todayKey) cls.push("is-today");
      if (md.days[k]) cls.push("on");
      if (k === selectedDay) cls.push("sel");
      const evs = byDay[k] || [];
      const chips = evs.slice(0, 3).map((e) =>
        `<div class="chip" title="${esc(e.title)}"><span class="dot" style="background:${esc(e.color)}"></span>${e.time ? `<span class="t">${e.time}</span>` : ""}<span class="ttl">${esc(e.title)}</span></div>`).join("");
      const more = evs.length > 3 ? `<div class="more">+${evs.length - 3}</div>` : "";
      const holEl = hol[k] ? `<div class="holname" title="${esc(hol[k])}">${esc(hol[k])}</div>` : "";
      cells.push(`<button class="${cls.join(" ")}" data-date="${k}" aria-pressed="${md.days[k] ? "true" : "false"}" aria-label="${view.m + 1}月${d}日${md.days[k] ? " 利用" : ""}">
        <div class="num"><b>${d}</b></div>${holEl}<div class="chips">${chips}${more}</div></button>`);
    }
    const tail = (7 - (cells.length % 7)) % 7;
    for (let i = 0; i < tail; i++) cells.push(`<div class="day blank" aria-hidden="true"></div>`);
    $("#grid").innerHTML = cells.join("");

    renderDetail(byDay, hol);
    renderCalendars();
    renderStatus();
  }

  function renderDetail(byDay, hol) {
    const box = $("#detail");
    if (!selectedDay || !selectedDay.startsWith(monthKey())) { box.hidden = true; return; }
    box.hidden = false;
    const md = month();
    const [y, m, d] = selectedDay.split("-").map(Number);
    const dow = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
    $("#detailTitle").textContent = `${m}月${d}日（${dow}）${hol[selectedDay] ? " " + hol[selectedDay] : ""}${md.days[selectedDay] ? " ・ 利用" : ""}`;
    $("#detailToggle").textContent = md.days[selectedDay] ? "利用をやめる" : "利用にする";
    const evs = byDay[selectedDay] || [];
    $("#evlist").innerHTML = evs.length
      ? evs.map((e) => `<li><span class="dot" style="background:${esc(e.color)}"></span><span class="t">${e.time || "終日"}</span><span>${esc(e.title)}<span class="c">${esc(e.cal)}</span></span></li>`).join("")
      : `<li class="none">${auth.token ? "予定はありません" : "Google の予定を取り込むと、この日の予定がここに出ます"}</li>`;
  }

  function renderCalendars() {
    const box = $("#cals");
    if (!calendars.length) { box.hidden = true; return; }
    box.hidden = false;
    $("#calCount").textContent = `（${visibleCalendars().length} / ${calendars.length}）`;
    $("#callist").innerHTML = calendars.map((c) =>
      `<label><input type="checkbox" data-cal="${esc(c.id)}" ${hidden.has(c.id) ? "" : "checked"}><span class="sw" style="background:${esc(c.color)}"></span>${esc(c.name)}</label>`).join("");
  }

  function renderStatus() {
    const s = evStatus;
    let html = "";
    if (s.kind === "plain") html = `<span>Google の予定を取り込むと、各日に自分の予定が表示されます。</span>`;
    else if (s.kind === "setup") html = `<span class="err">予定の取り込みには、公開者側で config.js の clientId の設定が必要です（README 参照）。</span>`;
    else if (s.kind === "wait") html = `<span>Google のログイン画面を準備中…</span>`;
    else if (s.kind === "loading") html = `<span>予定を読み込み中…</span>`;
    else if (s.kind === "ok") {
      html = `<span>予定: ${s.ok} カレンダー（${pad(new Date(s.at).getHours())}:${pad(new Date(s.at).getMinutes())} 時点）</span><button id="reload">更新</button>`;
      if (s.failed) html += `<span class="err">${s.failed} 件のカレンダーを読み込めませんでした</span>`;
    }
    else if (s.kind === "error") html = `<span class="err">${esc(s.msg)}</span><button id="reload">再読込</button>`;
    if (auth.token && CFG.driveSync) {
      const t = drive.at ? `${pad(new Date(drive.at).getHours())}:${pad(new Date(drive.at).getMinutes())}` : "";
      const txt = { off: "", syncing: "同期中…", ok: `同期済み ${t}`, disabled: "同期オフ（Google Drive API が未有効）", error: "同期エラー（端末には保存済み）" }[drive.status] || "";
      if (txt) html += `<span>${txt}</span>`;
    }
    $("#status").innerHTML = html;
    const b = $("#reload");
    if (b) b.addEventListener("click", () => loadEvents(true));
    $("#footNote").textContent = auth.token && CFG.driveSync && drive.status !== "disabled"
      ? "日をタップで利用 ⇄ 利用なし。選んだ日はこの端末と Google ドライブ（アプリ専用領域）に保存されます。"
      : "日をタップで利用 ⇄ 利用なし。選んだ日はこの端末に保存されます。";
  }

  // ---------------------------------------------------------------- Google ログイン
  function gisReady() { return !!(window.google && window.google.accounts && window.google.accounts.oauth2); }
  function initClient() {
    if (auth.client || !CFG.clientId || !gisReady()) return;
    auth.client = window.google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId, scope: SCOPES,
      callback: onToken,
      error_callback: (e) => {
        const t = e && e.type;
        evStatus = t === "popup_closed" ? { kind: "plain" }
          : t === "popup_failed_to_open" ? { kind: "error", msg: "ログイン画面（ポップアップ）がブロックされました。このサイトのポップアップを許可して、もう一度押してください。" }
          : { kind: "error", msg: "ログインできませんでした。" };
        renderStatus();
      },
    });
  }
  window.__gisLoaded = () => { initClient(); if (evStatus.kind === "wait") signIn(); };

  function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) { evStatus = { kind: "error", msg: "ログインできませんでした。" }; renderStatus(); return; }
    auth.token = resp.access_token;
    auth.exp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    try { sessionStorage.setItem("fc:token", JSON.stringify({ t: auth.token, e: auth.exp })); localStorage.setItem("fc:signedIn", "1"); } catch (e) {}
    startGoogle();
  }
  function signIn() {
    if (!CFG.clientId) { evStatus = { kind: "setup" }; renderStatus(); return; }
    if (!gisReady()) { evStatus = { kind: "wait" }; renderStatus(); return; }
    initClient();
    auth.client.requestAccessToken();
  }
  function signOut(msg) {
    auth.token = null; auth.exp = 0; auth.email = null;
    try { sessionStorage.removeItem("fc:token"); } catch (e) {}
    userKey = "local"; loadData();
    calendars = []; hidden = new Set();
    for (const k in evCache) delete evCache[k];
    drive.fileId = null; drive.status = "off"; drive.at = 0;
    evStatus = msg ? { kind: "error", msg } : { kind: "plain" };
    $("#who").hidden = true; $("#signout").hidden = true; $("#signinBtn").hidden = false;
    render();
  }

  async function gapi(url, opts) {
    opts = opts || {};
    let res;
    try {
      res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + auth.token }, opts.headers || {}) }));
    } catch (e) { throw { code: "network", message: "通信できませんでした" }; }
    if (res.status === 401) { signOut("ログインの有効期限が切れました。もう一度「Google の予定を取り込む」を押してください。"); throw { code: "auth" }; }
    if (!res.ok) {
      let message = "";
      try { message = ((await res.json()).error || {}).message || ""; } catch (e) {}
      throw { code: "http", status: res.status, message };
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function startGoogle() {
    evStatus = { kind: "loading" }; renderStatus();
    $("#signinBtn").hidden = true;
    let items;
    try {
      const r = await gapi("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader");
      items = r.items || [];
    } catch (e) {
      if (e.code === "auth") return;
      $("#signinBtn").hidden = false;
      evStatus = { kind: "error", msg: e.status === 403 ? "Google Calendar API が有効になっていないか、この Google アカウントでは許可されていません。" : "カレンダー一覧を読み込めませんでした。" };
      renderStatus(); return;
    }
    calendars = items.map((c) => ({
      id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || "#888888",
      selected: c.selected !== false && !c.hidden, primary: !!c.primary, holiday: /#holiday@/.test(c.id),
    })).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name, "ja"));
    const primary = calendars.find((c) => c.primary);
    auth.email = primary ? primary.id : "google";
    $("#who").textContent = auth.email; $("#who").hidden = false; $("#signout").hidden = false;

    // ユーザーごとの保存へ切り替え。初回はログイン前にこの端末で選んだ分を引き継ぐ
    const localData = data, wasLocal = userKey === "local";
    userKey = auth.email; loadData();
    if (wasLocal && Object.keys(data.months).length === 0 && Object.keys(localData.months).length) { data = localData; saveLocal(); }
    hidden = new Set(Array.isArray(data.hiddenCalendars) ? data.hiddenCalendars : calendars.filter((c) => !c.selected).map((c) => c.id));

    render();
    loadEvents(false);
    if (CFG.driveSync) driveSync();
  }

  // ---------------------------------------------------------------- 予定の読み込み
  async function fetchEvents(cal, tmin, tmax) {
    const out = [];
    let pageToken = "";
    for (let i = 0; i < 5; i++) {
      const q = new URLSearchParams({ timeMin: tmin, timeMax: tmax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await gapi(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const ev of (r.items || [])) {
        if (ev.status === "cancelled" || ev.eventType === "workingLocation") continue;
        const title = ev.summary || "(タイトルなし)";
        if (ev.start && ev.start.date) {
          const from = parseYmd(ev.start.date);
          const to = ev.end && ev.end.date ? parseYmd(ev.end.date) : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
          eachDay(from, to, (day) => out.push({ day, title, time: "", ts: -1 }));
        } else if (ev.start && ev.start.dateTime) {
          const s = new Date(ev.start.dateTime);
          const e = ev.end && ev.end.dateTime ? new Date(new Date(ev.end.dateTime).getTime() - 1) : s;
          const time = `${s.getHours()}:${pad(s.getMinutes())}`;
          eachDay(s, new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1), (day) => out.push({ day, title, time, ts: s.getHours() * 60 + s.getMinutes() }));
        }
      }
      pageToken = r.nextPageToken || "";
      if (!pageToken) break;
    }
    return out;
  }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function eachDay(from, toExclusive, fn) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (d < toExclusive) { fn(dateKey(d)); d.setDate(d.getDate() + 1); }
  }

  async function loadEvents(force) {
    if (!auth.token) { evStatus = CFG.clientId ? { kind: "plain" } : evStatus.kind === "setup" ? evStatus : { kind: "plain" }; render(); return; }
    const key = monthKey();
    const cache = (evCache[key] ||= {});
    const todo = visibleCalendars().filter((c) => force || !cache[c.id]);
    if (!todo.length) { if (evStatus.kind !== "ok") evStatus = { kind: "ok", ok: visibleCalendars().length, failed: 0, at: Date.now() }; render(); return; }
    const token = ++loadToken;
    evStatus = { kind: "loading" }; renderStatus();
    const tmin = new Date(view.y, view.m, 1).toISOString();
    const tmax = new Date(view.y, view.m + 1, 1).toISOString();
    const results = await Promise.allSettled(todo.map((c) => fetchEvents(c, tmin, tmax).then((evs) => ({ c, evs }))));
    if (token !== loadToken) return;
    let failed = 0, authLost = false;
    results.forEach((r) => {
      if (r.status === "fulfilled") cache[r.value.c.id] = r.value.evs;
      else { failed++; if (r.reason && r.reason.code === "auth") authLost = true; }
    });
    if (authLost) return;
    if (failed === todo.length) evStatus = { kind: "error", msg: "予定を読み込めませんでした。" };
    else evStatus = { kind: "ok", ok: visibleCalendars().length - failed, failed, at: Date.now() };
    render();
  }

  // ---------------------------------------------------------------- Google ドライブ同期（アプリ専用領域）
  function mergeData(a, b) {
    const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    const out = emptyData();
    out.target = newer.target; out.hiddenCalendars = newer.hiddenCalendars;
    for (const k of new Set([...Object.keys(a.months), ...Object.keys(b.months)])) {
      const ma = a.months[k], mb = b.months[k];
      out.months[k] = !ma ? mb : !mb ? ma : (ma.updatedAt || 0) >= (mb.updatedAt || 0) ? ma : mb;
    }
    out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    return out;
  }
  async function driveWrite() {
    const body = JSON.stringify(data);
    if (drive.fileId) {
      await gapi(`https://www.googleapis.com/upload/drive/v3/files/${drive.fileId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
    } else {
      const boundary = "fc" + Date.now();
      const multi = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: DRIVE_NAME, parents: ["appDataFolder"] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await gapi("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multi });
      drive.fileId = r.id;
    }
  }
  function driveFail(e) {
    if (e && e.code === "auth") return;
    drive.status = e && e.status === 403 ? "disabled" : "error";
    renderStatus();
  }
  async function driveSync() {
    drive.status = "syncing"; renderStatus();
    drive.busy = drive.busy.then(async () => {
      const list = await gapi(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${encodeURIComponent(`name='${DRIVE_NAME}'`)}`);
      const f = (list.files || [])[0];
      if (f) {
        drive.fileId = f.id;
        const remote = normalize(await gapi(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`));
        const merged = mergeData(data, remote);
        const js = JSON.stringify(merged);
        if (js !== JSON.stringify(data)) {
          data = merged; saveLocal();
          if (Array.isArray(data.hiddenCalendars)) hidden = new Set(data.hiddenCalendars);
          render(); loadEvents(false);
        }
        if (js !== JSON.stringify(remote)) await driveWrite();
      } else {
        await driveWrite();
      }
      drive.status = "ok"; drive.at = Date.now(); renderStatus();
    }).catch(driveFail);
  }
  function scheduleDriveSave() {
    if (!auth.token || !CFG.driveSync || drive.status === "disabled") return;
    clearTimeout(drive.timer);
    drive.timer = setTimeout(() => {
      drive.busy = drive.busy.then(async () => { await driveWrite(); drive.status = "ok"; drive.at = Date.now(); renderStatus(); }).catch(driveFail);
    }, 1200);
  }

  // ---------------------------------------------------------------- 操作
  function toggleDay(k) {
    const md = month();
    const days = Object.assign({}, md.days);
    if (days[k]) delete days[k]; else days[k] = true;
    writeMonth({ days });
  }
  $("#grid").addEventListener("click", (ev) => {
    const b = ev.target.closest(".day[data-date]");
    if (!b) return;
    selectedDay = b.dataset.date;
    toggleDay(selectedDay);
    render();
  });
  $("#detailToggle").addEventListener("click", () => { if (selectedDay) { toggleDay(selectedDay); render(); } });
  $("#target").addEventListener("input", (ev) => {
    const v = Math.max(0, Math.min(31, Number(ev.target.value) || 0));
    data.target = v; writeMonth({ target: v }); render();
  });
  const go = (y, m) => { view = { y, m }; selectedDay = null; render(); loadEvents(false); };
  $("#prev").addEventListener("click", () => go(view.m === 0 ? view.y - 1 : view.y, (view.m + 11) % 12));
  $("#next").addEventListener("click", () => go(view.m === 11 ? view.y + 1 : view.y, (view.m + 1) % 12));
  $("#gotoToday").addEventListener("click", () => go(now.getFullYear(), now.getMonth()));
  $("#clearBtn").addEventListener("click", () => $("#confirm").classList.add("show"));
  $("#clearNo").addEventListener("click", () => $("#confirm").classList.remove("show"));
  $("#clearYes").addEventListener("click", () => { $("#confirm").classList.remove("show"); writeMonth({ days: {} }); render(); });
  $("#callist").addEventListener("change", (ev) => {
    const id = ev.target.dataset && ev.target.dataset.cal;
    if (!id) return;
    if (ev.target.checked) hidden.delete(id); else hidden.add(id);
    data.hiddenCalendars = [...hidden]; saveData();
    render(); loadEvents(false);
  });
  $("#signinBtn").addEventListener("click", signIn);
  $("#signout").addEventListener("click", () => signOut());

  // ---------------------------------------------------------------- 起動
  loadData();
  render();
  if (!CFG.clientId) { $("#signinBtn").title = "公開者側の設定が必要です"; }
  try {
    const saved = JSON.parse(sessionStorage.getItem("fc:token") || "null");
    if (saved && saved.e > Date.now()) { auth.token = saved.t; auth.exp = saved.e; startGoogle(); }
  } catch (e) {}
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
