const Notice = {
    noticeEnabled: false,
    currentStreet: "",

    // Ward drill-down state
    wardDrillBooth: "",
    wardDrillStreet: "",

    // Admin notice stats filter state
    adminNoticeWardsCache: [],

    // Confirm modal helper - returns a Promise<boolean>
    // Optional messageKey overrides the default "confirm_undeliver" text
    confirmUndeliver(messageKey) {
        return new Promise((resolve) => {
            const modal = document.getElementById("modal-confirm-undeliver");
            const msgEl = document.getElementById("confirm-undeliver-msg");
            const titleEl = document.getElementById("confirm-undeliver-title");
            const btnCancel = document.getElementById("btn-confirm-undeliver-cancel");
            const btnOk = document.getElementById("btn-confirm-undeliver-ok");

            // Apply translations
            titleEl.textContent = I18n.t("confirm");
            msgEl.textContent = I18n.t(messageKey || "confirm_undeliver");
            btnCancel.textContent = I18n.t("cancel");
            btnOk.textContent = I18n.t("confirm");

            modal.style.display = "flex";

            const cleanup = () => {
                modal.style.display = "none";
                btnCancel.removeEventListener("click", onCancel);
                btnOk.removeEventListener("click", onConfirm);
                overlay.removeEventListener("click", onCancel);
            };

            const overlay = modal.querySelector(".modal-overlay");

            const onCancel = () => { cleanup(); resolve(false); };
            const onConfirm = () => { cleanup(); resolve(true); };

            btnCancel.addEventListener("click", onCancel);
            btnOk.addEventListener("click", onConfirm);
            overlay.addEventListener("click", onCancel);
        });
    },
    adminNoticeBoothsCache: {},

    formatBoothLabel(boothName, boothNumber, maxLen, boothNameTamil) {
        const isTamil = I18n.currentLang === "ta";
        const name = (isTamil && boothNameTamil) ? boothNameTamil : (boothName || "");
        if (!boothNumber && !name) return "";
        if (!boothNumber) return name;
        if (!name) return boothNumber;
        const shortName = maxLen && name.length > maxLen ? name.substring(0, maxLen) + "..." : name;
        return `${boothNumber} - ${shortName}`;
    },

    async checkEnabled() {
        const res = await API.getNoticeEnabled();
        this.noticeEnabled = res.enabled === true;
        return this.noticeEnabled;
    },

    // ========== BOOTH WORKER: Notice Tab ==========

    boothNoticeFamilies: [],
    boothNoticeFamiliesAll: [],
    boothNoticePage: 0,

    async initBooth() {
        const user = App.getUser();
        if (!user) return;
        this.boothNoticeFamilies = [];
        this.boothNoticeFamiliesAll = [];
        this.boothNoticePage = 0;
        this._bindBoothNoticeNav();
        this._bindBoothNoticeFilters();
        await this._loadBoothAllVoters();
    },

    async _loadBoothAllVoters() {
        const user = App.getUser();
        App.showViewLoading("view-booth-notice");
        const res = await API.getNoticeVoters(user.ward, user.booth, "");
        App.hideViewLoading("view-booth-notice");
        if (res.error) { App.showToast(res.detail || "Failed to load"); return; }

        const families = [...(res.families || [])];
        (res.ungrouped || []).forEach((m) => families.push({
            famcode: m.voter_id, members: [m],
            house: m.house, section: m.section,
            head_name: m.name, head_name_ta: m.name_ta || "",
            booth: user.booth,
        }));
        this.boothNoticeFamiliesAll = families;

        // Populate street filter
        const streetSel = document.getElementById("booth-notice-street-filter");
        const streets = [...new Set(families.flatMap(f => f.members.map(m => m.section).filter(Boolean)))].sort();
        streetSel.innerHTML = `<option value="">All Streets</option>`;
        streets.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; streetSel.appendChild(o); });

        this._updateBoothNoticeSummary(res.delivered, res.total);
        this._applyBoothNoticeFilters();
    },

    _updateBoothNoticeSummary(delivered, total) {
        const bar = document.getElementById("notice-summary-bar");
        if (!bar) return;
        bar.innerHTML = `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} ${I18n.t("delivered")}</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} ${I18n.t("total")}</span>
            <span class="notice-summary-pct">${total > 0 ? Math.round(delivered / total * 100) : 0}%</span>
        </div>`;
    },

    _applyBoothNoticeFilters(keepPage = false) {
        const search = (document.getElementById("booth-notice-search")?.value || "").toLowerCase().trim();
        const street = document.getElementById("booth-notice-street-filter")?.value || "";

        let filtered = this.boothNoticeFamiliesAll;
        if (street) filtered = filtered.filter(f => f.members.some(m => m.section === street));
        if (search) {
            filtered = filtered.filter(f => f.members.some(m =>
                (m.sl || "").toLowerCase().includes(search) ||
                (m.voter_id || "").toLowerCase().includes(search) ||
                (m.name || "").toLowerCase().includes(search) ||
                (m.name_en || "").toLowerCase().includes(search) ||
                (m.name_ta || "").includes(search) ||
                (m.section || "").toLowerCase().includes(search)
            ));
            filtered.sort((a, b) => {
                const slMatch = f => f.members.some(m =>
                    (m.sl || "").toLowerCase().startsWith(search) ||
                    (m.voter_id || "").toLowerCase().startsWith(search));
                return slMatch(b) - slMatch(a);
            });
        }
        this.boothNoticeFamilies = filtered;
        if (!keepPage) this.boothNoticePage = 0;
        this._renderBoothNoticeFamily();
        this._refreshBoothNoticeSummary();
    },

    _bindBoothNoticeFilters() {
        const clone = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const search = clone("booth-notice-search");
        const street = clone("booth-notice-street-filter");
        if (search) search.addEventListener("input", () => this._applyBoothNoticeFilters());
        if (street) street.addEventListener("change", () => this._applyBoothNoticeFilters());
    },

    _bindBoothNoticeNav() {
        const prev = document.getElementById("btn-bn-prev");
        const next = document.getElementById("btn-bn-next");
        const pages = () => Math.ceil(this.boothNoticeFamilies.length / this.WARD_NOTICE_PAGE_SIZE);
        if (prev) prev.addEventListener("click", () => {
            if (this.boothNoticePage > 0) { this.boothNoticePage--; this._renderBoothNoticeFamily(); document.getElementById("main-content").scrollTop = 0; }
        });
        if (next) next.addEventListener("click", () => {
            if (this.boothNoticePage < pages() - 1) { this.boothNoticePage++; this._renderBoothNoticeFamily(); document.getElementById("main-content").scrollTop = 0; }
        });
    },

    _renderBoothNoticeFamily() {
        const area    = document.getElementById("booth-notice-family-area");
        const nav     = document.getElementById("booth-notice-nav");
        const empty   = document.getElementById("notice-empty-state");
        const counter = document.getElementById("booth-notice-counter");
        const prev    = document.getElementById("btn-bn-prev");
        const next    = document.getElementById("btn-bn-next");

        if (!this.boothNoticeFamilies.length) {
            area.innerHTML = ""; nav.style.display = "none"; empty.style.display = "block"; return;
        }
        empty.style.display = "none";

        const ps    = this.WARD_NOTICE_PAGE_SIZE;
        const total = this.boothNoticeFamilies.length;
        const pages = Math.ceil(total / ps);
        const pg    = Math.min(this.boothNoticePage, pages - 1);
        this.boothNoticePage = pg;

        counter.textContent = `Page ${pg + 1} ${I18n.t("of")} ${pages} (${total} ${I18n.t("families") || "families"})`;
        prev.disabled = pg === 0;
        next.disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";

        const q = (document.getElementById("booth-notice-search")?.value || "").trim();
        const slice = this.boothNoticeFamilies.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this.buildWardNoticeCard(fam, q)).join("");
        this._bindBoothNoticeCardActions(area);
    },

    _bindBoothNoticeCardActions(area) {
        // Expand/collapse member details on row tap
        area.querySelectorAll(".ncc-member-summary").forEach((row) => {
            row.addEventListener("click", (e) => {
                if (e.target.closest(".ncc-toggle")) return;
                const details = row.nextElementSibling;
                if (details && details.classList.contains("ncc-details")) {
                    details.classList.toggle("ncc-details-open");
                }
            });
        });

        area.querySelectorAll(".notice-toggle input").forEach(cb => {
            cb.addEventListener("change", async () => {
                const vid = cb.dataset.voterId;
                const action = cb.checked ? "deliver" : "undeliver";
                if (action === "undeliver") {
                    cb.checked = true; // revert while confirming
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    cb.checked = false;
                }
                cb.disabled = true;
                await this._boothToggleNotice([vid], action);
            });
        });
        area.querySelectorAll(".notice-deliver-all").forEach(btn => {
            btn.addEventListener("click", async () => {
                const fam = this.boothNoticeFamiliesAll.find(f => f.famcode === btn.dataset.famcode);
                if (!fam) return;
                const allDelivered = fam.members.every(m => m.status === "delivered");
                if (allDelivered) {
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    btn.disabled = true;
                    await this._boothToggleNotice(fam.members.map(m => m.voter_id), "undeliver");
                } else {
                    btn.disabled = true;
                    await this._boothToggleNotice(fam.members.filter(m => m.status !== "delivered").map(m => m.voter_id), "deliver");
                }
            });
        });
    },

    async _boothToggleNotice(voterIds, action) {
        const user = App.getUser();
        const newStatus = action === "deliver" ? "delivered" : "not_delivered";
        const idSet = new Set(voterIds);
        const me = App.getUser();
        const myName = me?.name || "";
        const myTime = new Date().toISOString();

        const res = await (action === "deliver"
            ? API.deliverNotice(user.ward, user.booth, voterIds)
            : API.undeliverNotice(user.ward, user.booth, voterIds));

        if (res && res.error) {
            console.log("[booth toggle] error:", res.detail, "| action:", action, "| voters:", voterIds);
            if (res.detail === "Network error") {
                console.log("[booth toggle] offline — queuing and flipping UI");
                NoticeQueue.add({ type: "booth", ward: user.ward, booth: user.booth,
                    voterIds, action, myName, myPhone: me?.phone || "", myTime });
                this.boothNoticeFamiliesAll.forEach(fam => fam.members.forEach(m => {
                    if (idSet.has(m.voter_id)) {
                        m.status = newStatus; m._pending = true;
                        if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                        else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
                    }
                }));
                console.log("[booth toggle] boothNoticeFamiliesAll updated, re-rendering...");
                this._applyBoothNoticeFilters(true);
                this._refreshBoothNoticeSummary();
                App.showToast("No internet — will sync when connected");
            } else {
                this._applyBoothNoticeFilters(true);
                App.showToast(res.detail || "Failed to update");
            }
            return;
        }

        this.boothNoticeFamiliesAll.forEach(fam => {
            fam.members.forEach(m => {
                if (idSet.has(m.voter_id)) {
                    m.status = newStatus; m._pending = false;
                    if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                    else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
                }
            });
        });
        this._applyBoothNoticeFilters(true);
        this._refreshBoothNoticeSummary();
    },

    _refreshBoothNoticeSummary() {
        const all = this.boothNoticeFamilies.flatMap(f => f.members);
        this._updateBoothNoticeSummary(all.filter(m => m.status === "delivered").length, all.length);
    },

    async boothToggleNotice(voterIds, action) { await this._boothToggleNotice(voterIds, action); },

    // ========== BOOTH WORKER: Notice Stats Tab ==========

    async loadBoothNoticeStats() {
        const user = App.getUser();
        App.showViewLoading("view-booth-notice-stats");
        const res = await API.getNoticeStats(user.ward, user.booth);
        App.hideViewLoading("view-booth-notice-stats");

        if (res.error) return;

        const cards = document.getElementById("booth-notice-stats-cards");
        cards.innerHTML = `
            <div class="stat-card accent">
                <div class="stat-value">${res.total}</div>
                <div class="stat-label">${I18n.t("total")}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-value">${res.delivered}</div>
                <div class="stat-label">${I18n.t("delivered")}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-value">${res.pending}</div>
                <div class="stat-label">${I18n.t("pending")}</div>
            </div>
            <div class="stat-card wide">
                <div class="stat-value">${res.completion_pct}%</div>
                <div class="stat-label">${I18n.t("completion")}</div>
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width:${res.completion_pct}%;background:var(--success)"></div>
                </div>
            </div>
        `;

        const streetList = document.getElementById("booth-notice-street-stats");
        if (res.sections && res.sections.length > 0) {
            streetList.innerHTML = res.sections.map((s) => `
                <div class="street-stat-row">
                    <div class="stat-row-top">
                        <span class="stat-row-name">${s.section}</span>
                        <span class="stat-row-pct">${s.pct}%</span>
                    </div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width:${s.pct}%;background:var(--success)"></div>
                    </div>
                    <div class="stat-row-nums">
                        <span>${I18n.t("delivered")}: ${s.delivered}</span>
                        <span>${I18n.t("pending")}: ${s.pending}</span>
                        <span>${I18n.t("total")}: ${s.total}</span>
                    </div>
                </div>
            `).join("");
        } else {
            streetList.innerHTML = `<div class="empty-state"><p>${I18n.t("no_data")}</p></div>`;
        }

        // Coupon summary
        const couponRes = await API.getCouponBoothStats(user.ward, user.booth);
        if (!couponRes.error) this._appendCouponSummary("booth-notice-stats-coupon", couponRes);
    },

    _appendCouponSummary(containerId, res) {
        let container = document.getElementById(containerId);
        if (!container) {
            container = document.createElement("div");
            container.id = containerId;
            document.getElementById("view-booth-notice-stats")?.querySelector(".view-content")?.appendChild(container) ||
            document.getElementById("view-ward-notice-stats")?.querySelector(".view-content")?.appendChild(container) ||
            document.getElementById("view-admin-notice-stats")?.querySelector(".view-content")?.appendChild(container);
        }
        if (!container) return;
        container.innerHTML = `
            <h3 class="section-title" style="margin-top:20px;">Coupon Distribution</h3>
            <div class="stats-grid">
                <div class="stat-card accent"><div class="stat-value">${res.grand_total ?? res.total}</div><div class="stat-label">Total</div></div>
                <div class="stat-card success"><div class="stat-value">${res.grand_delivered ?? res.delivered}</div><div class="stat-label">Delivered</div></div>
                <div class="stat-card warning"><div class="stat-value">${res.grand_pending ?? res.pending}</div><div class="stat-label">Pending</div></div>
                <div class="stat-card wide">
                    <div class="stat-label">Completion — ${res.grand_completion_pct ?? res.completion_pct}%</div>
                    <div class="progress-bar-container"><div class="progress-bar" style="width:${res.grand_completion_pct ?? res.completion_pct}%;background:var(--success)"></div></div>
                </div>
            </div>`;
    },

    // ========== WARD SUPERVISOR: Notice Booths ==========

    wardNoticeFamilies: [],
    wardNoticeFamiliesAll: [],
    wardNoticePage: 0,
    WARD_NOTICE_PAGE_SIZE: 15,

    async initWardNotice() {
        this.wardNoticeFamilies = [];
        this.wardNoticeFamiliesAll = [];
        this.wardNoticePage = 0;
        this.bindWardNoticeNav();
        this.bindWardFilters();
        await this.loadAllWardVoters();
    },

    async loadAllWardVoters() {
        const user = App.getUser();
        App.showViewLoading("view-ward-notice");
        const res = await API.getNoticeWardAllVoters(user.ward);
        App.hideViewLoading("view-ward-notice");
        if (res.error) return;

        const families = [...(res.families || [])];
        (res.ungrouped || []).forEach((m) => families.push({
            famcode: m.voter_id, members: [m],
            house: m.house, section: m.section,
            head_name: m.name, head_name_ta: m.name_ta || "",
            booth: m.booth || "",
        }));
        this.wardNoticeFamiliesAll = families;
        // Log first delivered member to check field presence
        const sample = families.flatMap(f=>f.members).find(m=>m.status==="delivered");
        if (sample) console.log("[notice load] sample delivered member:", JSON.stringify({voter_id:sample.voter_id, status:sample.status, delivered_by:sample.delivered_by, delivered_by_name:sample.delivered_by_name, delivered_at:sample.delivered_at}));

        // Populate booth filter
        const boothSel = document.getElementById("ward-notice-booth-filter");
        const booths = [...new Set(families.map((f) => f.booth).filter(Boolean))].sort();
        boothSel.innerHTML = `<option value="">All Booths</option>`;
        booths.forEach((b) => { const o = document.createElement("option"); o.value = b; o.textContent = b; boothSel.appendChild(o); });

        const delivered = (res.families || []).flatMap(f => f.members).filter(m => m.status === "delivered").length + (res.ungrouped || []).filter(m => m.status === "delivered").length;
        this._updateWardNoticeSummary(res.delivered, res.total);
        this._applyWardNoticeFilters();
    },

    _updateWardNoticeSummary(delivered, total) {
        const bar = document.getElementById("ward-notice-summary-bar");
        if (!bar) return;
        bar.innerHTML = `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} ${I18n.t("delivered")}</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} ${I18n.t("total")}</span>
            <span class="notice-summary-pct">${total > 0 ? Math.round(delivered / total * 100) : 0}%</span>
        </div>`;
    },

    _applyWardNoticeFilters(keepPage = false) {
        const search = (document.getElementById("ward-notice-search")?.value || "").toLowerCase().trim();
        const booth  = document.getElementById("ward-notice-booth-filter")?.value || "";
        const street = document.getElementById("ward-notice-street-filter")?.value || "";

        let filtered = this.wardNoticeFamiliesAll;
        if (booth)  filtered = filtered.filter((f) => f.booth === booth);
        if (street) filtered = filtered.filter((f) => f.members.some((m) => m.section === street));
        if (search) {
            filtered = filtered.filter((f) => f.members.some((m) =>
                (m.sl || "").toLowerCase().includes(search) ||
                (m.voter_id || "").toLowerCase().includes(search) ||
                (m.name || "").toLowerCase().includes(search) ||
                (m.name_en || "").toLowerCase().includes(search) ||
                (m.name_ta || "").includes(search) ||
                (m.section || "").toLowerCase().includes(search)
            ));
            // SL/EPIC exact-prefix matches float to top
            filtered.sort((a, b) => {
                const slMatch = (f) => f.members.some((m) =>
                    (m.sl || "").toLowerCase().startsWith(search) ||
                    (m.voter_id || "").toLowerCase().startsWith(search)
                );
                return slMatch(b) - slMatch(a);
            });
        }

        this.wardNoticeFamilies = filtered;
        if (!keepPage) this.wardNoticePage = 0;
        this.renderWardNoticeFamily();
        this._refreshSummaryFromMemory();

        // Update street options when booth changes
        if (booth) {
            const streets = [...new Set(
                this.wardNoticeFamiliesAll
                    .filter((f) => f.booth === booth)
                    .flatMap((f) => f.members.map((m) => m.section).filter(Boolean))
            )].sort();
            const streetSel = document.getElementById("ward-notice-street-filter");
            const cur = streetSel.value;
            streetSel.innerHTML = `<option value="">All Streets</option>`;
            streets.forEach((s) => { const o = document.createElement("option"); o.value = s; o.textContent = s; streetSel.appendChild(o); });
            if (streets.includes(cur)) streetSel.value = cur;
        }
    },

    bindWardFilters() {
        const clone = (id) => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const search = clone("ward-notice-search");
        const booth  = clone("ward-notice-booth-filter");
        const street = clone("ward-notice-street-filter");
        if (search) search.addEventListener("input",  () => this._applyWardNoticeFilters());
        if (booth)  booth.addEventListener("change",  () => this._applyWardNoticeFilters());
        if (street) street.addEventListener("change", () => this._applyWardNoticeFilters());
    },

    bindWardNoticeNav() {
        const prev = document.getElementById("btn-wn-prev");
        const next = document.getElementById("btn-wn-next");
        const totalPages = () => Math.ceil(this.wardNoticeFamilies.length / this.WARD_NOTICE_PAGE_SIZE);
        if (prev) prev.addEventListener("click", () => {
            if (this.wardNoticePage > 0) { this.wardNoticePage--; this.renderWardNoticeFamily(); document.getElementById("main-content").scrollTop = 0; }
        });
        if (next) next.addEventListener("click", () => {
            if (this.wardNoticePage < totalPages() - 1) { this.wardNoticePage++; this.renderWardNoticeFamily(); document.getElementById("main-content").scrollTop = 0; }
        });
    },

    async loadWardVoters() {
        if (!this.wardDrillBooth) return;
        const user = App.getUser();
        App.showViewLoading("view-ward-notice");
        const res = await API.getNoticeWardBoothVoters(user.ward, this.wardDrillBooth, this.wardDrillStreet);
        App.hideViewLoading("view-ward-notice");
        if (res.error) { App.showToast(res.detail || "Failed to load voters"); return; }

        // Build flat family list (families + ungrouped as single-member families)
        const families = [...(res.families || [])];
        (res.ungrouped || []).forEach((m) => families.push({ famcode: m.voter_id, members: [m], house: m.house, section: m.section, head_name: m.name, head_name_ta: m.name_ta || "" }));

        this.wardNoticeFamilies = families;
        this.wardNoticeFamilyIdx = 0;

        // Summary bar
        const bar = document.getElementById("ward-notice-summary-bar");
        if (bar) bar.innerHTML = `<div class="notice-summary">
            <span class="notice-summary-delivered">${res.delivered} ${I18n.t("delivered")}</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${res.total} ${I18n.t("total")}</span>
            <span class="notice-summary-pct">${res.total > 0 ? Math.round(res.delivered / res.total * 100) : 0}%</span>
        </div>`;

        this.renderWardNoticeFamily();
    },

    _hl(text, query) {
        const safe = this.escapeHtml(text || "");
        if (!query) return safe;
        try {
            const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return safe.replace(new RegExp(`(${esc})`, "gi"), '<mark class="search-hl">$1</mark>');
        } catch(e) { return safe; }
    },

    renderWardNoticeFamily() {
        const area    = document.getElementById("ward-notice-family-area");
        const nav     = document.getElementById("ward-notice-nav");
        const empty   = document.getElementById("ward-notice-empty-state");
        const counter = document.getElementById("ward-notice-counter");
        const prev    = document.getElementById("btn-wn-prev");
        const next    = document.getElementById("btn-wn-next");

        if (!this.wardNoticeFamilies.length) {
            area.innerHTML = ""; nav.style.display = "none"; empty.style.display = "block"; return;
        }
        empty.style.display = "none";

        const ps    = this.WARD_NOTICE_PAGE_SIZE;
        const total = this.wardNoticeFamilies.length;
        const pages = Math.ceil(total / ps);
        const pg    = Math.min(this.wardNoticePage, pages - 1);
        this.wardNoticePage = pg;

        const slice = this.wardNoticeFamilies.slice(pg * ps, pg * ps + ps);

        counter.textContent = `Page ${pg + 1} ${I18n.t("of")} ${pages} (${total} ${I18n.t("families") || "families"})`;
        prev.disabled = pg === 0;
        next.disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";

        const q = (document.getElementById("ward-notice-search")?.value || "").trim();
        area.innerHTML = slice.map((fam) => this.buildWardNoticeCard(fam, q)).join("");
        this.bindWardNoticeCardActions(area);
    },

    buildWardNoticeCard(fam, query) {
        const isTamil = I18n.currentLang === "ta";
        const members = fam.members || [];
        const deliveredCount = members.filter(m => m.status === "delivered").length;
        const allDelivered = deliveredCount === members.length;
        const section = members[0]?.section || "";

        let html = `<div class="family-card ncc">`;

        // Compact header
        html += `<div class="ncc-header">`;
        html += `<div class="ncc-header-left">`;
        html += `<span class="ncc-house">🏠 ${this.escapeHtml(fam.house || "-")}</span>`;
        html += `<span class="ncc-count">(${members.length})</span>`;
        if (section) html += `<span class="ncc-section">${this._hl(section, query)}</span>`;
        if (deliveredCount > 0) {
            html += `<span class="ncc-progress ${allDelivered ? "ncc-progress-full" : ""}">${deliveredCount}/${members.length} ✓</span>`;
        }
        html += `</div>`;
        html += `<button class="btn ${allDelivered ? "btn-success" : "btn-primary"} btn-sm notice-deliver-all" data-famcode="${fam.famcode}">`;
        html += allDelivered ? I18n.t("undeliver_all") : I18n.t("mark_house_done");
        html += `</button></div>`;

        // Member rows
        members.forEach((m) => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const relName = isTamil ? (m.relation_name_ta || m.relation_name || "-") : (m.relation_name || "-");
            const isDelivered = m.status === "delivered";
            const isHOF = m.is_head === "Yes";
            const deliverer = isDelivered ? (m.delivered_by_name || (m.delivered_by ? "···" + m.delivered_by.slice(-4) : "")) : "";
            const timeStr = isDelivered && m.delivered_at ? (() => {
                const d = new Date(m.delivered_at);
                return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
            })() : "";

            html += `<div class="ncc-member" data-voter="${m.voter_id}">`;

            // Always-visible compact row
            html += `<div class="ncc-member-summary">`;
            html += `<div class="ncc-member-left">`;
            if (m.sl) html += `<span class="ncc-sl">${this._hl(m.sl, query)}</span>`;
            html += `<span class="ncc-name ${isDelivered ? "ncc-name-done" : ""}">${this._hl(name, query)}`;
            if (isHOF) html += ` <span class="member-head-badge">👑</span>`;
            html += `</span>`;
            if (isDelivered && deliverer) html += `<span class="ncc-by">✓ ${this.escapeHtml(deliverer)}${timeStr ? " · " + timeStr : ""}</span>`;
            html += `</div>`;
            html += `<label class="notice-toggle ncc-toggle" onclick="event.stopPropagation()">`;
            html += `<input type="checkbox" data-voter-id="${m.voter_id}" ${isDelivered ? "checked" : ""}/>`;
            html += `<span class="notice-toggle-label">${isDelivered ? "✓ " + I18n.t("delivered") : "● " + I18n.t("not_delivered")}</span>`;
            if (m._pending) html += `<span class="ncc-pending" title="Pending sync">⟳</span>`;
            html += `</label>`;
            html += `</div>`;

            // Expandable details
            html += `<div class="ncc-details">`;
            if (m.voter_id) html += `<span class="ncc-detail"><span class="label">EPIC:</span> ${this._hl(m.voter_id, query)}</span>`;
            if (m.sl)       html += `<span class="ncc-detail"><span class="label">SL:</span> ${this._hl(m.sl, query)}</span>`;
            html += `<span class="ncc-detail">${m.age} · ${m.gender === "Male" ? I18n.t("male") : I18n.t("female")}</span>`;
            if (m.relation_type) html += `<span class="ncc-detail">${this.escapeHtml(m.relation_type)} – ${this.escapeHtml(relName)}</span>`;
            html += `</div>`;

            html += `</div>`;
        });

        html += `</div>`;
        return html;
    },

    bindWardNoticeCardActions(area) {
        // Expand/collapse member details on row tap
        area.querySelectorAll(".ncc-member-summary").forEach((row) => {
            row.addEventListener("click", (e) => {
                if (e.target.closest(".ncc-toggle")) return;
                const details = row.nextElementSibling;
                if (details && details.classList.contains("ncc-details")) {
                    details.classList.toggle("ncc-details-open");
                }
            });
        });

        // Individual toggles
        area.querySelectorAll(".notice-toggle input").forEach((cb) => {
            cb.addEventListener("change", async () => {
                const vid = cb.dataset.voterId;
                const action = cb.checked ? "deliver" : "undeliver";
                if (action === "undeliver") {
                    cb.checked = true; // revert while confirming
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    cb.checked = false;
                }
                cb.disabled = true;
                await this.wardToggleNotice([vid], action);
            });
        });

        // Deliver/Undeliver all
        area.querySelectorAll(".notice-deliver-all").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const famcode = btn.dataset.famcode;
                const fam = this.wardNoticeFamiliesAll.find((f) => f.famcode === famcode);
                if (!fam) return;
                const allDelivered = fam.members.every((m) => m.status === "delivered");
                if (allDelivered) {
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    btn.disabled = true;
                    await this.wardToggleNotice(fam.members.map((m) => m.voter_id), "undeliver");
                } else {
                    btn.disabled = true;
                    const undelivered = fam.members.filter((m) => m.status !== "delivered").map((m) => m.voter_id);
                    await this.wardToggleNotice(undelivered, "deliver");
                }
            });
        });
    },

    async wardToggleNotice(voterIds, action) {
        const user = App.getUser();
        const newStatus = action === "deliver" ? "delivered" : "not_delivered";
        const idSet = new Set(voterIds);
        const me = App.getUser();
        const myName = me?.name || "";
        const myTime = new Date().toISOString();

        const booth = voterIds.length > 0
            ? (this.wardNoticeFamiliesAll.find((f) => f.members.some((m) => idSet.has(m.voter_id)))?.booth || "")
            : "";
        const res = await (action === "deliver"
            ? API.wardDeliverNotice(user.ward, booth, voterIds)
            : API.wardUndeliverNotice(user.ward, booth, voterIds));

        if (res && res.error) {
            console.log("[ward toggle] error:", res.detail, "| action:", action, "| voters:", voterIds);
            if (res.detail === "Network error") {
                console.log("[ward toggle] offline — queuing and flipping UI");
                NoticeQueue.add({ type: "ward", ward: user.ward, booth,
                    voterIds, action, myName, myPhone: me?.phone || "", myTime });
                this.wardNoticeFamiliesAll.forEach(fam => fam.members.forEach(m => {
                    if (idSet.has(m.voter_id)) {
                        m.status = newStatus; m._pending = true;
                        if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                        else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
                    }
                }));
                this._applyWardNoticeFilters(true);
                this._refreshSummaryFromMemory();
                App.showToast("No internet — will sync when connected");
            } else {
                this._applyWardNoticeFilters(true);
                App.showToast(res.detail || "Failed to update");
            }
            return;
        }

        this.wardNoticeFamiliesAll.forEach((fam) => {
            fam.members.forEach((m) => {
                if (idSet.has(m.voter_id)) {
                    m.status = newStatus; m._pending = false;
                    if (action === "deliver") {
                        m.delivered_by_name = myName;
                        m.delivered_by = me?.phone || "";
                        m.delivered_at = myTime;
                    } else {
                        m.delivered_by_name = "";
                        m.delivered_by = "";
                        m.delivered_at = "";
                    }
                }
            });
        });
        this._applyWardNoticeFilters(true);
        this._refreshSummaryFromMemory();
    },

    _refreshSummaryFromMemory() {
        const all = this.wardNoticeFamilies.flatMap((f) => f.members);
        const total     = all.length;
        const delivered = all.filter((m) => m.status === "delivered").length;
        this._updateWardNoticeSummary(delivered, total);
    },

    // ========== WARD SUPERVISOR: Notice Stats ==========

    async loadWardNoticeStats() {
        const user = App.getUser();
        App.showViewLoading("view-ward-notice-stats");
        const res = await API.getNoticeWardStats(user.ward);
        App.hideViewLoading("view-ward-notice-stats");

        if (res.error) return;

        const cards = document.getElementById("ward-notice-stats-cards");
        cards.innerHTML = `
            <div class="stat-card accent">
                <div class="stat-value">${res.total}</div>
                <div class="stat-label">${I18n.t("total")}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-value">${res.delivered}</div>
                <div class="stat-label">${I18n.t("delivered")}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-value">${res.pending}</div>
                <div class="stat-label">${I18n.t("pending")}</div>
            </div>
            <div class="stat-card wide">
                <div class="stat-value">${res.completion_pct}%</div>
                <div class="stat-label">${I18n.t("completion")}</div>
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width:${res.completion_pct}%;background:var(--success)"></div>
                </div>
            </div>
        `;

        const boothList = document.getElementById("ward-notice-booth-stats");
        if (res.booths && res.booths.length > 0) {
            boothList.innerHTML = res.booths.map((b) => `
                <div class="booth-stat-row">
                    <div class="stat-row-top">
                        <span class="stat-row-name">${this._noticeBoothHtml(b)}</span>
                        <span class="stat-row-pct">${b.completion_pct}%</span>
                    </div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width:${b.completion_pct}%;background:var(--success)"></div>
                    </div>
                    <div class="stat-row-nums">
                        <span>${I18n.t("delivered")}: ${b.delivered}</span>
                        <span>${I18n.t("pending")}: ${b.pending}</span>
                        <span>${I18n.t("total")}: ${b.total}</span>
                    </div>
                </div>
            `).join("");
        } else {
            boothList.innerHTML = `<div class="empty-state"><p>${I18n.t("no_data")}</p></div>`;
        }

        // Coupon summary
        const couponRes = await API.getCouponWardStats(user.ward);
        if (!couponRes.error) {
            let container = document.getElementById("ward-notice-stats-coupon");
            if (!container) { container = document.createElement("div"); container.id = "ward-notice-stats-coupon"; document.getElementById("view-ward-notice-stats").querySelector(".view-content").appendChild(container); }
            this._appendCouponSummary("ward-notice-stats-coupon", couponRes);
        }
    },

    // ========== ADMIN: Notice Stats ==========

    noticeWardChart: null,
    _noticeWardBooths: {},  // ward -> booth stats cache

    _noticeBoothLabel(b) {
        // Plain text label (used where HTML is not safe)
        return this.formatBoothLabel(b.booth_name, b.booth_number, 35, b.booth_name_tamil);
    },

    _noticeBoothHtml(b) {
        // Stacked HTML: number tag + full name, no truncation
        const isTamil = I18n.currentLang === "ta";
        const name = (isTamil && b.booth_name_tamil) ? b.booth_name_tamil : (b.booth_name || b.booth || "");
        const num = b.booth_number;
        return num
            ? `<span class="picker-booth-num">#${num}</span><span class="picker-booth-name">${Booth.escHtml(name)}</span>`
            : `<span class="picker-booth-name">${Booth.escHtml(name)}</span>`;
    },

    async loadAdminNoticeStats() {
        App.showViewLoading("view-admin-notice-stats");
        this._noticeWardBooths = {};
        const res = await API.getNoticeAdminStats("", "");
        App.hideViewLoading("view-admin-notice-stats");
        if (res.error) return;

        const cards = document.getElementById("admin-notice-stats-cards");
        cards.innerHTML = `
            <div class="stat-card accent">
                <div class="stat-value">${res.grand_total}</div>
                <div class="stat-label">${I18n.t("total")}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-value">${res.grand_delivered}</div>
                <div class="stat-label">${I18n.t("delivered")}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-value">${res.grand_pending}</div>
                <div class="stat-label">${I18n.t("pending")}</div>
            </div>
            <div class="stat-card wide">
                <div class="stat-value">${res.grand_completion_pct}%</div>
                <div class="stat-label">${I18n.t("completion")}</div>
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width:${res.grand_completion_pct}%;background:var(--success)"></div>
                </div>
            </div>
        `;

        const wards = res.wards || [];
        this.renderNoticeWardChart(wards);

        const wardList = document.getElementById("admin-notice-ward-stats");
        if (wards.length === 0) {
            wardList.innerHTML = `<div class="empty-state"><p>${I18n.t("no_data")}</p></div>`;
            return;
        }

        wardList.innerHTML = wards.map((w, i) => `
            <div class="notice-ward-accordion" data-ward-idx="${i}">
                <div class="notice-ward-header">
                    <div class="stat-row-top">
                        <span class="stat-row-name">${w.ward_name || w.ward}</span>
                        <span class="stat-row-pct">
                            ${w.completion_pct}%
                            <svg class="accordion-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                        </span>
                    </div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width:${w.completion_pct}%;background:var(--success)"></div>
                    </div>
                    <div class="stat-row-nums">
                        <span>${I18n.t("delivered")}: ${w.delivered}</span>
                        <span>${I18n.t("pending")}: ${w.pending}</span>
                        <span>${I18n.t("total")}: ${w.total}</span>
                    </div>
                </div>
                <div class="notice-ward-booths" style="display:none;"></div>
            </div>
        `).join("");

        wardList.querySelectorAll(".notice-ward-header").forEach((header, i) => {
            header.addEventListener("click", () => this.toggleNoticeWard(i, wards[i].ward));
        });

        // Coupon summary
        const couponRes = await API.getCouponAdminStats("", "");
        if (!couponRes.error) {
            let container = document.getElementById("admin-notice-stats-coupon");
            if (!container) { container = document.createElement("div"); container.id = "admin-notice-stats-coupon"; document.getElementById("view-admin-notice-stats").querySelector(".view-content").appendChild(container); }
            this._appendCouponSummary("admin-notice-stats-coupon", couponRes);
        }
    },

    async toggleNoticeWard(idx, wardKey) {
        const accordion = document.querySelector(`.notice-ward-accordion[data-ward-idx="${idx}"]`);
        if (!accordion) return;
        const boothsDiv = accordion.querySelector(".notice-ward-booths");
        const chevron = accordion.querySelector(".accordion-chevron");
        const isOpen = boothsDiv.style.display !== "none";

        if (isOpen) {
            boothsDiv.style.display = "none";
            chevron.style.transform = "";
            return;
        }

        boothsDiv.style.display = "block";
        chevron.style.transform = "rotate(180deg)";

        if (this._noticeWardBooths[wardKey]) {
            this._renderNoticeWardBooths(boothsDiv, this._noticeWardBooths[wardKey]);
            return;
        }

        boothsDiv.innerHTML = `<div class="loading-row"><div class="spinner-sm"></div></div>`;
        const res = await API.getNoticeAdminStats(wardKey, "");
        if (res.error) { boothsDiv.innerHTML = ""; return; }
        this._noticeWardBooths[wardKey] = res.booths || [];
        this._renderNoticeWardBooths(boothsDiv, this._noticeWardBooths[wardKey]);
    },

    _renderNoticeWardBooths(container, booths) {
        if (!booths.length) {
            container.innerHTML = `<div class="empty-state" style="padding:12px;"><p>${I18n.t("no_data")}</p></div>`;
            return;
        }
        container.innerHTML = booths.map((b) => `
            <div class="booth-stat-row booth-stat-indent">
                <div class="stat-row-top">
                    <span class="stat-row-name">${this._noticeBoothHtml(b)}</span>
                    <span class="stat-row-pct">${b.completion_pct}%</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width:${b.completion_pct}%;background:var(--success)"></div>
                </div>
                <div class="stat-row-nums">
                    <span>${I18n.t("delivered")}: ${b.delivered}</span>
                    <span>${I18n.t("pending")}: ${b.pending}</span>
                    <span>${I18n.t("total")}: ${b.total}</span>
                </div>
            </div>
        `).join("");
    },

    renderNoticeWardChart(wards) {
        const wrap = document.getElementById("notice-ward-chart-wrap");
        const ctx = document.getElementById("notice-ward-chart");
        if (!ctx) return;
        if (this.noticeWardChart) this.noticeWardChart.destroy();

        if (wards.length === 0) return;

        const sorted = [...wards].sort((a, b) => b.completion_pct - a.completion_pct);
        const chartH = Math.max(180, sorted.length * 38);
        wrap.style.height = chartH + "px";

        this.noticeWardChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels: sorted.map((w) => w.ward_name || w.ward),
                datasets: [{
                    label: "% Delivered",
                    data: sorted.map((w) => w.completion_pct),
                    backgroundColor: sorted.map((w) =>
                        w.completion_pct >= 75 ? "#22c55e" :
                        w.completion_pct >= 40 ? "#f59e0b" : "#ef4444"
                    ),
                    borderRadius: 4,
                }],
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => ` ${c.raw}%` } },
                },
                scales: {
                    x: {
                        min: 0, max: 100,
                        grid: { color: "#f1f5f9" },
                        ticks: { callback: (v) => v + "%", font: { family: "DM Sans", size: 10 } },
                    },
                    y: {
                        grid: { display: false },
                        ticks: { font: { family: "DM Sans", size: 11 } },
                    },
                },
            },
        });
    },

    // ========== ADMIN: Settings ==========

    _formatSettingMeta(updatedBy, updatedAt) {
        const by = updatedBy ? `****${updatedBy.slice(-4)}` : "-";
        const at = updatedAt ? new Date(updatedAt).toLocaleString() : "-";
        return `Last updated by ${by} on ${at}`;
    },

    async loadSettings() {
        App.showViewLoading("view-admin-settings");
        const res = await API.getNoticeSettings();
        App.hideViewLoading("view-admin-settings");
        if (res.error) return;

        const tcOn     = res.telecalling_enabled !== false;
        const noticeOn = res.notice_enabled !== false;
        const couponOn = res.coupon_enabled !== false;
        const appOn    = res.app_access_enabled !== false;

        const mkCard = (id, title, desc, on, meta) => `
            <div class="settings-card">
                <div class="settings-card-header">
                    <div>
                        <div class="settings-card-title">${title}</div>
                        <div class="settings-card-desc">${desc}</div>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="${id}" ${on ? "checked" : ""}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-card-footer">
                    <span class="settings-meta">${meta}</span>
                </div>
            </div>`;

        // Custom schemes section (all, including disabled — so they can be re-enabled)
        const customSchemes = res.custom_schemes || [];
        let customSchemesHtml = "";
        if (customSchemes.length > 0) {
            customSchemesHtml += `<h3 class="section-title" style="margin-top:20px;">Custom Schemes</h3>`;
            customSchemes.forEach(s => {
                const typeLabel = s.type === "individual" ? "Voter Level" : "Family Level";
                const desc = `${typeLabel} · Once created, schemes cannot be deleted — only disabled`;
                const meta = this._formatSettingMeta(
                    s.enabled_updated_by || s.created_by,
                    s.enabled_updated_at || s.created_at
                );
                customSchemesHtml += mkCard(`toggle-scheme-${s.id}`, s.name, desc, s.enabled, meta);
            });
        }

        document.getElementById("settings-container").innerHTML =
            mkCard("toggle-app-access",  I18n.t("app_access"),         I18n.t("app_access_desc"),    appOn,    this._formatSettingMeta(res.app_access_enabled_updated_by,   res.app_access_enabled_updated_at)) +
            mkCard("toggle-telecalling", I18n.t("telecalling"),        I18n.t("telecalling_desc"),   tcOn,     this._formatSettingMeta(res.telecalling_enabled_updated_by,   res.telecalling_enabled_updated_at)) +
            mkCard("toggle-notice",      I18n.t("notice_distribution"), I18n.t("notice_toggle_desc"), noticeOn, this._formatSettingMeta(res.notice_enabled_updated_by,        res.notice_enabled_updated_at)) +
            mkCard("toggle-coupon",      "Coupon Distribution",         "Enable/disable coupon distribution for booth and ward workers", couponOn, this._formatSettingMeta(res.coupon_enabled_updated_by, res.coupon_enabled_updated_at)) +
            customSchemesHtml;

        const wire = (id, apiCall, onMsg, offMsg, cb) => {
            document.getElementById(id)?.addEventListener("change", async (e) => {
                const enabled = e.target.checked;
                const r = await apiCall(enabled);
                if (r.error) { e.target.checked = !enabled; App.showToast(r.detail || "Failed"); return; }
                App.showToast(enabled ? onMsg : offMsg);
                if (cb) cb(enabled);
                await this.loadSettings();
            });
        };

        wire("toggle-app-access",  (en) => API.toggleAppAccess(en),    I18n.t("app_access_enabled"), I18n.t("app_access_disabled"));
        wire("toggle-telecalling", (en) => API.toggleTelecalling(en),  I18n.t("feature_enabled"),    I18n.t("feature_disabled"));
        wire("toggle-notice",      (en) => API.toggleNoticeFeature(en), I18n.t("feature_enabled"),   I18n.t("feature_disabled"), (en) => { this.noticeEnabled = en; });
        wire("toggle-coupon",      (en) => API.toggleCouponFeature(en), I18n.t("feature_enabled"),   I18n.t("feature_disabled"), (en) => { Coupon.couponEnabled = en; });

        // Wire each custom scheme toggle
        customSchemes.forEach(s => {
            wire(
                `toggle-scheme-${s.id}`,
                (en) => API.toggleCustomScheme(s.id, en),
                I18n.t("feature_enabled"),
                I18n.t("feature_disabled")
            );
        });
    },

    // ========== SHARED: Render voter list with checkboxes ==========

    renderVoterList(containerId, summaryBarId, emptyStateId, data, toggleCallback) {
        const container = document.getElementById(containerId);
        const summaryBar = document.getElementById(summaryBarId);
        const emptyState = document.getElementById(emptyStateId);

        if (data.total === 0) {
            container.innerHTML = "";
            summaryBar.innerHTML = "";
            emptyState.style.display = "block";
            return;
        }

        emptyState.style.display = "none";

        // Summary bar
        summaryBar.innerHTML = `
            <div class="notice-summary">
                <span class="notice-summary-delivered">${data.delivered} ${I18n.t("delivered")}</span>
                <span class="notice-summary-sep">/</span>
                <span class="notice-summary-total">${data.total} ${I18n.t("total")}</span>
                <span class="notice-summary-pct">${data.total > 0 ? Math.round(data.delivered / data.total * 100) : 0}%</span>
            </div>
        `;

        let html = "";

        // Families first
        if (data.families && data.families.length > 0) {
            data.families.forEach((fam) => {
                const allDelivered = fam.members.every((m) => m.status === "delivered");
                const someDelivered = fam.members.some((m) => m.status === "delivered");
                const isTamil = I18n.currentLang === "ta";
                const headName = this.escapeHtml(
                    isTamil ? (fam.head_name_ta || fam.head_name || "Family") : (fam.head_name || "Family")
                );
                const section = fam.members.length > 0 ? this.escapeHtml(fam.members[0].section || "") : "";

                html += `<div class="notice-family-group">`;
                html += `<div class="notice-family-header">`;
                html += `<div class="notice-family-info">`;
                html += `<span class="notice-family-name">${headName}</span>`;
                html += `<span class="notice-family-meta">${fam.house ? "House: " + this.escapeHtml(fam.house) : ""}${section ? " | " + section : ""} | ${I18n.t("members")}: ${fam.members.length}</span>`;
                html += `</div>`;
                html += `<button class="btn btn-sm notice-select-all ${allDelivered ? "btn-success" : "btn-secondary"}" data-famcode="${fam.famcode}">`;
                html += allDelivered ? I18n.t("delivered") : I18n.t("select_all");
                html += `</button>`;
                html += `</div>`;

                fam.members.forEach((m) => {
                    html += this.renderVoterRow(m);
                });

                html += `</div>`;
            });
        }

        // Ungrouped voters
        if (data.ungrouped && data.ungrouped.length > 0) {
            html += `<div class="notice-ungrouped-section">`;
            html += `<div class="notice-ungrouped-header">${I18n.t("others")} (${data.ungrouped.length})</div>`;
            data.ungrouped.forEach((m) => {
                html += this.renderVoterRow(m, true);
            });
            html += `</div>`;
        }

        container.innerHTML = html;

        // Bind individual toggles
        container.querySelectorAll(".notice-toggle input").forEach((cb) => {
            cb.addEventListener("change", async () => {
                const vid = cb.dataset.voterId;
                if (!cb.checked) {
                    // Undeliver - ask for confirmation
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) {
                        cb.checked = true; // revert toggle
                        return;
                    }
                }
                const action = cb.checked ? "deliver" : "undeliver";
                cb.disabled = true;
                await toggleCallback([vid], action);
            });
        });

        // Bind select-all buttons
        container.querySelectorAll(".notice-select-all").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const famcode = btn.dataset.famcode;
                const group = btn.closest(".notice-family-group");
                const checkboxes = group.querySelectorAll(".notice-toggle input:not(:checked)");
                const voterIds = [];
                checkboxes.forEach((cb) => voterIds.push(cb.dataset.voterId));

                if (voterIds.length === 0) {
                    // All already delivered - undeliver all, but confirm first
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    const allCbs = group.querySelectorAll(".notice-toggle input:checked");
                    const allIds = [];
                    allCbs.forEach((cb) => allIds.push(cb.dataset.voterId));
                    if (allIds.length > 0) {
                        btn.disabled = true;
                        await toggleCallback(allIds, "undeliver");
                    }
                } else {
                    btn.disabled = true;
                    await toggleCallback(voterIds, "deliver");
                }
            });
        });
    },

    renderVoterRow(member, showLocation = false) {
        const isDelivered = member.status === "delivered";
        const isTamil = I18n.currentLang === "ta";
        const name = this.escapeHtml(
            isTamil ? (member.name_ta || member.name || "") : (member.name_en || member.name || "")
        );
        const relType = this.escapeHtml(member.relation_type || "");
        const relName = this.escapeHtml(
            (isTamil && member.relation_name_ta) ? member.relation_name_ta : (member.relation_name || "")
        );
        const age = member.age || "";
        const gender = this.escapeHtml(member.gender || "");
        const house = this.escapeHtml(member.house || "");
        const section = this.escapeHtml(member.section || "");

        return `
            <div class="notice-voter-row ${isDelivered ? "delivered" : ""}">
                <div class="notice-voter-info">
                    <div class="notice-voter-name">${name}${member.is_head === "Yes" ? '<span class="member-head-badge">👑</span>' : ""}</div>
                    <div class="notice-voter-details">
                        ${relType && relName ? `<span>${relType}: ${relName}</span>` : ""}
                        ${age ? `<span>${age}y</span>` : ""}
                        ${gender ? `<span>${gender}</span>` : ""}
                    </div>
                    ${showLocation ? `<div class="notice-voter-location">${house ? "House: " + house : ""}${house && section ? " | " : ""}${section ? section : ""}</div>` : ""}
                </div>
                <label class="notice-toggle">
                    <input type="checkbox" data-voter-id="${member.voter_id}" ${isDelivered ? "checked" : ""}>
                    <span class="notice-toggle-track"></span>
                </label>
            </div>
        `;
    },

    escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    },

    // ========== SUPER ADMIN: Notice Browser ==========

    adminBrowseWard: "",
    adminBrowseBooth: "",
    adminBrowseFamiliesAll: [],
    adminBrowseFamilies: [],
    adminBrowsePage: 0,
    adminBrowseDeliveredOnly: false,

    async initAdminNoticeBrowser() {
        this.adminBrowseWard = "";
        this.adminBrowseBooth = "";
        this.adminBrowseFamiliesAll = [];
        this.adminBrowseFamilies = [];
        this.adminBrowsePage = 0;
        this.adminBrowseDeliveredOnly = false;
        this._bindAdminBrowseFilters();
        await this._loadAdminBrowseWards();
    },

    async _loadAdminBrowseWards() {
        const wardSel = document.getElementById("admin-browse-ward");
        wardSel.innerHTML = `<option value="">Select Ward</option>`;
        App.showViewLoading("view-admin-notice-browser");
        const res = await API.getNoticeAdminStats("", "");
        if (res.error) { App.hideViewLoading("view-admin-notice-browser"); return; }
        const wards = res.wards || [];
        wards.forEach(w => {
            const o = document.createElement("option");
            o.value = w.ward;
            o.textContent = w.ward_name || w.ward;
            wardSel.appendChild(o);
        });
        // Auto-select first ward
        if (wards.length > 0) {
            wardSel.value = wards[0].ward;
            this.adminBrowseWard = wards[0].ward;
            await this._loadAdminBrowseBooths(this.adminBrowseWard);
            await this._loadAdminBrowseFamilies();
        } else {
            App.hideViewLoading("view-admin-notice-browser");
        }
    },

    async _loadAdminBrowseBooths(ward) {
        const boothSel = document.getElementById("admin-browse-booth");
        boothSel.innerHTML = `<option value="">All Booths</option>`;
        document.getElementById("admin-browse-street").innerHTML = `<option value="">All Streets</option>`;
        if (!ward) return;
        const res = await API.getNoticeWardBooths(ward);
        if (res.error) return;
        (res.booths || []).forEach(b => {
            const o = document.createElement("option");
            if (typeof b === "object" && b !== null) {
                o.value = b.booth || "";
                o.textContent = Ward.formatBoothLabel(b.booth_name, b.booth_number, 40, b.booth_name_tamil) || b.booth || "";
            } else {
                o.value = b; o.textContent = b;
            }
            boothSel.appendChild(o);
        });
    },

    async _loadAdminBrowseStreets(ward, booth) {
        const streetSel = document.getElementById("admin-browse-street");
        streetSel.innerHTML = `<option value="">All Streets</option>`;
        if (!ward || !booth) return;
        const res = await API.getNoticeWardBoothStreets(ward, booth);
        if (res.error) return;
        (res.streets || []).forEach(s => {
            const o = document.createElement("option");
            o.value = s; o.textContent = s; streetSel.appendChild(o);
        });
    },

    async _loadAdminBrowseFamilies() {
        const ward = this.adminBrowseWard;
        const booth = this.adminBrowseBooth;
        const area = document.getElementById("admin-browse-family-area");
        const empty = document.getElementById("admin-browse-empty");
        if (!ward) {
            area.innerHTML = "";
            empty.style.display = "block";
            empty.querySelector("p").textContent = "Select a ward to browse.";
            document.getElementById("admin-browse-nav").style.display = "none";
            document.getElementById("admin-browse-summary").innerHTML = "";
            App.hideViewLoading("view-admin-notice-browser");
            return;
        }
        empty.style.display = "none";
        App.showViewLoading("view-admin-notice-browser");
        const res = booth
            ? await API.getNoticeWardBoothVoters(ward, booth, "")
            : await API.getNoticeWardAllVoters(ward);
        App.hideViewLoading("view-admin-notice-browser");
        if (res.error) return;

        const families = [...(res.families || [])];
        (res.ungrouped || []).forEach(m => families.push({
            famcode: m.voter_id, members: [m],
            house: m.house, section: m.section,
            head_name: m.name, head_name_ta: m.name_ta || "", booth,
        }));
        this.adminBrowseFamiliesAll = families;

        // Summary bar
        const delivered = families.flatMap(f => f.members).filter(m => m.status === "delivered").length;
        const total = families.flatMap(f => f.members).length;
        document.getElementById("admin-browse-summary").innerHTML = `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} ${I18n.t("delivered")}</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} ${I18n.t("total")}</span>
            <span class="notice-summary-pct">${total > 0 ? Math.round(delivered / total * 100) : 0}%</span>
        </div>`;

        this._applyAdminBrowseFilters();
    },

    _applyAdminBrowseFilters(keepPage = false) {
        const search = (document.getElementById("admin-browse-search")?.value || "").toLowerCase().trim();
        const street = document.getElementById("admin-browse-street")?.value || "";

        let filtered = this.adminBrowseFamiliesAll;
        if (this.adminBrowseDeliveredOnly) filtered = filtered.filter(f => f.members.some(m => m.status === "delivered"));
        if (street) filtered = filtered.filter(f => f.members.some(m => m.section === street));
        if (search) {
            filtered = filtered.filter(f => f.members.some(m =>
                (m.sl || "").toLowerCase().includes(search) ||
                (m.voter_id || "").toLowerCase().includes(search) ||
                (m.name || "").toLowerCase().includes(search) ||
                (m.name_en || "").toLowerCase().includes(search) ||
                (m.name_ta || "").includes(search) ||
                (m.section || "").toLowerCase().includes(search)
            ));
            filtered.sort((a, b) => {
                const hit = f => f.members.some(m =>
                    (m.sl || "").toLowerCase().startsWith(search) ||
                    (m.voter_id || "").toLowerCase().startsWith(search));
                return hit(b) - hit(a);
            });
        }
        this.adminBrowseFamilies = filtered;
        if (!keepPage) this.adminBrowsePage = 0;
        this._renderAdminBrowseFamily();
        this._refreshAdminBrowseSummary();
    },

    _refreshAdminBrowseSummary() {
        const all = this.adminBrowseFamilies.flatMap(f => f.members);
        const delivered = all.filter(m => m.status === "delivered").length;
        const total = all.length;
        document.getElementById("admin-browse-summary").innerHTML = total === 0 ? "" : `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} ${I18n.t("delivered")}</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} ${I18n.t("total")}</span>
            <span class="notice-summary-pct">${Math.round(delivered / total * 100)}%</span>
        </div>`;
    },

    _renderAdminBrowseFamily() {
        const area  = document.getElementById("admin-browse-family-area");
        const nav   = document.getElementById("admin-browse-nav");
        const empty = document.getElementById("admin-browse-empty");
        const ps    = this.WARD_NOTICE_PAGE_SIZE;
        const total = this.adminBrowseFamilies.length;

        if (total === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            empty.style.display = "block";
            empty.querySelector("p").textContent = this.adminBrowseFamiliesAll.length > 0
                ? "No results for current search/filter."
                : "No families found.";
            return;
        }
        empty.style.display = "none";

        const pages = Math.ceil(total / ps);
        const pg    = Math.min(this.adminBrowsePage, pages - 1);
        this.adminBrowsePage = pg;

        document.getElementById("admin-browse-counter").textContent = `${pg + 1} / ${pages}`;
        document.getElementById("btn-ab-prev").disabled = pg === 0;
        document.getElementById("btn-ab-next").disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";

        const q = (document.getElementById("admin-browse-search")?.value || "").trim();
        const slice = this.adminBrowseFamilies.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this.buildWardNoticeCard(fam, q)).join("");
        this._bindAdminBrowseCardActions(area);
    },

    _bindAdminBrowseCardActions(area) {
        area.querySelectorAll(".ncc-member-summary").forEach(row => {
            row.addEventListener("click", e => {
                if (e.target.closest(".ncc-toggle")) return;
                const details = row.nextElementSibling;
                if (details?.classList.contains("ncc-details")) details.classList.toggle("ncc-details-open");
            });
        });
        area.querySelectorAll(".notice-toggle input").forEach(cb => {
            cb.addEventListener("change", async () => {
                const action = cb.checked ? "deliver" : "undeliver";
                if (action === "undeliver") {
                    cb.checked = true;
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    cb.checked = false;
                }
                cb.disabled = true;
                await this._adminBrowseToggle([cb.dataset.voterId], action);
            });
        });
        area.querySelectorAll(".notice-deliver-all").forEach(btn => {
            btn.addEventListener("click", async () => {
                const fam = this.adminBrowseFamiliesAll.find(f => f.famcode === btn.dataset.famcode);
                if (!fam) return;
                const allDelivered = fam.members.every(m => m.status === "delivered");
                if (allDelivered) {
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    btn.disabled = true;
                    await this._adminBrowseToggle(fam.members.map(m => m.voter_id), "undeliver");
                } else {
                    btn.disabled = true;
                    await this._adminBrowseToggle(fam.members.filter(m => m.status !== "delivered").map(m => m.voter_id), "deliver");
                }
            });
        });
    },

    async _adminBrowseToggle(voterIds, action) {
        const ward  = this.adminBrowseWard;
        const booth = this.adminBrowseBooth;
        const newStatus = action === "deliver" ? "delivered" : "not_delivered";
        const idSet = new Set(voterIds);
        const me = App.getUser();
        const myName = me?.name || "";
        const myTime = new Date().toISOString();

        const res = await (action === "deliver"
            ? API.wardDeliverNotice(ward, booth, voterIds)
            : API.wardUndeliverNotice(ward, booth, voterIds));

        if (res && res.error) {
            this._applyAdminBrowseFilters(true);
            App.showToast(res.detail || "Failed to update");
            return;
        }

        this.adminBrowseFamiliesAll.forEach(fam => fam.members.forEach(m => {
            if (idSet.has(m.voter_id)) {
                m.status = newStatus;
                if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
            }
        }));
        this._applyAdminBrowseFilters(true);

        this._refreshAdminBrowseSummary();
    },

    _bindAdminBrowseFilters() {
        const cloneEl = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };

        const wardSel   = cloneEl("admin-browse-ward");
        const boothSel  = cloneEl("admin-browse-booth");
        const streetSel = cloneEl("admin-browse-street");
        const search    = cloneEl("admin-browse-search");

        const prev = document.getElementById("btn-ab-prev");
        const next = document.getElementById("btn-ab-next");
        if (prev) { const p = prev.cloneNode(true); prev.parentNode.replaceChild(p, prev);
            p.addEventListener("click", () => { if (this.adminBrowsePage > 0) { this.adminBrowsePage--; this._renderAdminBrowseFamily(); document.getElementById("main-content").scrollTop = 0; } }); }
        if (next) { const n = next.cloneNode(true); next.parentNode.replaceChild(n, next);
            n.addEventListener("click", () => { const pages = Math.ceil(this.adminBrowseFamilies.length / this.WARD_NOTICE_PAGE_SIZE); if (this.adminBrowsePage < pages - 1) { this.adminBrowsePage++; this._renderAdminBrowseFamily(); document.getElementById("main-content").scrollTop = 0; } }); }

        const delivBtn = document.getElementById("btn-admin-browse-delivered-only");
        if (delivBtn) delivBtn.addEventListener("click", () => {
            this.adminBrowseDeliveredOnly = !this.adminBrowseDeliveredOnly;
            delivBtn.classList.toggle("btn-primary", this.adminBrowseDeliveredOnly);
            delivBtn.classList.toggle("btn-secondary", !this.adminBrowseDeliveredOnly);
            this._applyAdminBrowseFilters();
        });

        if (wardSel) wardSel.addEventListener("change", async () => {
            this.adminBrowseWard = wardSel.value;
            this.adminBrowseBooth = "";
            this.adminBrowseFamiliesAll = [];
            this.adminBrowseFamilies = [];
            await this._loadAdminBrowseBooths(this.adminBrowseWard);
            await this._loadAdminBrowseFamilies();
        });
        if (boothSel) boothSel.addEventListener("change", async () => {
            this.adminBrowseBooth = boothSel.value;
            await this._loadAdminBrowseStreets(this.adminBrowseWard, this.adminBrowseBooth);
            await this._loadAdminBrowseFamilies();
        });
        if (streetSel) streetSel.addEventListener("change", () => this._applyAdminBrowseFilters());
        if (search) search.addEventListener("input", () => this._applyAdminBrowseFilters());
    },
};

const NoticeQueue = {
    KEY: "vc_notice_queue",

    load() {
        try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); }
        catch { return []; }
    },

    save(queue) { localStorage.setItem(this.KEY, JSON.stringify(queue)); },

    add(item) {
        // Deduplicate: last action for the same voter set wins
        const queue = this.load().filter(q =>
            !(q.type === item.type &&
              JSON.stringify([...q.voterIds].sort()) === JSON.stringify([...item.voterIds].sort()))
        );
        queue.push({ ...item, id: `${Date.now()}${Math.random()}`, timestamp: Date.now() });
        this.save(queue);
        this._updateBanner();
    },

    async drain() {
        if (!App.getUser()) return; // not authenticated yet — skip
        const queue = this.load();
        if (!queue.length) { this._updateBanner(); return; }
        if (!navigator.onLine) return;

        const remaining = [];
        const failed = [];

        for (const item of queue) {
            let res;
            if (item.type === "booth") {
                res = await (item.action === "deliver"
                    ? API.deliverNotice(item.ward, item.booth, item.voterIds)
                    : API.undeliverNotice(item.ward, item.booth, item.voterIds));
            } else {
                res = await (item.action === "deliver"
                    ? API.wardDeliverNotice(item.ward, item.booth, item.voterIds)
                    : API.wardUndeliverNotice(item.ward, item.booth, item.voterIds));
            }

            if (res?.error) {
                if (res.detail === "Network error") {
                    remaining.push(item); // still offline — keep in queue
                } else {
                    failed.push({ ...item, failReason: res.detail }); // server error — log and drop
                }
            }
            // success: drop from queue
        }

        this.save(remaining);

        if (failed.length) {
            API.post("/api/notice/sync-failures", {
                failures: failed.map(i => ({
                    ward: i.ward, booth: i.booth, voter_ids: i.voterIds,
                    action: i.action, by_phone: i.myPhone, by_name: i.myName,
                    attempted_at: i.myTime, failed_at: new Date().toISOString(),
                    fail_reason: i.failReason,
                })),
            });
        }

        // Clear _pending flags if queue is now empty
        if (!remaining.length) {
            [Notice.boothNoticeFamiliesAll, Notice.wardNoticeFamiliesAll].forEach(arr =>
                (arr || []).forEach(fam => fam.members.forEach(m => { m._pending = false; }))
            );
            Notice._applyBoothNoticeFilters?.(true);
            Notice._applyWardNoticeFilters?.(true);
        }

        this._updateBanner();
    },

    _updateBanner() {
        const count = this.load().length;
        const banner = document.getElementById("notice-sync-banner");
        if (!banner) return;
        if (count > 0) {
            banner.textContent = `⟳ ${count} notice update${count > 1 ? "s" : ""} pending sync`;
            banner.style.display = "block";
        } else {
            banner.style.display = "none";
        }
    },

    init() {
        window.addEventListener("online", () => this.drain());
        setInterval(() => this.drain(), 30000);
        this._updateBanner();
        // drain() called later from App.initForRole() once user is confirmed
    },

    startDrain() {
        this.drain(); // called after login confirmed
    },
};
