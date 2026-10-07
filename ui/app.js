/* Ettin web UI — renders the room log and live head streams. */

const PALETTE = [
  "#7c6cff",
  "#22b8cf",
  "#e64980",
  "#40c057",
  "#f59f00",
  "#e8590c",
  "#c264a6",
  "#74c0fc",
];

const heads = new Map(); // name -> {name, model, provider, color}
const live = new Map(); // name -> {el, text, tools: Map(callId -> chip)}
const targetSet = new Set();
const mention = { open: false, start: -1, items: [], index: 0 };

const transcriptEl = document.getElementById("transcript");
const headListEl = document.getElementById("head-list");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const targetsEl = document.getElementById("targets");
const connEl = document.getElementById("conn");

function esc(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function colorFor(name) {
  if (!heads.has(name)) heads.set(name, { name, color: PALETTE[heads.size % PALETTE.length] });
  return heads.get(name).color;
}

function scrollDown() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/* ---------- rendering room events ---------- */

function renderEvent(ev) {
  switch (ev.kind) {
    case "human_input": {
      const el = document.createElement("div");
      el.className = "msg human";
      el.dataset.eventId = ev.id;
      const targets = (ev.meta?.targets ?? "").split(",").filter(Boolean);
      const meta =
        heads.size > 0 && targets.length > 0 && targets.length < heads.size
          ? `<span class="badge route">→ ${targets.map(esc).join(", ")}</span>`
          : "";
      el.innerHTML =
        (meta ? `<div class="meta">${meta}</div>` : "") + `<div class="body">${esc(ev.body)}</div>`;
      transcriptEl.appendChild(el);
      break;
    }
    case "head_output": {
      clearLive(ev.author); // the final output replaces the live stream
      const color = colorFor(ev.author);
      const rec = heads.get(ev.author) ?? {};
      const el = document.createElement("div");
      el.className = "msg head";
      el.style.setProperty("--head-color", color);
      el.dataset.eventId = ev.id;
      const mode = ev.meta?.mode ? `<span class="badge mode">${esc(ev.meta.mode)}</span>` : "";
      const stop =
        ev.meta?.stopReason && ev.meta.stopReason !== "stop"
          ? `<span class="badge">⏹ ${esc(ev.meta.stopReason)}</span>`
          : "";
      const parents = (ev.parents ?? []).length
        ? `<span class="badge">↩ ${ev.parents.map(esc).join(" · ")}</span>`
        : "";
      const depth = ev.depth ? `<span class="badge">depth ${ev.depth}</span>` : "";
      el.innerHTML =
        `<div class="meta"><span class="who">${esc(ev.author)}</span>` +
        `<span>${esc(rec.model ?? "")}</span>${mode}${stop}${parents}${depth}</div>` +
        `<div class="body">${esc(ev.body)}</div>`;
      transcriptEl.appendChild(el);
      break;
    }
    case "governor": {
      const el = document.createElement("div");
      el.className = "msg governor";
      el.dataset.eventId = ev.id;
      el.textContent = `⟡ ${ev.body}`;
      transcriptEl.appendChild(el);
      break;
    }
    case "mutation": {
      const el = document.createElement("div");
      el.className = "msg mutation";
      el.dataset.eventId = ev.id;
      el.textContent = `✎ ${ev.body}`;
      transcriptEl.appendChild(el);
      break;
    }
    case "system": {
      const el = document.createElement("div");
      el.className = "msg system";
      el.dataset.eventId = ev.id;
      el.textContent = `· ${ev.body}`;
      transcriptEl.appendChild(el);
      break;
    }
    default:
      return;
  }
  scrollDown();
}

/* ---------- live head streams ---------- */

function liveEl(head) {
  colorFor(head);
  let state = live.get(head);
  if (!state) {
    const el = document.createElement("div");
    el.className = "msg head live";
    el.style.setProperty("--head-color", colorFor(head));
    const rec = heads.get(head) ?? {};
    el.innerHTML =
      `<div class="meta"><span class="who">${esc(head)}</span><span>${esc(rec.model ?? "")}</span>` +
      `<span class="badge">working…</span></div>` +
      `<div class="body typing"></div><div class="tool-chips"></div>`;
    transcriptEl.appendChild(el);
    state = { el, text: "", tools: new Map() };
    live.set(head, state);
    scrollDown();
  }
  return state;
}

function headStream(head, delta) {
  const state = liveEl(head);
  state.text += delta;
  state.el.querySelector(".body").textContent = state.text;
  scrollDown();
}

function headTool(head, callId, tool, stateName) {
  const state = liveEl(head);
  if (stateName === "start") {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.innerHTML = `<span class="spin"></span>${esc(tool)}`;
    chip.dataset.callId = callId;
    state.el.querySelector(".tool-chips").appendChild(chip);
    state.tools.set(callId, chip);
  } else {
    const chip = state.tools.get(callId);
    if (chip) {
      chip.querySelector(".spin")?.remove();
      chip.style.opacity = "0.55";
    }
  }
  scrollDown();
}

function headStatus(head, running) {
  const card = document.querySelector(`.head-card[data-head="${head}"] .head-status`);
  if (card) card.classList.toggle("running", running);
  if (!running) {
    // The turn ended; the final output arrives as a room event shortly.
    const state = live.get(head);
    if (state) state.el.querySelector(".body").classList.remove("typing");
  }
}

function clearLive(head) {
  const state = live.get(head);
  if (state) {
    state.el.remove();
    live.delete(head);
  }
}

/* ---------- roster ---------- */

function renderHeads(list) {
  headListEl.innerHTML = "";
  for (const h of list) {
    colorFor(h.name);
    heads.get(h.name).model = h.model;
    heads.get(h.name).provider = h.provider;
    const li = document.createElement("li");
    li.className = "head-card";
    li.dataset.head = h.name;
    li.style.setProperty("--head-color", heads.get(h.name).color);
    li.innerHTML =
      `<span class="head-name">${esc(h.name)}</span>` +
      `<span class="head-model">${esc(h.provider)}/${esc(h.model)}</span>` +
      `<span class="head-status"><span class="dot"></span>idle</span>`;
    headListEl.appendChild(li);
  }
  renderTargets();
}

function renderTargets() {
  targetsEl.innerHTML = "";
  if (targetSet.size === 0) {
    const chip = document.createElement("span");
    chip.className = "target-chip";
    chip.textContent = "→ all heads";
    targetsEl.appendChild(chip);
    return;
  }
  for (const name of targetSet) {
    const chip = document.createElement("span");
    chip.className = "target-chip";
    chip.style.setProperty("--head-color", colorFor(name));
    chip.textContent = `@${name}`;
    targetsEl.appendChild(chip);
  }
}

/* ---------- composer ---------- */

function parseTargets(text) {
  // Any @name in the message routes to that head — leading or mid-sentence
  // ("What does @a think?" asks a). Unknown names are ignored; the text is
  // kept verbatim either way.
  const names = [...heads.keys()];
  const targets = [];
  const re = /(?:^|[\s(])@([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
    if (name && !targets.includes(name)) targets.push(name);
  }
  return { text, targets };
}

async function send() {
  const raw = inputEl.value.trim();
  if (!raw) return;
  const { text, targets } = parseTargets(raw);
  if (!text) return;
  sendEl.disabled = true;
  closeMention();
  try {
    const res = await fetch("/api/say", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, targets }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`ettin: ${body.error ?? res.status}`);
    } else {
      inputEl.value = "";
      autoGrow();
    }
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
}

sendEl.addEventListener("click", send);
inputEl.addEventListener("input", () => {
  // Preview @target chips while typing.
  const { targets } = parseTargets(inputEl.value);
  const next = new Set(targets);
  if (next.size !== targetSet.size || ![...next].every((t) => targetSet.has(t))) {
    targetSet.clear();
    for (const t of targets) targetSet.add(t);
    renderTargets();
  }
});

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autoGrow);

/* ---------- @-mention autocomplete ---------- */

const mentionBox = document.createElement("div");
mentionBox.id = "mentions";
mentionBox.hidden = true;
document.querySelector("#composer").prepend(mentionBox);

function mentionScan() {
  // The @token the caret sits in, e.g. "@b" or a partial name after "@".
  const pos = inputEl.selectionStart ?? 0;
  const before = inputEl.value.slice(0, pos);
  const match = /(?:^|\s)@([a-zA-Z]*)$/.exec(before);
  if (!match || heads.size === 0) {
    closeMention();
    return;
  }
  const typed = match[1].toLowerCase();
  const items = [...heads.keys()].filter((n) => n.toLowerCase().startsWith(typed));
  if (items.length === 0) {
    closeMention();
    return;
  }
  mention.open = true;
  mention.start = pos - match[1].length - 1; // index of the "@"
  mention.items = items;
  mention.index = 0;
  renderMention();
}

function renderMention() {
  mentionBox.innerHTML = "";
  for (let i = 0; i < mention.items.length; i++) {
    const name = mention.items[i];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-item" + (i === mention.index ? " active" : "");
    item.style.setProperty("--head-color", colorFor(name));
    item.innerHTML =
      `<span class="mention-dot"></span>@${esc(name)}` +
      `<span class="mention-model">${esc(heads.get(name)?.model ?? "")}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus in the textarea
      pickMention(name);
    });
    mentionBox.appendChild(item);
  }
  mentionBox.hidden = false;
}

function closeMention() {
  mention.open = false;
  mention.items = [];
  mentionBox.hidden = true;
}

function pickMention(name) {
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, mention.start) + `@${name} ` + inputEl.value.slice(pos);
  closeMention();
  inputEl.focus();
  const caret = mention.start + name.length + 2;
  inputEl.setSelectionRange(caret, caret);
  renderTargets();
}

// Keyboard: arrows + Tab pick, Esc dismisses; without the popup, Enter sends.
inputEl.addEventListener("keydown", (e) => {
  if (mention.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mention.index = (mention.index + 1) % mention.items.length;
      renderMention();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mention.index = (mention.index - 1 + mention.items.length) % mention.items.length;
      renderMention();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && mention.items.length === 1)) {
      e.preventDefault();
      pickMention(mention.items[mention.index]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("keyup", (e) => {
  if (["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab"].includes(e.key)) return;
  mentionScan();
});
inputEl.addEventListener("click", mentionScan);
document.addEventListener("click", (e) => {
  if (!mentionBox.contains(e.target) && e.target !== inputEl) closeMention();
});

/* ---------- approvals ---------- */

const approvalsEl = document.getElementById("approvals");
const approvalListEl = document.getElementById("approval-list");
const approvalModeEl = document.getElementById("approval-mode");

function renderApprovals(approvals) {
  if (!approvals) return;
  approvalModeEl.checked = approvals.mode === "writes";
  const pending = (approvals.requests ?? []).filter((r) => r.state === "pending");
  approvalsEl.hidden = !approvalModeEl.checked && pending.length === 0;
  approvalListEl.innerHTML = "";
  for (const r of pending) {
    const li = document.createElement("li");
    li.className = "approval-item";
    li.style.setProperty("--head-color", colorFor(r.head));
    li.innerHTML =
      `<span class="approval-who">${esc(r.head)}</span>` +
      `<span class="approval-what">${esc(r.tool)} → ${esc(r.path || "(no path)")}</span>` +
      `<button class="allow" data-id="${esc(r.id)}">allow</button>` +
      `<button class="deny" data-id="${esc(r.id)}">deny</button>`;
    approvalListEl.appendChild(li);
  }
}

async function loadApprovals() {
  try {
    const res = await fetch("/api/approvals");
    const body = await res.json();
    renderApprovals(body.approvals);
  } catch {
    /* approvals endpoint unavailable */
  }
}

document.getElementById("approval-mode").addEventListener("change", async (e) => {
  const mode = e.target.checked ? "writes" : "off";
  await fetch("/api/approvals/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
});

approvalListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const decision = btn.classList.contains("allow") ? "allow" : "deny";
  btn.disabled = true;
  await fetch("/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: btn.dataset.id, decision }),
  });
});

/* ---------- SSE ---------- */

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("message", (e) => {
    const data = JSON.parse(e.data);
    switch (data.type) {
      case "hello":
        connEl.textContent = "connected";
        connEl.className = "conn conn-on";
        break;
      case "room_event":
        renderEvent(data.event);
        break;
      case "head_stream":
        headStream(data.head, data.delta);
        break;
      case "head_tool":
        headTool(data.head, data.callId, data.tool, data.state);
        break;
      case "head_status":
        headStatus(data.head, data.running);
        break;
      case "approval_update":
        renderApprovals(data.approvals);
        break;
    }
  });
  es.addEventListener("error", () => {
    connEl.textContent = "reconnecting…";
    connEl.className = "conn conn-off";
    es.close();
    setTimeout(connect, 1500);
  });
}

/* ---------- add head ---------- */

async function populateModels() {
  try {
    const res = await fetch("/api/models");
    const body = await res.json();
    const select = document.getElementById("new-head-model");
    select.innerHTML = "";
    for (const m of body.models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}/${m.modelId}`;
      opt.textContent = `${m.modelId}`;
      select.appendChild(opt);
    }
  } catch {
    /* models endpoint unavailable; leave the selector empty */
  }
}

function renderHeadCard(h) {
  colorFor(h.name);
  const rec = heads.get(h.name);
  rec.model = h.model;
  rec.provider = h.provider;
  const li = document.createElement("li");
  li.className = "head-card";
  li.dataset.head = h.name;
  li.style.setProperty("--head-color", rec.color);
  li.innerHTML =
    `<span class="head-name">${esc(h.name)}</span>` +
    `<span class="head-model">${esc(h.provider)}/${esc(h.model)}</span>` +
    `<span class="head-status"><span class="dot"></span>idle</span>`;
  headListEl.appendChild(li);
  renderTargets();
}

document.getElementById("add-head").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById("new-head-name");
  const modelEl = document.getElementById("new-head-model");
  const name = nameEl.value.trim().toLowerCase();
  if (!name) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/heads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, model: modelEl.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      alert(`ettin: ${body.error ?? res.status}`);
      return;
    }
    renderHeadCard(body.head);
    nameEl.value = "";
  } finally {
    btn.disabled = false;
  }
});

/* ---------- boot ---------- */

async function boot() {
  const res = await fetch("/api/state");
  const state = await res.json();
  renderHeads(state.heads);
  document.getElementById("workspace").textContent = state.workspace;
  const models = await (await fetch("/api/models")).json();
  document.getElementById("model-source").textContent =
    `${models.kind}: ${models.models.map((m) => m.modelId).join(", ")}`;
  await populateModels();
  for (const ev of state.events) renderEvent(ev);
  if (!state.events.length) {
    transcriptEl.innerHTML =
      `<div class="empty-room"><div class="glyph">etra·etta</div>` +
      `<p>The room is open. Say something — every head hears you.</p></div>`;
  }
  await loadApprovals();
  connect();
}

boot();
