
/* ---------- 1. Utilities ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 2. i18n ---------- */
const STRINGS = {
  EN: {
    "tagline": "Plan STEM sessions, even offline",
    "step.browse": "Browse", "step.plan": "Plan", "step.saved": "Saved",
    "browse.title": "Browse activities",
    "browse.sub": "Pick a hands-on STEM activity for your group",
    "plan.title": "New session plan",
    "plan.sub": "Draft a plan with safety and inclusion checks",
    "plan.activity": "Activity", "plan.date": "Date", "plan.time": "Start time",
    "plan.duration": "Duration (min)", "plan.group": "Group size",
    "plan.facilitator": "Facilitator", "plan.location": "Location (optional)",
    "plan.safety": "Safety", "plan.inclusion": "Inclusion",
    "plan.notes": "Notes", "plan.clear": "Clear", "plan.save": "Save plan",
    "saved.title": "Saved plans",
    "saved.sub": "Your session plans, synced or waiting",
  },
  AF: {
    "tagline": "Beplan STEM-sessies, selfs vanlyn",
    "step.browse": "Blaai", "step.plan": "Beplan", "step.saved": "Gestoar",
    "browse.title": "Blaai deur aktiwiteite",
    "browse.sub": "Kies 'n praktiese STEM-aktiwiteit vir jou groep",
    "plan.title": "Nuwe sessieplan",
    "plan.sub": "Skets 'n plan met veiligheids- en insluitingskontroles",
    "plan.activity": "Aktiwiteit", "plan.date": "Datum", "plan.time": "Begintyd",
    "plan.duration": "Duur (min)", "plan.group": "Groepgrootte",
    "plan.facilitator": "Fasiliteerder", "plan.location": "Ligging (opsioneel)",
    "plan.safety": "Veiligheid", "plan.inclusion": "Insluiting",
    "plan.notes": "Notas", "plan.clear": "Maak skoon", "plan.save": "Stoor plan",
    "saved.title": "Gestoorde planne",
    "saved.sub": "Jou sessieplanne, gesinkroniseer of in wag",
  }
};

let currentLang = localStorage.getItem("stemmate_lang") || "EN";

function applyLang(lang) {
  currentLang = lang;
  localStorage.setItem("stemmate_lang", lang);
  $("#lang-toggle").textContent = lang;
  $$("[data-i18n]").forEach(el => {
    const k = el.dataset.i18n;
    if (STRINGS[lang][k]) el.textContent = STRINGS[lang][k];
  });
}

$("#lang-toggle").addEventListener("click", () =>
  applyLang(currentLang === "EN" ? "AF" : "EN"));

/* ---------- 3. Storage layer ----------
   Uses IndexedDB when available; falls back to localStorage.
   Keeps a single API: get/set for 'plans' and 'draft'.
*/
const DB_NAME = "stemmate";
const DB_VERSION = 1;
const STORE = "kv";

const storage = (() => {
  let db = null;
  let usingFallback = false;

  function open() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) { usingFallback = true; return resolve(null); }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { usingFallback = true; resolve(null); };
    });
  }

  async function ready() { if (!db && !usingFallback) db = await open(); }

  return {
    async get(key) {
      await ready();
      if (usingFallback) {
        try { return JSON.parse(localStorage.getItem("stemmate_" + key)); }
        catch { return null; }
      }
      return new Promise(res => {
        const tx = db.transaction(STORE, "readonly");
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result ?? null);
        r.onerror = () => res(null);
      });
    },
    async set(key, value) {
      await ready();
      if (usingFallback) {
        localStorage.setItem("stemmate_" + key, JSON.stringify(value));
        return;
      }
      return new Promise(res => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => res();
      });
    },
    async del(key) {
      await ready();
      if (usingFallback) { localStorage.removeItem("stemmate_" + key); return; }
      return new Promise(res => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => res();
      });
    }
  };
})();

/* ---------- 4. State ---------- */
const state = {
  activities: [],
  plans: [],
  filters: { search: "", subject: "", age: "", duration: "" },
  planFilters: { search: "", status: "" },
  editingId: null,
  lang: currentLang,
};

/* ---------- 5. Activities ---------- */
async function loadActivities() {
  try {
    const res = await fetch("data/activities.json", { cache: "force-cache" });
    state.activities = await res.json();
  } catch {
    // If offline + cache miss, try to restore from storage
    const cached = await storage.get("activities");
    state.activities = cached || [];
    if (!state.activities.length) {
      toast("Could not load activities. Connect once to cache them.");
    }
  }
  if (state.activities.length) storage.set("activities", state.activities);

  populateFilterOptions();
  populateActivitySelect();
  renderActivities();
}

function populateFilterOptions() {
  const subjects = [...new Set(state.activities.map(a => a.subject))].sort();
  const ages = [...new Set(state.activities.map(a => a.age))].sort();
  const subjSel = $("#filter-subject");
  const ageSel = $("#filter-age");
  subjects.forEach(s => subjSel.insertAdjacentHTML("beforeend", `<option value="${escapeHTML(s)}">${escapeHTML(s)}</option>`));
  ages.forEach(a => ageSel.insertAdjacentHTML("beforeend", `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`));
}

function populateActivitySelect() {
  const sel = $("#plan-activity");
  sel.innerHTML = `<option value="">Select an activity…</option>` +
    state.activities.map(a => `<option value="${a.id}">${escapeHTML(a.title)}</option>`).join("");
}

function renderChips() {
  const wrap = $("#filter-chips");
  const { search, subject, age, duration } = state.filters;
  const items = [];
  if (search) items.push(["search", `"${search}"`]);
  if (subject) items.push(["subject", subject]);
  if (age) items.push(["age", age]);
  if (duration) items.push(["duration", { short: "≤ 45 min", medium: "45–75 min", long: "75+ min" }[duration]]);
  wrap.innerHTML = items.map(([k, label]) =>
    `<span class="chip">${escapeHTML(label)}<button data-clear="${k}" aria-label="Remove filter">×</button></span>`
  ).join("");
  wrap.querySelectorAll("[data-clear]").forEach(b =>
    b.addEventListener("click", () => {
      const k = b.dataset.clear;
      state.filters[k] = "";
      if (k === "search") $("#search").value = "";
      if (k === "subject") $("#filter-subject").value = "";
      if (k === "age") $("#filter-age").value = "";
      if (k === "duration") $("#filter-duration").value = "";
      renderActivities();
    }));
}

function matchesDuration(a, bucket) {
  if (!bucket) return true;
  if (bucket === "short") return a.duration <= 45;
  if (bucket === "medium") return a.duration > 45 && a.duration <= 75;
  if (bucket === "long") return a.duration > 75;
  return true;
}

function renderActivities() {
  const { search, subject, age, duration } = state.filters;
  const q = search.trim().toLowerCase();
  const list = state.activities.filter(a => {
    const haystack = (a.title + " " + a.subject + " " + a.materials.join(" ") + " " + a.summary).toLowerCase();
    return (!q || haystack.includes(q))
      && (!subject || a.subject === subject)
      && (!age || a.age === age)
      && matchesDuration(a, duration);
  });

  $("#activity-count").textContent = `${list.length} of ${state.activities.length} activities`;

  const ul = $("#activity-list");
  ul.innerHTML = list.map(a => `
    <li class="activity-card" data-id="${a.id}" tabindex="0" role="button" aria-label="View ${escapeHTML(a.title)}">
      <span class="subject-badge">${escapeHTML(a.subject)}</span>
      <h3>${escapeHTML(a.title)}</h3>
      <div class="meta">
        <span>👥 ${escapeHTML(a.age)}</span>
        <span>⏱ ${a.duration} min</span>
        <span>${a.languages.map(l => "🌐 " + l).join(" ")}</span>
      </div>
      <p class="summary">${escapeHTML(a.summary)}</p>
      <div class="card-actions">
        <button type="button" class="ghost" data-detail="${a.id}">Details</button>
        <button type="button" class="primary" data-pick="${a.id}">Plan this</button>
      </div>
    </li>
  `).join("");

  $("#no-activities").hidden = list.length > 0;
  renderChips();

  ul.querySelectorAll("[data-detail]").forEach(b => {
    b.addEventListener("click", (e) => { e.stopPropagation(); openActivityModal(b.dataset.detail); });
  });
  ul.querySelectorAll("[data-pick]").forEach(b => {
    b.addEventListener("click", (e) => { e.stopPropagation(); pickActivity(b.dataset.pick); });
  });
  ul.querySelectorAll(".activity-card").forEach(card => {
    card.addEventListener("click", () => openActivityModal(card.dataset.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openActivityModal(card.dataset.id); }
    });
  });
}

function pickActivity(id) {
  $("#plan-activity").value = id;
  clearFieldErrors();
  goToStep(2);
  toast("Activity selected. Fill in the plan.");
}

// Filters
$("#search").addEventListener("input", debounce(e => {
  state.filters.search = e.target.value;
  renderActivities();
}, 200));
$("#filter-subject").addEventListener("change", e => { state.filters.subject = e.target.value; renderActivities(); });
$("#filter-age").addEventListener("change", e => { state.filters.age = e.target.value; renderActivities(); });
$("#filter-duration").addEventListener("change", e => { state.filters.duration = e.target.value; renderActivities(); });

$("#clear-filters").addEventListener("click", () => {
  state.filters = { search: "", subject: "", age: "", duration: "" };
  $("#search").value = ""; $("#filter-subject").value = "";
  $("#filter-age").value = ""; $("#filter-duration").value = "";
  renderActivities();
});

/* ---------- 6. Plans rendering ---------- */
function activityById(id) { return state.activities.find(a => a.id === id); }

function renderPlans() {
  const { search, status } = state.planFilters;
  const q = search.trim().toLowerCase();

  let plans = [...state.plans];
  plans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  plans = plans.filter(p => {
    const a = activityById(p.activityId);
    const hay = ((a?.title || "") + " " + (p.facilitator || "") + " " + (p.notes || "")).toLowerCase();
    const matchesSearch = !q || hay.includes(q);
    const matchesStatus = !status || (p.syncStatus || "pending") === status;
    return matchesSearch && matchesStatus;
  });

  const counts = state.plans.reduce((acc, p) => {
    const s = p.syncStatus || "pending";
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  $("#sync-summary").innerHTML = state.plans.length ? `
    <span><strong>${state.plans.length}</strong> total</span>
    <span>✅ <strong>${counts.synced || 0}</strong> synced</span>
    <span>⏳ <strong>${counts.pending || 0}</strong> pending</span>
    ${counts.conflict ? `<span>⚠️ <strong>${counts.conflict}</strong> conflicts</span>` : ""}
  ` : "";

  const ul = $("#plan-list");
  if (!plans.length) {
    ul.innerHTML = "";
    $("#no-plans").hidden = state.plans.length > 0; // show only if truly empty
    return;
  }
  $("#no-plans").hidden = true;

  ul.innerHTML = plans.map(p => {
    const a = activityById(p.activityId);
    const title = a ? a.title : "(Removed activity)";
    const status = p.syncStatus || "pending";
    const statusIcon = { synced: "✅", pending: "⏳", conflict: "⚠️" }[status];
    return `
      <li class="plan-card" data-id="${p.id}" data-status="${status}">
        <div class="plan-head">
          <div>
            <h3>${escapeHTML(title)}</h3>
            <div class="meta">
              <span>📅 ${escapeHTML(p.date || "No date")}${p.time ? " · " + escapeHTML(p.time) : ""}</span>
              <span>⏱ ${p.duration} min</span>
              <span>👥 ${p.groupSize}</span>
            </div>
            <div class="meta">
              <span>👤 ${escapeHTML(p.facilitator || "—")}</span>
              ${p.location ? `<span>📍 ${escapeHTML(p.location)}</span>` : ""}
            </div>
          </div>
          <span class="badge ${status}">${statusIcon} ${status}</span>
        </div>
        ${p.notes ? `<p class="notes">${escapeHTML(p.notes)}</p>` : ""}
        <div class="plan-actions">
          <button type="button" data-edit="${p.id}">Edit</button>
          <button type="button" data-print="${p.id}">Print</button>
          <button type="button" data-dup="${p.id}">Duplicate</button>
          <button type="button" data-sync="${p.id}">Retry sync</button>
          <button type="button" class="danger" data-del="${p.id}">Delete</button>
        </div>
      </li>
    `;
  }).join("");

  ul.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    const p = state.plans.find(x => x.id === b.dataset.edit);
    writeForm(p);
    state.editingId = p.id;
    $("#draft-pill").hidden = false;
    $("#draft-pill").textContent = "Editing";
    goToStep(2);
  }));
  ul.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this plan? This cannot be undone.")) return;
    state.plans = state.plans.filter(p => p.id !== b.dataset.del);
    await storage.set("plans", state.plans);
    renderPlans();
    toast("Plan deleted");
  }));
  ul.querySelectorAll("[data-dup]").forEach(b => b.addEventListener("click", async () => {
    const p = state.plans.find(x => x.id === b.dataset.dup);
    const copy = { ...p, id: uid(), date: "", syncStatus: "pending", updatedAt: Date.now() };
    state.plans.unshift(copy);
    await storage.set("plans", state.plans);
    renderPlans();
    toast("Plan duplicated");
  }));
  ul.querySelectorAll("[data-sync]").forEach(b => b.addEventListener("click", async () => {
    const p = state.plans.find(x => x.id === b.dataset.sync);
    if (!p) return;
    if (!navigator.onLine) return toast("Still offline — try again later");
    p.syncStatus = "synced";
    p.updatedAt = Date.now();
    await storage.set("plans", state.plans);
    renderPlans();
    toast("Synced");
  }));
  ul.querySelectorAll("[data-print]").forEach(b => b.addEventListener("click", () => {
    const p = state.plans.find(x => x.id === b.dataset.print);
    printPlan(p);
  }));
}

$("#plan-search").addEventListener("input", debounce(e => {
  state.planFilters.search = e.target.value;
  renderPlans();
}, 200));
$("#filter-status").addEventListener("change", e => {
  state.planFilters.status = e.target.value;
  renderPlans();
});

/* ---------- 7. Plan form ---------- */
function readForm() {
  return {
    id: state.editingId || undefined,
    activityId: $("#plan-activity").value,
    date: $("#plan-date").value,
    time: $("#plan-time").value,
    duration: Number($("#plan-duration").value),
    groupSize: Number($("#plan-group").value),
    facilitator: $("#plan-facilitator").value.trim(),
    location: $("#plan-location").value.trim(),
    notes: $("#plan-notes").value.trim(),
    safety: $$('input[data-check="safety"]:checked').map(c => c.value),
    inclusion: $$('input[data-check="inclusion"]:checked').map(c => c.value),
    updatedAt: Date.now(),
  };
}

function writeForm(p) {
  if (!p) return;
  $("#plan-activity").value = p.activityId || "";
  $("#plan-date").value = p.date || "";
  $("#plan-time").value = p.time || "09:00";
  $("#plan-duration").value = p.duration || 60;
  $("#plan-group").value = p.groupSize || 10;
  $("#plan-facilitator").value = p.facilitator || "";
  $("#plan-location").value = p.location || "";
  $("#plan-notes").value = p.notes || "";
  $$('input[data-check="safety"]').forEach(c => c.checked = (p.safety || []).includes(c.value));
  $$('input[data-check="inclusion"]').forEach(c => c.checked = (p.inclusion || []).includes(c.value));
  clearFieldErrors();
}

function clearFieldErrors() {
  $$(".field.invalid").forEach(f => f.classList.remove("invalid"));
  $$(".field-error").forEach(e => e.textContent = "");
}

function validateForm() {
  clearFieldErrors();
  const errors = [];
  const checks = [
    ["#plan-activity", v => !!v, "Please choose an activity"],
    ["#plan-date", v => !!v, "Please pick a date"],
    ["#plan-duration", v => v && Number(v) >= 15, "At least 15 minutes"],
    ["#plan-group", v => v && Number(v) >= 1, "At least 1 learner"],
    ["#plan-facilitator", v => v.trim().length >= 2, "Please enter your name"],
  ];
  checks.forEach(([sel, test, msg]) => {
    const input = $(sel);
    if (!test(input.value)) {
      errors.push({ sel, msg });
      const field = input.closest(".field");
      field.classList.add("invalid");
      const err = field.querySelector(".field-error");
      if (err) err.textContent = msg;
    }
  });
  return errors.length === 0;
}

$("#plan-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!validateForm()) {
    toast("Please fix the highlighted fields");
    $(".field.invalid input, .field.invalid select")?.focus();
    return;
  }

  const data = readForm();

  if (state.editingId) {
    const idx = state.plans.findIndex(p => p.id === state.editingId);
    if (idx >= 0) state.plans[idx] = { ...state.plans[idx], ...data, id: state.editingId };
  } else {
    data.id = uid();
    data.syncStatus = navigator.onLine ? "synced" : "pending";
    state.plans.unshift(data);
  }

  await storage.set("plans", state.plans);
  await storage.del("draft");

  state.editingId = null;
  $("#plan-form").reset();
  $("#plan-time").value = "09:00";
  $("#plan-duration").value = 60;
  $("#plan-group").value = 10;
  $("#draft-pill").hidden = true;
  clearFieldErrors();

  toast("Plan saved!");
  goToStep(3);
});

$("#reset-form").addEventListener("click", async () => {
  if (!confirm("Clear the form? Unsaved changes will be lost.")) return;
  $("#plan-form").reset();
  $("#plan-time").value = "09:00";
  $("#plan-duration").value = 60;
  $("#plan-group").value = 10;
  state.editingId = null;
  $("#draft-pill").hidden = true;
  clearFieldErrors();
  await storage.del("draft");
  toast("Form cleared");
});

// Autosave every 30s
setInterval(async () => {
  const hasContent = $("#plan-activity").value || $("#plan-facilitator").value.trim();
  if (!hasContent) return;
  const draft = readForm();
  await storage.set("draft", draft);
  $("#draft-pill").hidden = false;
  $("#draft-pill").textContent = "Draft saved";
  toast("Draft autosaved", 1500);
}, 30_000);

/* ---------- 8. Templates ---------- */
const TEMPLATES = {
  outreach: { duration: 30, groupSize: 25, safety: ["space", "materials"], inclusion: ["language"] },
  workshop: { duration: 120, groupSize: 20, safety: ["materials", "space", "firstaid", "supervision"], inclusion: ["language", "access", "gender", "materials_shared"] },
  club: { duration: 60, groupSize: 12, safety: ["materials", "space"], inclusion: ["access", "gender"] },
};

$$(".template-btn").forEach(btn => btn.addEventListener("click", () => {
  const t = TEMPLATES[btn.dataset.template];
  if (!t) return;
  $("#plan-duration").value = t.duration;
  $("#plan-group").value = t.groupSize;
  $$('input[data-check="safety"]').forEach(c => c.checked = t.safety.includes(c.value));
  $$('input[data-check="inclusion"]').forEach(c => c.checked = t.inclusion.includes(c.value));
  toast(`Template applied: ${btn.textContent}`);
}));

/* ---------- 9. Navigation & modal ---------- */
function goToStep(n) {
  $$(".panel").forEach(p => p.classList.remove("active"));
  $(`#step-${n}`).classList.add("active");
  $$(".step").forEach(s => {
    const stepN = Number(s.dataset.step);
    s.classList.toggle("active", stepN === n);
    s.classList.toggle("done", stepN < n);
  });
  const pct = n === 1 ? 33.33 : n === 2 ? 66.66 : 100;
  $("#progress-fill").style.width = pct + "%";
  if (n === 3) renderPlans();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$$(".step").forEach(s => s.addEventListener("click", () => goToStep(Number(s.dataset.step))));
$$("[data-goto]").forEach(b => b.addEventListener("click", () => goToStep(Number(b.dataset.goto))));

$("#new-plan-btn").addEventListener("click", () => {
  state.editingId = null;
  $("#plan-form").reset();
  $("#plan-time").value = "09:00";
  $("#plan-duration").value = 60;
  $("#plan-group").value = 10;
  $("#draft-pill").hidden = true;
  clearFieldErrors();
  goToStep(2);
});

function openActivityModal(id) {
  const a = activityById(id);
  if (!a) return;
  const body = $("#modal-body");
  body.innerHTML = `
    <span class="subject-badge" style="background:var(--sand);color:var(--primary);padding:0.2rem 0.6rem;border-radius:999px;font-size:0.7rem;text-transform:uppercase;font-weight:600;">${escapeHTML(a.subject)}</span>
    <h2 id="modal-title">${escapeHTML(a.title)}</h2>
    <div class="modal-meta">
      <span>👥 Ages ${escapeHTML(a.age)}</span>
      <span>⏱ ${a.duration} min</span>
      <span>🌐 ${a.languages.join(", ")}</span>
    </div>
    <div class="modal-section">
      <h3>Summary</h3>
      <p>${escapeHTML(a.summary)}</p>
    </div>
    <div class="modal-section">
      <h3>Materials</h3>
      <ul>${a.materials.map(m => `<li>${escapeHTML(m)}</li>`).join("")}</ul>
    </div>
    <div class="modal-section">
      <h3>🛡️ Safety</h3>
      <p>${escapeHTML(a.safety)}</p>
    </div>
    <div class="modal-section">
      <h3>🤝 Inclusion</h3>
      <p>${escapeHTML(a.inclusion)}</p>
    </div>
    <div class="modal-section">
      <h3>Learning goals</h3>
      <ul>${a.learningGoals.map(g => `<li>${escapeHTML(g)}</li>`).join("")}</ul>
    </div>
    <div class="modal-actions">
      <button type="button" class="primary" data-pick-modal="${a.id}">Plan this activity</button>
    </div>
  `;
  body.querySelector("[data-pick-modal]").addEventListener("click", () => {
    closeModal();
    pickActivity(a.id);
  });
  $("#activity-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#activity-modal").hidden = true;
  document.body.style.overflow = "";
}
$$("[data-close-modal]").forEach(el => el.addEventListener("click", closeModal));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- 10. Print ---------- */
function printPlan(p) {
  const a = activityById(p.activityId);
  const safetyLabels = {
    materials: "Materials checked", space: "Space is safe",
    firstaid: "First-aid kit present", supervision: "Adequate supervision"
  };
  const inclusionLabels = {
    language: "Language needs met", access: "Access needs met",
    gender: "Gender-balanced groups", materials_shared: "Materials shared fairly"
  };
  const root = $("#print-root");
  root.innerHTML = `
    <h1>STEMMate Namibia — Session Plan</h1>
    <div class="plan-section">
      <h2>${escapeHTML(a?.title || "Unknown activity")}</h2>
      <p><strong>Date:</strong> ${escapeHTML(p.date || "—")} ${p.time ? "at " + escapeHTML(p.time) : ""}</p>
      <p><strong>Duration:</strong> ${p.duration} minutes</p>
      <p><strong>Group:</strong> ${p.groupSize} learners</p>
      <p><strong>Facilitator:</strong> ${escapeHTML(p.facilitator || "—")}</p>
      ${p.location ? `<p><strong>Location:</strong> ${escapeHTML(p.location)}</p>` : ""}
    </div>
    ${a ? `
      <div class="plan-section">
        <h3>Materials</h3>
        <ul>${a.materials.map(m => `<li>${escapeHTML(m)}</li>`).join("")}</ul>
      </div>
      <div class="plan-section">
        <h3>Safety notes</h3>
        <p>${escapeHTML(a.safety)}</p>
      </div>
      <div class="plan-section">
        <h3>Inclusion notes</h3>
        <p>${escapeHTML(a.inclusion)}</p>
      </div>
    ` : ""}
    <div class="plan-section">
      <h3>Safety checklist</h3>
      <ul>${(p.safety || []).map(s => `<li>☑ ${safetyLabels[s] || s}</li>`).join("") || "<li>—</li>"}</ul>
    </div>
    <div class="plan-section">
      <h3>Inclusion checklist</h3>
      <ul>${(p.inclusion || []).map(s => `<li>☑ ${inclusionLabels[s] || s}</li>`).join("") || "<li>—</li>"}</ul>
    </div>
    ${p.notes ? `<div class="plan-section"><h3>Notes</h3><p>${escapeHTML(p.notes)}</p></div>` : ""}
  `;
  window.print();
}

/* ---------- 11. Network & sync ---------- */
function updateNet() {
  const online = navigator.onLine;
  const pill = $("#net-pill");
  pill.classList.toggle("online", online);
  pill.classList.toggle("offline", !online);
  $("#net-label").textContent = online ? "Online" : "Offline";
  $("#offline-banner").hidden = online;

  if (online) {
    // Auto-flip pending plans to synced when we come back online
    const pending = state.plans.filter(p => (p.syncStatus || "pending") === "pending");
    if (pending.length) {
      pending.forEach(p => { p.syncStatus = "synced"; p.updatedAt = Date.now(); });
      storage.set("plans", state.plans);
      if ($("#step-3").classList.contains("active")) renderPlans();
      toast(`Synced ${pending.length} plan${pending.length > 1 ? "s" : ""}`);
    }
  }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);

/* ---------- 12. Init ---------- */
async function init() {
  applyLang(currentLang);
  updateNet();

  state.plans = (await storage.get("plans")) || [];
  await loadActivities();

  const draft = await storage.get("draft");
  if (draft && draft.activityId) {
    writeForm(draft);
    state.editingId = draft.id || null;
    $("#draft-pill").hidden = false;
    $("#draft-pill").textContent = "Draft restored";
    toast("Restored unsaved draft", 3000);
  }

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("service-worker.js"); }
    catch (e) { console.warn("SW registration failed:", e); }
  }
}
print("Script loaded successfully.");

init();
print("Initialization complete.");