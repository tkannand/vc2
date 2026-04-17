/* ── Bulk Delivery Wizard ────────────────────────────────────────────────── */

const API = "";

const state = {
    batchId: null,
    epicCount: 0,
    schemes: [],
    selectedScheme: null,
    greenCount: 0,
    redCount: 0,
    yellowCount: 0,
    redData: [],
    yellowData: [],
    reportFile: null,
    currentStep: 1,
    file: null,
};

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
    stepper:         $("#stepper"),
    operatorName:    $("#operatorName"),
    dropZone:        $("#dropZone"),
    fileInput:       $("#fileInput"),
    fileInfo:        $("#fileInfo"),
    fileName:        $("#fileName"),
    removeFile:      $("#removeFile"),
    btnUpload:       $("#btnUpload"),
    uploadSummary:   $("#uploadSummary"),
    schemeGrid:      $("#schemeGrid"),
    diagLoading:     $("#diagLoading"),
    diagResults:     $("#diagResults"),
    diagStats:       $("#diagStats"),
    diagTableContainer: $("#diagTableContainer"),
    diagTabs:        $("#diagTabs"),
    diagTableTitle:  $("#diagTableTitle"),
    diagTableHead:   $("#diagTableHead"),
    diagTableBody:   $("#diagTableBody"),
    btnBackScheme:   $("#btnBackScheme"),
    btnConfirmProcess: $("#btnConfirmProcess"),
    processSubtext:  $("#processSubtext"),
    progressBar:     $("#progressBar"),
    progressCount:   $("#progressCount"),
    progressPercent: $("#progressPercent"),
    statSuccess:     $("#statSuccess"),
    statFailed:      $("#statFailed"),
    statAttempt:     $("#statAttempt"),
    retryBanner:     $("#retryBanner"),
    retryText:       $("#retryText"),
    completeIcon:    $("#completeIcon"),
    completeTitle:   $("#completeTitle"),
    completeSubtext: $("#completeSubtext"),
    finalStats:      $("#finalStats"),
    btnStartOver:    $("#btnStartOver"),
};


/* ── Step navigation ────────────────────────────────────────────────────── */
function goToStep(step) {
    state.currentStep = step;

    // Update stepper
    $$(".step").forEach((el) => {
        const s = parseInt(el.dataset.step);
        el.classList.remove("active", "done");
        if (s === step) el.classList.add("active");
        else if (s < step) el.classList.add("done");
    });

    // Show/hide panels
    const panels = ["step-upload", "step-scheme", "step-diagnostics", "step-process", "step-complete"];
    const panelIds = [1, 2, 3, 4, 5];
    panels.forEach((id, i) => {
        const panel = $(`#${id}`);
        if (panelIds[i] === step) {
            panel.classList.remove("hidden");
            panel.style.animation = "none";
            void panel.offsetHeight;
            panel.style.animation = "";
        } else {
            panel.classList.add("hidden");
        }
    });
}


/* ── Step 1: Upload ─────────────────────────────────────────────────────── */

function updateUploadButton() {
    const hasName = els.operatorName.value.trim().length > 0;
    const hasFile = state.file !== null;
    els.btnUpload.disabled = !(hasName && hasFile);
}

els.operatorName.addEventListener("input", updateUploadButton);

// Drag & drop
els.dropZone.addEventListener("click", () => els.fileInput.click());

els.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropZone.classList.add("drag-over");
});

els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("drag-over");
});

els.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) selectFile(file);
});

els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files[0]) selectFile(els.fileInput.files[0]);
});

function selectFile(file) {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".xlsx") && !name.endsWith(".xls")) {
        alert("Only Excel files (.xlsx) are supported");
        return;
    }
    state.file = file;
    els.fileName.textContent = file.name;
    els.fileInfo.classList.remove("hidden");
    els.dropZone.classList.add("hidden");
    updateUploadButton();
}

els.removeFile.addEventListener("click", () => {
    state.file = null;
    els.fileInput.value = "";
    els.fileInfo.classList.add("hidden");
    els.dropZone.classList.remove("hidden");
    updateUploadButton();
});

els.btnUpload.addEventListener("click", async () => {
    if (!state.file || !els.operatorName.value.trim()) return;

    els.btnUpload.disabled = true;
    els.btnUpload.innerHTML = `<span class="btn-spinner"></span> Uploading...`;

    try {
        const formData = new FormData();
        formData.append("file", state.file);
        formData.append("operator_name", els.operatorName.value.trim());

        const res = await fetch(`${API}/api/upload`, { method: "POST", body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: "Upload failed" }));
            throw new Error(err.detail || "Upload failed");
        }

        const data = await res.json();
        state.batchId = data.batch_id;
        state.epicCount = data.epic_count;

        console.log("upload_success", { batch_id: data.batch_id, epic_count: data.epic_count });

        // Load schemes and move to step 2
        await loadSchemes();
        goToStep(2);
    } catch (err) {
        console.error("upload_error", err);
        alert(`Upload failed: ${err.message}`);
    } finally {
        els.btnUpload.disabled = false;
        els.btnUpload.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <polyline points="16 16 12 12 8 16"></polyline>
                <line x1="12" y1="12" x2="12" y2="21"></line>
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"></path>
            </svg>
            Upload & Parse`;
        updateUploadButton();
    }
});


/* ── Step 2: Select Scheme ──────────────────────────────────────────────── */

async function loadSchemes() {
    const res = await fetch(`${API}/api/schemes`);
    if (!res.ok) throw new Error("Failed to load schemes");
    const data = await res.json();
    state.schemes = data.schemes;

    // Render summary
    els.uploadSummary.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <strong>${state.epicCount}</strong> EPIC numbers loaded from <strong>${state.file.name}</strong>
    `;

    // Render scheme cards
    els.schemeGrid.innerHTML = state.schemes.map((s) => `
        <div class="scheme-card" data-scheme-id="${s.id}" data-scheme-name="${s.name}" data-scheme-type="${s.type}">
            <div class="scheme-card-name">${s.name}</div>
            <div class="scheme-card-type">${s.type}</div>
        </div>
    `).join("");

    // Attach click handlers
    $$(".scheme-card").forEach((card) => {
        card.addEventListener("click", () => {
            const schemeId = card.dataset.schemeId;
            const schemeName = card.dataset.schemeName;
            const schemeType = card.dataset.schemeType;

            state.selectedScheme = { id: schemeId, name: schemeName, type: schemeType };
            console.log("scheme_selected", state.selectedScheme);

            goToStep(3);
            runDiagnostics();
        });
    });
}


/* ── Step 3: Diagnostics ────────────────────────────────────────────────── */

async function runDiagnostics() {
    els.diagLoading.classList.remove("hidden");
    els.diagResults.classList.add("hidden");

    try {
        // Determine scheme_type for the API
        let schemeType;
        if (state.selectedScheme.id === "notice") schemeType = "notice";
        else if (state.selectedScheme.id === "coupon") schemeType = "coupon";
        else schemeType = "custom";

        const res = await fetch(`${API}/api/diagnose`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                batch_id: state.batchId,
                scheme_id: state.selectedScheme.id,
                scheme_name: state.selectedScheme.name,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: "Diagnostics failed" }));
            throw new Error(err.detail || "Diagnostics failed");
        }

        const data = await res.json();
        state.greenCount = data.green_count;
        state.redCount = data.red_count;
        state.yellowCount = data.yellow_count;
        state.redData = data.red || [];
        state.yellowData = data.yellow || [];
        state.reportFile = data.report_file;

        console.log("diagnostics_complete", {
            green: data.green_count,
            red: data.red_count,
            yellow: data.yellow_count,
        });

        renderDiagnostics();

        // Auto-download report if there are red or yellow EPICs
        if (state.reportFile) {
            triggerDownload(`${API}/api/download/${state.reportFile}`, state.reportFile);
        }

    } catch (err) {
        console.error("diagnostics_error", err);
        alert(`Diagnostics failed: ${err.message}`);
        goToStep(2);
    }
}

function renderDiagnostics() {
    els.diagLoading.classList.add("hidden");
    els.diagResults.classList.remove("hidden");

    // Stats cards
    els.diagStats.innerHTML = `
        <div class="stat-card stat-green">
            <div class="stat-count">${state.greenCount}</div>
            <div class="stat-label">Ready to Deliver</div>
        </div>
        <div class="stat-card stat-red">
            <div class="stat-count">${state.redCount}</div>
            <div class="stat-label">Already Delivered</div>
        </div>
        <div class="stat-card stat-yellow">
            <div class="stat-count">${state.yellowCount}</div>
            <div class="stat-label">Not Found</div>
        </div>
    `;

    // Table
    if (state.redCount > 0 || state.yellowCount > 0) {
        els.diagTableContainer.classList.remove("hidden");

        // Build tabs
        const tabs = [];
        if (state.redCount > 0) tabs.push({ key: "red", label: `Already Delivered (${state.redCount})` });
        if (state.yellowCount > 0) tabs.push({ key: "yellow", label: `Not Found (${state.yellowCount})` });

        els.diagTabs.innerHTML = tabs.map((t, i) =>
            `<button class="tab-btn ${i === 0 ? "active" : ""}" data-tab="${t.key}">${t.label}</button>`
        ).join("");

        // Tab click handlers
        $$(".tab-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                $$(".tab-btn").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                renderDiagTable(btn.dataset.tab);
            });
        });

        renderDiagTable(tabs[0].key);
    } else {
        els.diagTableContainer.classList.add("hidden");
    }

    // Enable confirm button only if there are green voters
    els.btnConfirmProcess.disabled = state.greenCount === 0;
    if (state.greenCount > 0) {
        els.btnConfirmProcess.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Confirm & Deliver ${state.greenCount} Voters`;
    }
}

function renderDiagTable(tab) {
    if (tab === "red") {
        els.diagTableTitle.textContent = "Already Delivered";
        els.diagTableHead.innerHTML = `
            <tr>
                <th>EPIC</th><th>Name</th><th>Ward</th><th>Booth</th><th>SL No</th><th>Delivered By</th><th>When</th>
            </tr>`;
        els.diagTableBody.innerHTML = state.redData.map((r) => `
            <tr>
                <td>${esc(r.voter_id)}</td>
                <td>${esc(r.name)}</td>
                <td>${esc(r.ward)}</td>
                <td>${esc(r.booth)}</td>
                <td>${esc(r.sl)}</td>
                <td>${esc(r.delivered_by_name)}</td>
                <td>${formatDate(r.delivered_at)}</td>
            </tr>
        `).join("");
    } else {
        els.diagTableTitle.textContent = "Not Found in Database";
        els.diagTableHead.innerHTML = `<tr><th>EPIC</th></tr>`;
        els.diagTableBody.innerHTML = state.yellowData.map((y) =>
            `<tr><td>${esc(y.voter_id)}</td></tr>`
        ).join("");
    }
}


/* ── Step 3 actions ─────────────────────────────────────────────────────── */

els.btnBackScheme.addEventListener("click", () => goToStep(2));

els.btnConfirmProcess.addEventListener("click", () => {
    if (state.greenCount === 0) return;

    const ok = confirm(
        `You are about to mark ${state.greenCount} voters as delivered for "${state.selectedScheme.name}".\n\n` +
        `This action cannot be undone. Continue?`
    );
    if (!ok) return;

    goToStep(4);
    startProcessing();
});


/* ── Step 4: Processing ─────────────────────────────────────────────────── */

function startProcessing() {
    els.processSubtext.textContent = `Marking ${state.greenCount} voters as delivered for "${state.selectedScheme.name}"`;
    els.progressBar.style.width = "0%";
    els.progressCount.textContent = `0 / ${state.greenCount}`;
    els.progressPercent.textContent = "0%";
    els.statSuccess.textContent = "0";
    els.statFailed.textContent = "0";
    els.statAttempt.textContent = "1";
    els.retryBanner.classList.add("hidden");

    const evtSource = new EventSource(`${API}/api/process?batch_id=${state.batchId}`);

    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("sse_event", data);

        switch (data.type) {
            case "progress":
                updateProgress(data);
                break;
            case "batch_start":
                els.processSubtext.textContent =
                    `Batch ${data.batch_num}/${data.batch_total} (attempt ${data.attempt})`;
                break;
            case "retry_wait":
                els.retryBanner.classList.remove("hidden");
                els.retryText.textContent =
                    `Retrying ${data.remaining} failed items - waiting ${data.countdown}s (attempt ${data.attempt}/${5})`;
                els.statAttempt.textContent = data.attempt;
                break;
            case "complete":
                evtSource.close();
                els.retryBanner.classList.add("hidden");
                showComplete(data);
                break;
        }
    };

    evtSource.onerror = (err) => {
        console.error("sse_error", err);
        evtSource.close();
        alert("Connection lost during processing. Check the server logs for status.");
    };
}

function updateProgress(data) {
    const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
    els.progressBar.style.width = `${pct}%`;
    els.progressCount.textContent = `${data.processed} / ${data.total}`;
    els.progressPercent.textContent = `${pct}%`;
    els.statSuccess.textContent = data.success;
    els.statFailed.textContent = data.failed;
    if (data.attempt) els.statAttempt.textContent = data.attempt;

    // Hide retry banner when processing resumes
    if (data.type === "progress") {
        els.retryBanner.classList.add("hidden");
    }
}


/* ── Step 5: Complete ───────────────────────────────────────────────────── */

function showComplete(data) {
    goToStep(5);

    const allOk = data.failed === 0;
    els.completeIcon.className = `complete-icon ${allOk ? "success" : "partial"}`;
    els.completeTitle.textContent = allOk ? "All Deliveries Marked" : "Processing Complete";
    els.completeSubtext.textContent = allOk
        ? `All ${data.success} voters have been marked as delivered.`
        : `${data.success} delivered, ${data.failed} failed after all retries.`;

    els.finalStats.innerHTML = `
        <div class="final-stat">
            <div class="final-stat-num" style="color: var(--text-primary)">${data.total}</div>
            <div class="final-stat-label">Total</div>
        </div>
        <div class="final-stat">
            <div class="final-stat-num" style="color: var(--green)">${data.success}</div>
            <div class="final-stat-label">Delivered</div>
        </div>
        <div class="final-stat">
            <div class="final-stat-num" style="color: var(--red)">${data.failed}</div>
            <div class="final-stat-label">Failed</div>
        </div>
    `;

    // Auto-download failure report if any failures
    if (data.failure_report) {
        triggerDownload(`${API}/api/download/${data.failure_report}`, data.failure_report);
    }
}

els.btnStartOver.addEventListener("click", () => {
    // Reset state
    state.batchId = null;
    state.epicCount = 0;
    state.schemes = [];
    state.selectedScheme = null;
    state.greenCount = 0;
    state.redCount = 0;
    state.yellowCount = 0;
    state.redData = [];
    state.yellowData = [];
    state.reportFile = null;
    state.file = null;

    // Reset UI
    els.operatorName.value = "";
    els.fileInput.value = "";
    els.fileInfo.classList.add("hidden");
    els.dropZone.classList.remove("hidden");
    els.btnUpload.disabled = true;

    goToStep(1);
});


/* ── Helpers ────────────────────────────────────────────────────────────── */

function esc(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(isoStr) {
    if (!isoStr) return "";
    try {
        const d = new Date(isoStr);
        return d.toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return isoStr;
    }
}

function triggerDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "report.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}


/* ── Init ───────────────────────────────────────────────────────────────── */
goToStep(1);
console.log("bulk_deliver_app_loaded");
