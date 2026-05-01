const CELL_COUNT = 100;
const RAM_CHIP_COUNT = 16;
const ANIM_TARGET_MS = 3500;
const ITERATIONS = 5;

// Outer paralelliği sabit (1.000), chain (ardışık await derinliği)
// preset'ten preset'e ölçeklenir. Her test 1.000 outer × chain × 5 iterasyon.
const PRESETS = [
    { key: "light",    name: "Hafif",    outer: 1000, chain:   500 },
    { key: "standard", name: "Standart", outer: 1000, chain:  5000 },
    { key: "classic",  name: "Klasik",   outer: 1000, chain: 10000, default: true },
    { key: "heavy",    name: "Yoğun",    outer: 1000, chain: 25000 },
];

let selectedPreset = PRESETS.find((p) => p.default) ?? PRESETS[0];
const trFmt = new Intl.NumberFormat("tr-TR");

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const runBtn = $("#run-btn");
const runBtnLabel = runBtn.querySelector(".run-btn-label");
const runStatus = $("#run-status");
const arena = $("#arena");
const results = $("#results");
const sourceEl = $("#source-code").querySelector("code");
const bootInfo = $("#boot-info");

const codeModal = $("#code-modal");
const showCodeBtn = $("#show-code-btn");

initGrids();
initRamModules();
initWorkloadChips();
loadSource();
showBootInfo();
setButtonState("idle");

runBtn.addEventListener("click", onRunButtonClick);
showCodeBtn.addEventListener("click", () => openCodeModal());
for (const el of codeModal.querySelectorAll("[data-modal-close]")) {
    el.addEventListener("click", closeCodeModal);
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !codeModal.hidden) closeCodeModal();
});

function onRunButtonClick() {
    const state = runBtn.dataset.state;
    if (state === "idle") {
        startRun();
    } else if (state === "done") {
        resetToIdle();
    }
}

function startRun() {
    setButtonState("running");
    arena.hidden = false;
    results.hidden = true;
    resetLane("net10");
    resetLane("net11");

    runRace().then(() => {
        setButtonState("done");
    }).catch((err) => {
        console.error(err);
        runStatus.textContent = "hata: " + (err?.message ?? err);
        runStatus.className = "error";
        setButtonState("idle");
        arena.hidden = true;
    });
}

function resetToIdle() {
    arena.hidden = true;
    results.hidden = true;
    resetLane("net10");
    resetLane("net11");
    runStatus.textContent = "hazır";
    runStatus.className = "";
    setButtonState("idle");
}

function setButtonState(state) {
    runBtn.dataset.state = state;
    if (state === "idle") {
        runBtn.disabled = false;
        setChipsDisabled(false);
        runBtnLabel.textContent = "▶  Teste Başla";
    } else if (state === "running") {
        runBtn.disabled = true;
        setChipsDisabled(true);
        runBtnLabel.textContent = "⏳  Çalışıyor…";
    } else if (state === "done") {
        runBtn.disabled = false;
        setChipsDisabled(false);
        runBtnLabel.textContent = "↻  Testi Tekrarla";
    }
}

function initWorkloadChips() {
    const root = document.querySelector("#workload-chips");
    if (!root) return;
    for (const p of PRESETS) {
        const total = p.outer * p.chain;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "workload-chip" + (p === selectedPreset ? " is-active" : "");
        btn.dataset.preset = p.key;
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", p === selectedPreset ? "true" : "false");
        btn.innerHTML =
            `<span class="workload-chip-name">${p.name}</span>` +
            `<span class="workload-chip-stats">${formatTotalShort(total)} await</span>`;
        btn.addEventListener("click", () => selectPreset(p));
        root.appendChild(btn);
    }
    syncCurrentLabels();
}

function selectPreset(p) {
    if (runBtn.dataset.state === "running") return;
    if (selectedPreset === p) return;
    selectedPreset = p;
    for (const btn of document.querySelectorAll(".workload-chip")) {
        const isActive = btn.dataset.preset === p.key;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    syncCurrentLabels();
}

function setChipsDisabled(disabled) {
    for (const btn of document.querySelectorAll(".workload-chip")) {
        btn.disabled = disabled;
    }
}

function syncCurrentLabels() {
    const total = selectedPreset.outer * selectedPreset.chain;
    setCurrent("outer", trFmt.format(selectedPreset.outer));
    setCurrent("chain", trFmt.format(selectedPreset.chain));
    setCurrent("total", trFmt.format(total));
    setCurrent(
        "summary",
        `${selectedPreset.name} · ${trFmt.format(selectedPreset.outer)} görev × ${trFmt.format(selectedPreset.chain)} await × ${ITERATIONS} iterasyon`
    );
}

function setCurrent(name, value) {
    for (const el of document.querySelectorAll(`[data-current="${name}"]`)) {
        el.textContent = value;
    }
}

function formatTotalShort(n) {
    if (n >= 1_000_000) {
        const m = n / 1_000_000;
        return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + "M";
    }
    if (n >= 1_000) {
        const k = n / 1_000;
        return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "k";
    }
    return String(n);
}

function openCodeModal() {
    codeModal.hidden = false;
    codeModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    // Önceden focus'u kaybetmemek için kapat butonuna ver
    const closeBtn = codeModal.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus({ preventScroll: true });
}

function closeCodeModal() {
    codeModal.hidden = true;
    codeModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    showCodeBtn.focus({ preventScroll: true });
}

function initGrids() {
    for (const grid of $$(".lane-grid")) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < CELL_COUNT; i++) {
            const cell = document.createElement("div");
            cell.className = "cell";
            frag.appendChild(cell);
        }
        grid.appendChild(frag);
    }
}

function initRamModules() {
    for (const container of $$("[data-ram-chips]")) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < RAM_CHIP_COUNT; i++) {
            const chip = document.createElement("span");
            chip.className = "ram-chip";
            frag.appendChild(chip);
        }
        container.appendChild(frag);
    }
}

async function loadSource() {
    try {
        const r = await fetch("/api/source");
        const text = await r.text();
        sourceEl.innerHTML = highlightCSharp(text);
    } catch {
        sourceEl.textContent = "// kod yüklenemedi";
    }
}

function showBootInfo() {
    bootInfo.textContent =
        "frontend: 2 lane × 100 görev hücresi · 16-chip DIMM · animasyon orantılı";
}

async function runRace() {
    runStatus.textContent = "bench çalışıyor… (her iki runtime sırayla)";
    runStatus.className = "running";

    const url =
        `/api/run?outer=${selectedPreset.outer}` +
        `&chain=${selectedPreset.chain}` +
        `&iterations=${ITERATIONS}`;
    const r = await fetch(url, { method: "POST" });
    if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 240)}`);
    }
    const data = await r.json();

    runStatus.textContent = "yarış başlıyor…";
    setLaneFw("net10", data.net10.frameworkDescription);
    setLaneFw("net11", data.net11.frameworkDescription);

    await raceAnimation(data);

    showResults(data);
    runStatus.textContent = "tamamlandı";
    runStatus.className = "done";
}

function setLaneFw(runtime, description) {
    const el = document.querySelector(`[data-fw="${runtime}"]`);
    if (el) el.textContent = description;
}

function resetLane(runtime) {
    for (const cell of document.querySelectorAll(`[data-grid="${runtime}"] .cell`)) {
        cell.classList.remove("lit", "pop");
    }
    for (const chip of document.querySelectorAll(`[data-ram-chips="${runtime}"] .ram-chip`)) {
        chip.classList.remove("lit", "flash");
    }
    document.querySelector(`.lane-${runtime}`)?.classList.remove("winner");
    document.querySelector(`[data-stat="${runtime}-time"]`).textContent = "—";
    document.querySelector(`[data-stat="${runtime}-gc"]`).textContent = "—";
    document.querySelector(`[data-mem-value="${runtime}"]`).textContent = "—";
}

function raceAnimation(data) {
    const t10 = data.net10.minElapsedMs;
    const t11 = data.net11.minElapsedMs;
    const slowest = Math.max(t10, t11);
    const scale = ANIM_TARGET_MS / slowest;
    const dur10 = t10 * scale;
    const dur11 = t11 * scale;

    const a10 = data.net10.minAllocatedBytes;
    const a11 = data.net11.minAllocatedBytes;
    const aMax = Math.max(a10, a11, 1);

    // Allocation oranına göre kaç chip yansın hesapla.
    // Yüksek olan = 16, ama düşük olan en az 1 chip yansın (görsel için).
    function chipsForAlloc(alloc) {
        const ratio = alloc / aMax;          // 0..1
        if (alloc === 0) return 0;
        const n = Math.round(ratio * RAM_CHIP_COUNT);
        return Math.max(1, Math.min(RAM_CHIP_COUNT, n));
    }
    const ramTarget = {
        net10: chipsForAlloc(a10),
        net11: chipsForAlloc(a11),
    };

    const start = performance.now();
    const cellsByRt = {
        net10: document.querySelectorAll(`[data-grid="net10"] .cell`),
        net11: document.querySelectorAll(`[data-grid="net11"] .cell`),
    };
    const chipsByRt = {
        net10: document.querySelectorAll(`[data-ram-chips="net10"] .ram-chip`),
        net11: document.querySelectorAll(`[data-ram-chips="net11"] .ram-chip`),
    };
    const litCells = { net10: 0, net11: 0 };
    const litChips = { net10: 0, net11: 0 };
    const liveTime = {
        net10: $(`[data-stat="net10-time"]`),
        net11: $(`[data-stat="net11-time"]`),
    };
    const liveMem = {
        net10: $(`[data-mem-value="net10"]`),
        net11: $(`[data-mem-value="net11"]`),
    };

    return new Promise((resolve) => {
        function tick(now) {
            const elapsed = now - start;
            const totalDur = Math.max(dur10, dur11);
            for (const rt of ["net10", "net11"]) {
                const dur = rt === "net10" ? dur10 : dur11;
                const realMs = rt === "net10" ? t10 : t11;
                const realAlloc = rt === "net10" ? a10 : a11;
                const progress = Math.min(1, elapsed / dur);

                const cellTarget = Math.floor(progress * CELL_COUNT);
                while (litCells[rt] < cellTarget) {
                    const idx = litCells[rt]++;
                    const cell = cellsByRt[rt][idx];
                    cell.classList.add("lit", "pop");
                    setTimeout((c) => c.classList.remove("pop"), 180, cell);
                }

                const chipTarget = Math.floor(progress * ramTarget[rt]);
                while (litChips[rt] < chipTarget) {
                    const idx = litChips[rt]++;
                    const chip = chipsByRt[rt][idx];
                    chip.classList.add("lit", "flash");
                    setTimeout((c) => c.classList.remove("flash"), 220, chip);
                }

                liveTime[rt].textContent = formatMs(realMs * progress);
                liveMem[rt].textContent = formatBytes(realAlloc * progress);
            }

            if (elapsed >= totalDur + 80) {
                for (const rt of ["net10", "net11"]) {
                    while (litCells[rt] < CELL_COUNT) {
                        cellsByRt[rt][litCells[rt]++].classList.add("lit");
                    }
                    while (litChips[rt] < ramTarget[rt]) {
                        chipsByRt[rt][litChips[rt]++].classList.add("lit");
                    }
                }
                liveTime.net10.textContent = formatMs(t10);
                liveTime.net11.textContent = formatMs(t11);
                liveMem.net10.textContent = formatBytes(a10);
                liveMem.net11.textContent = formatBytes(a11);
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    });
}

function showResults(data) {
    const t10 = data.net10.minElapsedMs;
    const t11 = data.net11.minElapsedMs;
    const a10 = data.net10.minAllocatedBytes;
    const a11 = data.net11.minAllocatedBytes;

    document.querySelector(`[data-stat="net10-gc"]`).textContent = gcSummary(data.net10);
    document.querySelector(`[data-stat="net11-gc"]`).textContent = gcSummary(data.net11);

    const winner = t11 < t10 ? "net11" : "net10";
    document.querySelector(`.lane-${winner}`).classList.add("winner");
    const winnerEl = $("#winner");
    winnerEl.textContent = winner === "net11" ? ".NET 11" : ".NET 10";
    winnerEl.className = "result-winner " + winner;

    const speedup = data.speedup;
    const allocRatio = data.allocationRatio;

    const sub = $("#winner-sub");
    if (winner === "net11") {
        const speedX = speedup.toFixed(2);
        const allocLabel = !isFinite(allocRatio) || allocRatio > 1000
            ? formatRatio(allocRatio)
            : `${allocRatio.toFixed(1)}×`;
        sub.innerHTML =
            `<strong>${speedX}×</strong> daha hızlı · ` +
            `<strong>${allocLabel}</strong> daha az heap tahsisi`;
    } else {
        const speedX = (1 / speedup).toFixed(2);
        sub.innerHTML = `<strong>${speedX}×</strong> daha hızlı (.NET 10 önde)`;
    }

    results.hidden = false;
    requestAnimationFrame(() => animateBars(t10, t11, a10, a11));
}

function animateBars(t10, t11, a10, a11) {
    const tMax = Math.max(t10, t11);
    const aMax = Math.max(a10, a11);

    setBar("net10-time", (t10 / tMax) * 100, formatMs(t10));
    setBar("net11-time", (t11 / tMax) * 100, formatMs(t11));
    setBar("net10-alloc", (a10 / aMax) * 100, formatBytes(a10));
    setBar("net11-alloc", (a11 / aMax) * 100, formatBytes(a11));
}

function setBar(key, pct, label) {
    const el = document.querySelector(`[data-bar="${key}"]`);
    if (!el) return;
    el.style.width = Math.max(8, pct) + "%";
    el.querySelector(".bar-value").textContent = label;
}

function formatMs(ms) {
    if (ms < 10) return ms.toFixed(2) + " ms";
    if (ms < 1000) return ms.toFixed(1) + " ms";
    return (ms / 1000).toFixed(2) + " s";
}

function formatBytes(b) {
    if (b < 1024) return Math.round(b) + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + " MB";
    return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function gcSummary(r) {
    return `g0:${r.totalGen0} g1:${r.totalGen1} g2:${r.totalGen2}`;
}

function formatRatio(r) {
    if (!isFinite(r)) return "∞×";
    if (r >= 1_000_000) return (r / 1_000_000).toFixed(1) + "M×";
    if (r >= 1_000) return (r / 1_000).toFixed(1) + "k×";
    return r.toFixed(0) + "×";
}

/* C# syntax highlighter — ham metin üzerinde tokenize, span içeriği escape'lenir */

const CS_KEYWORDS = new Set([
    "static", "async", "await", "return", "var", "new", "int", "long", "void",
    "for", "if", "while", "using", "public", "private", "protected", "internal",
    "class", "record", "true", "false", "null", "readonly", "const", "this",
    "ref", "out", "in", "is", "as", "throw", "try", "catch", "finally", "switch",
    "case", "default", "break", "continue", "foreach"
]);
const CS_TYPES = new Set([
    "Task", "ValueTask", "Stopwatch", "String", "Int32", "Int64",
    "MethodImpl", "MethodImplOptions"
]);

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function highlightCSharp(src) {
    return src.split("\n").map(highlightLine).join("\n");
}

function highlightLine(line) {
    let code = line, comment = "";
    const cmtIdx = line.indexOf("//");
    if (cmtIdx >= 0) {
        code = line.slice(0, cmtIdx);
        comment = line.slice(cmtIdx);
    }

    const tokenRe =
        /(\b\d[\d_]*L?\b)|("(?:\\.|[^"\\])*")|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\s+)|([{}()\[\];,.+\-*/%&|^=<>!?:])|(.)/g;

    let html = "";
    let m;
    while ((m = tokenRe.exec(code)) !== null) {
        const [, num, str, ident, space, punct, other] = m;
        if (num !== undefined) {
            html += `<span class="tok-num">${escapeHtml(num)}</span>`;
        } else if (str !== undefined) {
            html += `<span class="tok-str">${escapeHtml(str)}</span>`;
        } else if (ident !== undefined) {
            if (CS_KEYWORDS.has(ident)) {
                html += `<span class="tok-kw">${ident}</span>`;
            } else if (CS_TYPES.has(ident)) {
                html += `<span class="tok-type">${ident}</span>`;
            } else if (/^[A-Z]/.test(ident)) {
                html += `<span class="tok-method">${ident}</span>`;
            } else {
                html += ident;
            }
        } else if (space !== undefined) {
            html += space;
        } else if (punct !== undefined) {
            html += `<span class="tok-punct">${escapeHtml(punct)}</span>`;
        } else {
            html += escapeHtml(other);
        }
    }

    if (comment) {
        html += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    }
    return html;
}
