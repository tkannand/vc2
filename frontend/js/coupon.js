const Coupon = {
    couponEnabled: false,

    async checkEnabled() {
        const res = await API.getCouponEnabled();
        this.couponEnabled = res.enabled === true;
        return this.couponEnabled;
    },

    // Booth state
    boothCouponFamiliesAll: [],
    boothCouponFamilies: [],
    boothCouponPage: 0,
    pendingFamilyVoters: [],
    editingFamcode: null,
    _modalEditFamcode: null,
    _modalEditBooth: null,

    // Ward state
    wardCouponFamiliesAll: [],
    wardCouponFamilies: [],
    wardCouponPage: 0,
    wardPendingFamilyVoters: [],
    wardEditingFamcode: null,
    wardEditingBooth: "",

    // Admin state
    adminCouponWard: "",
    adminCouponBooth: "",
    adminCouponFamiliesAll: [],
    adminCouponFamilies: [],
    adminCouponPage: 0,

    PAGE_SIZE: 15,

    _sortByQuery(matches, q) {
        return matches.sort((a, b) => {
            const score = m => {
                const vid = (m.voter_id || "").toLowerCase();
                const sl  = (m.sl || "").toLowerCase();
                if (vid.startsWith(q)) return 0;
                if (sl.startsWith(q))  return 1;
                if (vid.includes(q))   return 2;
                if (sl.includes(q))    return 3;
                return 4; // name match
            };
            return score(a) - score(b);
        });
    },

    _hl(text, q) { return Notice._hl(text, q); },

    // ═══ BOOTH ═══════════════════════════════════════════════════

    async initBooth() {
        const user = App.getUser();
        if (!user) return;
        this.boothCouponFamiliesAll = [];
        this.boothCouponFamilies = [];
        this.boothCouponPage = 0;
        this.pendingFamilyVoters = [];
        this.editingFamcode = null;
        this._bindBoothCouponTabs();
        this._bindBoothCouponFilters();
        this._bindBoothCouponNav();
        this._bindOtherTab();
        await this._loadBoothFamilies();
    },

    async _loadBoothFamilies() {
        const user = App.getUser();
        App.showViewLoading("view-booth-coupon");
        const res = await API.getCouponFamilies(user.ward, user.booth);
        App.hideViewLoading("view-booth-coupon");
        if (res.error) { App.showToast(res.detail || "Failed to load"); return; }

        this.boothCouponFamiliesAll = res.families || [];

        // Populate street filter
        const streetSel = document.getElementById("booth-coupon-street");
        streetSel.innerHTML = `<option value="">All Streets</option>`;
        (res.streets || []).forEach(s => {
            const o = document.createElement("option");
            o.value = s; o.textContent = s; streetSel.appendChild(o);
        });

        this._applyBoothFilters();
    },

    _applyBoothFilters(keepPage = false) {
        const search = (document.getElementById("booth-coupon-search")?.value || "").toLowerCase().trim();
        const street = document.getElementById("booth-coupon-street")?.value || "";

        let filtered = this.boothCouponFamiliesAll;
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
        this.boothCouponFamilies = filtered;
        if (!keepPage) this.boothCouponPage = 0;
        this._renderBoothFamilies();
        this._refreshBoothSummary();
    },

    _makeSummaryHtml(delivered, total, label) {
        if (!total) return "";
        return `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} Delivered</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} ${label || "Total"}</span>
            <span class="notice-summary-pct">${Math.round(delivered / total * 100)}%</span>
        </div>`;
    },

    _refreshBoothSummary() {
        // Overall (above tabs)
        const allMembers = this.boothCouponFamiliesAll.flatMap(f => f.members);
        const totalDel = allMembers.filter(m => m.coupon_status === "delivered").length;
        const overallBar = document.getElementById("booth-coupon-summary");
        if (overallBar) overallBar.innerHTML = this._makeSummaryHtml(totalDel, allMembers.length, "Total");

        // Family panel — only grouped families (multi-person or custom), not ungrouped/ejected singles
        const isGrouped = f => f.is_custom || f.members.length > 1 || (f.famcode !== f.members[0]?.voter_id);
        const famMembers = this.boothCouponFamilies.filter(isGrouped).flatMap(f => f.members);
        const famDel = famMembers.filter(m => m.coupon_status === "delivered").length;
        const famBar = document.getElementById("booth-coupon-family-summary");
        if (famBar) famBar.innerHTML = this._makeSummaryHtml(famDel, famMembers.length, "in families");

        // Other panel — ungrouped members
        const ungrouped = this.boothCouponFamiliesAll.filter(f => !f.is_custom && f.members.length === 1 && f.famcode === f.members[0]?.voter_id).flatMap(f => f.members);
        const otherDel = ungrouped.filter(m => m.coupon_status === "delivered").length;
        const otherBar = document.getElementById("booth-coupon-other-summary");
        if (otherBar) otherBar.innerHTML = this._makeSummaryHtml(otherDel, ungrouped.length, "Ungrouped");
    },

    _renderBoothFamilies() {
        const area  = document.getElementById("booth-coupon-family-area");
        const nav   = document.getElementById("booth-coupon-nav");
        const empty = document.getElementById("booth-coupon-empty");
        const ps = this.PAGE_SIZE;
        const total = this.boothCouponFamilies.length;

        if (total === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            if (empty) { empty.style.display = "block"; empty.querySelector("p").textContent = "No families found."; }
            return;
        }
        if (empty) empty.style.display = "none";

        const pages = Math.ceil(total / ps);
        const pg = Math.min(this.boothCouponPage, pages - 1);
        this.boothCouponPage = pg;

        document.getElementById("booth-coupon-counter").textContent = `${pg + 1} / ${pages}`;
        document.getElementById("btn-bcp-prev").disabled = pg === 0;
        document.getElementById("btn-bcp-next").disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";

        const q = (document.getElementById("booth-coupon-search")?.value || "").trim();
        const slice = this.boothCouponFamilies.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this._buildCouponCard(fam, q, "booth")).join("");
        this._bindBoothCardActions(area);
    },

    _buildCouponCard(fam, query, mode) {
        const isTamil = I18n.currentLang === "ta";
        const members = fam.members || [];
        const deliveredCount = members.filter(m => m.coupon_status === "delivered").length;
        const allDelivered = deliveredCount === members.length;

        let html = `<div class="family-card ncc">`;

        // Header
        html += `<div class="ncc-header">`;
        html += `<div class="ncc-header-left">`;
        html += `<span class="ncc-house">🏠 ${Notice.escapeHtml(fam.house || "-")}</span>`;
        html += `<span class="ncc-count">(${members.length})</span>`;
        const secDisp = (isTamil && fam.section_ta) ? fam.section_ta : fam.section;
        if (secDisp) html += `<span class="ncc-section">${Notice._hl(secDisp, query)}</span>`;
        if (deliveredCount > 0) {
            html += `<span class="ncc-progress ${allDelivered ? "ncc-progress-full" : ""}">${deliveredCount}/${members.length} ✓</span>`;
        }
        html += `</div>`;
        const editSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        html += `<div style="display:flex;gap:6px;align-items:center;">`;
        html += `<button class="btn btn-secondary btn-sm" data-edit-famcode="${fam.famcode}" style="padding:4px 8px;display:flex;align-items:center;">${editSvg}</button>`;
        html += `<button class="btn ${allDelivered ? "btn-success" : "btn-primary"} btn-sm coupon-deliver-all" data-famcode="${fam.famcode}" data-mode="${mode}">`;
        html += allDelivered ? "Undo All" : "Mark Done";
        html += `</button></div></div>`;

        // Members
        members.forEach(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const isDelivered = m.coupon_status === "delivered";
            const isHOF = m.is_head === "Yes";
            const deliverer = isDelivered ? (m.delivered_by_name || (m.delivered_by ? "···" + m.delivered_by.slice(-4) : "")) : "";
            const timeStr = isDelivered && m.delivered_at ? (() => {
                const d = new Date(m.delivered_at);
                return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
            })() : "";

            html += `<div class="ncc-member" data-voter="${m.voter_id}">`;
            html += `<div class="ncc-member-summary">`;
            html += `<div class="ncc-member-left">`;
            if (m.sl) html += `<span class="ncc-sl">${Notice._hl(m.sl, query)}</span>`;
            html += `<span class="ncc-name ${isDelivered ? "ncc-name-done" : ""}">${Notice._hl(name, query)}`;
            if (isHOF) html += ` <span class="member-head-badge">👑</span>`;
            html += `</span>`;
            if (isDelivered && deliverer) html += `<span class="ncc-by">✓ ${Notice.escapeHtml(deliverer)}${timeStr ? " · " + timeStr : ""}</span>`;
            html += `</div>`;
            html += `<label class="notice-toggle ncc-toggle" onclick="event.stopPropagation()">`;
            html += `<input type="checkbox" data-voter-id="${m.voter_id}" data-mode="${mode}" ${isDelivered ? "checked" : ""}/>`;
            html += `<span class="notice-toggle-label">${isDelivered ? "✓ Delivered" : "● Pending"}</span>`;
            html += `</label>`;
            html += `</div>`;
            html += `<div class="ncc-details">`;
            if (m.voter_id) html += `<span class="ncc-detail"><span class="label">EPIC:</span> ${Notice._hl(m.voter_id, query)}</span>`;
            if (m.sl) html += `<span class="ncc-detail"><span class="label">SL:</span> ${Notice._hl(m.sl, query)}</span>`;
            html += `<span class="ncc-detail">${m.age} · ${m.gender === "Male" ? "M" : "F"}</span>`;
            if (m.relation_type) html += `<span class="ncc-detail">${Notice.escapeHtml(m.relation_type)} – ${Notice.escapeHtml(isTamil ? (m.relation_name_ta || m.relation_name || "-") : (m.relation_name || "-"))}</span>`;
            html += `</div>`;
            html += `</div>`;
        });

        html += `</div>`;
        return html;
    },

    _bindBoothCardActions(area) {
        // Expand/collapse
        area.querySelectorAll(".ncc-member-summary").forEach(row => {
            row.addEventListener("click", e => {
                if (e.target.closest(".ncc-toggle")) return;
                const details = row.nextElementSibling;
                if (details?.classList.contains("ncc-details")) details.classList.toggle("ncc-details-open");
            });
        });

        // Individual toggles
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
                await this._boothToggleCoupon([cb.dataset.voterId], action);
            });
        });

        // Deliver all
        area.querySelectorAll(".coupon-deliver-all").forEach(btn => {
            btn.addEventListener("click", async () => {
                const fam = this.boothCouponFamiliesAll.find(f => f.famcode === btn.dataset.famcode);
                if (!fam) return;
                const allDone = fam.members.every(m => m.coupon_status === "delivered");
                if (allDone) {
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    btn.disabled = true;
                    await this._boothToggleCoupon(fam.members.map(m => m.voter_id), "undeliver");
                } else {
                    btn.disabled = true;
                    await this._boothToggleCoupon(fam.members.filter(m => m.coupon_status !== "delivered").map(m => m.voter_id), "deliver");
                }
            });
        });

        // Edit family buttons
        area.querySelectorAll("[data-edit-famcode]").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                this._openEditFamily(btn.dataset.editFamcode);
            });
        });
    },

    async _boothToggleCoupon(voterIds, action) {
        const user = App.getUser();
        const newStatus = action === "deliver" ? "delivered" : "not_delivered";
        const idSet = new Set(voterIds);
        const me = App.getUser();
        const myName = me?.name || "";
        const myTime = new Date().toISOString();

        const res = await (action === "deliver"
            ? API.deliverCoupon(user.ward, user.booth, voterIds)
            : API.undeliverCoupon(user.ward, user.booth, voterIds));

        if (res && res.error) {
            this._applyBoothFilters(true);
            App.showToast(res.detail || "Failed to update");
            return;
        }

        this.boothCouponFamiliesAll.forEach(fam => fam.members.forEach(m => {
            if (idSet.has(m.voter_id)) {
                m.coupon_status = newStatus;
                if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
            }
        }));
        this._applyBoothFilters(true);
    },

    // ── Edit custom family ──────────────────────────────────────

    _openEditFamily(famcode) {
        const fam = this.boothCouponFamiliesAll.find(f => f.famcode === famcode);
        if (!fam) return;
        this._openFamilyBuilderModal(fam.members, "booth", { famcode, booth: fam.booth || "" });
    },

    _bindEditSearch() {
        const searchEl = document.getElementById("booth-coupon-edit-search");
        if (!searchEl) return;
        const n = searchEl.cloneNode(true); searchEl.parentNode.replaceChild(n, searchEl);
        n.value = "";
        document.getElementById("booth-coupon-edit-results").innerHTML = "";
        n.addEventListener("input", () => {
            const q = (n.value || "").toLowerCase().trim();
            const resultsEl = document.getElementById("booth-coupon-edit-results");
            if (!q || q.length < 1) { resultsEl.innerHTML = ""; return; }
            const isTamil = I18n.currentLang === "ta";
            const fam = this.boothCouponFamiliesAll.find(f => f.famcode === this.editingFamcode);
            const currentIds = new Set((fam?.members || []).map(m => m.voter_id));
            const matches = [];
            for (const f of this.boothCouponFamiliesAll) {
                for (const m of f.members) {
                    if (currentIds.has(m.voter_id)) continue;
                    const name = (isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "")).toLowerCase();
                    if (name.includes(q) || (m.sl || "").toLowerCase().includes(q) || (m.voter_id || "").toLowerCase().includes(q)) {
                        matches.push({ ...m, _fromFamcode: f.famcode });
                    }
                    if (matches.length >= 20) break;
                }
                if (matches.length >= 20) break;
            }
            if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>No results</p></div>`; return; }
            resultsEl.innerHTML = matches.map(m => {
                const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
                return `<div class="other-search-row">
                    <div class="ncc-member-left"><span class="ncc-sl">${m.sl || ""}</span><span class="ncc-name">${Notice.escapeHtml(name)}</span></div>
                    <button class="btn btn-primary btn-sm btn-edit-add-member" data-voter='${JSON.stringify({voter_id: m.voter_id, name, sl: m.sl || "", from_famcode: m._fromFamcode})}'>+ Add</button>
                </div>`;
            }).join("");
            resultsEl.querySelectorAll(".btn-edit-add-member").forEach(btn => {
                btn.addEventListener("click", () => {
                    try {
                        const v = JSON.parse(btn.dataset.voter);
                        const fam = this.boothCouponFamiliesAll.find(f => f.famcode === this.editingFamcode);
                        if (!fam) return;
                        // Build member object from boothCouponFamiliesAll
                        const srcFam = this.boothCouponFamiliesAll.find(f => f.famcode === v.from_famcode);
                        const member = srcFam?.members.find(m => m.voter_id === v.voter_id);
                        if (member) fam.members.push(member);
                        this._renderEditPanel(fam);
                        // Clear search
                        n.value = "";
                        resultsEl.innerHTML = "";
                    } catch {}
                });
            });
        });
    },

    _renderEditPanel(fam) {
        const isTamil = I18n.currentLang === "ta";
        const list = document.getElementById("booth-coupon-edit-members");
        list.innerHTML = (fam.members || []).map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            return `<div class="edit-member-row" data-voter="${m.voter_id}">
                <span class="ncc-sl">${m.sl || ""}</span>
                <span class="ncc-name">${Notice.escapeHtml(name)}</span>
                <button class="btn btn-danger btn-sm btn-remove-member" data-voter="${m.voter_id}">✕</button>
            </div>`;
        }).join("");

        list.querySelectorAll(".btn-remove-member").forEach(btn => {
            btn.addEventListener("click", async () => {
                const ok = await Notice.confirmUndeliver("confirm_remove_member");
                if (!ok) return;
                const vid = btn.dataset.voter;
                const fam = this.boothCouponFamiliesAll.find(f => f.famcode === this.editingFamcode);
                if (fam) { fam.members = fam.members.filter(m => m.voter_id !== vid); this._renderEditPanel(fam); }
            });
        });
    },

    _bindBoothCouponTabs() {
        document.querySelectorAll("#view-booth-coupon .tabs .tab").forEach(tab => {
            tab.addEventListener("click", () => {
                document.querySelectorAll("#view-booth-coupon .tabs .tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                const isFamily = tab.dataset.couponTab === "family";
                document.getElementById("booth-coupon-family-panel").style.display = isFamily ? "block" : "none";
                document.getElementById("booth-coupon-other-panel").style.display = isFamily ? "none" : "block";
                if (!isFamily) {
                    this.pendingFamilyVoters = [];
                    this._renderPendingFamily();
                    this._syncOtherStreets();
                    this._renderOtherList("");
                    this._refreshBoothSummary();
                }
            });
        });
    },

    _bindBoothCouponFilters() {
        const cloneEl = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const search = cloneEl("booth-coupon-search");
        const street = cloneEl("booth-coupon-street");
        if (search) search.addEventListener("input", () => this._applyBoothFilters());
        if (street) street.addEventListener("change", () => this._applyBoothFilters());
    },

    _bindBoothCouponNav() {
        const prev = document.getElementById("btn-bcp-prev");
        const next = document.getElementById("btn-bcp-next");
        if (prev) prev.addEventListener("click", () => {
            if (this.boothCouponPage > 0) { this.boothCouponPage--; this._renderBoothFamilies(); document.getElementById("main-content").scrollTop = 0; }
        });
        if (next) next.addEventListener("click", () => {
            const pages = Math.ceil(this.boothCouponFamilies.length / this.PAGE_SIZE);
            if (this.boothCouponPage < pages - 1) { this.boothCouponPage++; this._renderBoothFamilies(); document.getElementById("main-content").scrollTop = 0; }
        });

        // Edit panel nav
        const backBtn = document.getElementById("btn-bcp-edit-back");
        if (backBtn) backBtn.addEventListener("click", () => {
            document.getElementById("booth-coupon-edit-panel").style.display = "none";
            document.getElementById("booth-coupon-family-panel").style.display = "block";
            this.editingFamcode = null;
        });

        const saveBtn = document.getElementById("btn-bcp-edit-save");
        if (saveBtn) saveBtn.addEventListener("click", async () => {
            if (!this.editingFamcode) return;
            const fam = this.boothCouponFamiliesAll.find(f => f.famcode === this.editingFamcode);
            if (!fam) return;
            const user = App.getUser();
            App.setBtnLoading(saveBtn, true);
            const res = await API.updateCouponFamily(user.ward, user.booth, this.editingFamcode, fam.members.map(m => m.voter_id));
            App.setBtnLoading(saveBtn, false);
            if (res.error) { App.showToast(res.detail || "Failed to save"); return; }
            App.showToast("Family updated");
            document.getElementById("booth-coupon-edit-panel").style.display = "none";
            document.getElementById("booth-coupon-family-panel").style.display = "block";
            this.editingFamcode = null;
            await this._loadBoothFamilies();
        });
    },

    // ── Other tab (search + create family) ─────────────────────

    _bindOtherTab() {
        const searchEl = document.getElementById("booth-coupon-other-search");
        if (searchEl) searchEl.addEventListener("input", () => this._searchOtherVoters());

        const streetEl = document.getElementById("booth-coupon-other-street");
        if (streetEl) streetEl.addEventListener("change", () => this._searchOtherVoters());

        // Family builder modal
        this._bindFamilyBuilderModal("booth");
    },

    _syncOtherStreets() {
        // Copy streets from the Family tab street filter into Other tab street filter
        const src = document.getElementById("booth-coupon-street");
        const dst = document.getElementById("booth-coupon-other-street");
        if (!src || !dst) return;
        dst.innerHTML = `<option value="">All Streets</option>`;
        Array.from(src.options).slice(1).forEach(opt => {
            const o = document.createElement("option");
            o.value = opt.value; o.textContent = opt.textContent; dst.appendChild(o);
        });
    },

    _clearOtherSearch() {
        const el = document.getElementById("booth-coupon-other-search");
        if (el) el.value = "";
        this.pendingFamilyVoters = [];
        this._renderPendingFamily();
        this._renderOtherList("");
    },

    _renderOtherList(q) {
        const resultsEl = document.getElementById("booth-coupon-other-results");
        if (!resultsEl) return;
        const isTamil = I18n.currentLang === "ta";
        const pendingIds = new Set(this.pendingFamilyVoters.map(v => v.voter_id));
        const qLow = q.toLowerCase();
        const streetFilter = document.getElementById("booth-coupon-other-street")?.value || "";

        let voters = [];
        for (const fam of this.boothCouponFamiliesAll) {
            for (const m of fam.members) {
                if (streetFilter && m.section !== streetFilter) continue;
                const isUngrouped = !fam.is_custom && fam.members.length === 1 && fam.famcode === m.voter_id;
                const isCustom = fam.is_custom;
                if (!qLow) {
                    if (isUngrouped) voters.push({ ...m, in_custom_family: isCustom ? fam.famcode : "" });
                } else {
                    const name = (isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "")).toLowerCase();
                    if (name.includes(qLow) || (m.sl || "").toLowerCase().includes(qLow) || (m.voter_id || "").toLowerCase().includes(qLow)) {
                        voters.push({ ...m, in_custom_family: isCustom ? fam.famcode : "" });
                    }
                }
            }
        }

        if (!voters.length) {
            resultsEl.innerHTML = `<div class="empty-state"><p>${qLow ? "No results" : "No ungrouped voters"}</p></div>`;
            return;
        }

        if (qLow) this._sortByQuery(voters, qLow);

        resultsEl.innerHTML = voters.map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const inPending = pendingIds.has(m.voter_id);
            const tag = m.in_custom_family ? `<span class="notice-tag notice-tag-partial">Custom fam</span>` : "";
            return `<div class="other-search-row">
                <div class="ncc-member-left">
                    <span class="ncc-sl">${this._hl(m.sl || "", qLow)}</span>
                    <span class="ncc-name">${this._hl(name, qLow)} ${tag}</span>
                    ${qLow ? `<span style="font-size:0.65rem;color:var(--text-muted)">${this._hl(m.voter_id || "", qLow)}</span>` : ""}
                </div>
                <button class="btn btn-sm ${inPending ? "btn-success" : "btn-primary"} btn-add-to-pending"
                    data-voter='${JSON.stringify({voter_id: m.voter_id, name, sl: m.sl || "", in_custom_family: m.in_custom_family || ""})}'
                    ${inPending ? "disabled" : ""}>
                    ${inPending ? "✓ Added" : "+ Add"}
                </button>
            </div>`;
        }).join("");

        resultsEl.querySelectorAll(".btn-add-to-pending").forEach(btn => {
            btn.addEventListener("click", () => {
                try { this._addToPending(JSON.parse(btn.dataset.voter)); } catch {}
            });
        });
    },

        _searchOtherVoters() {
        const q = (document.getElementById("booth-coupon-other-search")?.value || "").trim();
        this._renderOtherList(q);
    },

    _addToPending(voter) {
        // Open the modal with this voter pre-loaded
        this._openFamilyBuilderModal([voter], "booth");
    },

    _bindFamilyBuilderModal() { /* bindings now handled per-open in _openFamilyBuilderModal */ },

    // editOpts: { famcode, booth } for edit mode, null for create mode
    _openFamilyBuilderModal(initialVoters, mode, editOpts = null) {
        this.pendingFamilyVoters = initialVoters.map(m => ({
            voter_id: m.voter_id,
            name: (I18n.currentLang === "ta" ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "")),
            sl: m.sl || "",
            booth: m.booth || "",
        }));
        this._modalEditFamcode = editOpts?.famcode || null;
        this._modalEditBooth   = editOpts?.booth   || null;

        document.getElementById("modal-coupon-family-builder").style.display = "flex";
        document.getElementById("coupon-builder-search-results").innerHTML = "";

        // Update title and button label
        const title = document.querySelector("#modal-coupon-family-builder h3");
        if (title) title.textContent = editOpts ? "Edit Family" : "Build Family";

        const clone = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const cancel  = clone("btn-coupon-builder-cancel");
        const overlay = clone("btn-coupon-builder-close-overlay");
        const submit  = clone("btn-coupon-builder-submit");
        const search  = clone("coupon-builder-search");
        const searchMode = clone("coupon-builder-search-mode");

        if (submit) submit.textContent = editOpts ? "Save Changes" : "Create Family";
        if (cancel)  cancel.addEventListener("click",  () => this._closeFamilyBuilderModal());
        if (overlay) overlay.addEventListener("click", () => this._closeFamilyBuilderModal());
        if (submit)  submit.addEventListener("click",  () => this._submitFamilyFromModal(mode));

        // Search mode dropdown
        if (searchMode) {
            searchMode.value = "voter_id";
            searchMode.addEventListener("change", () => {
                const isVoterId = searchMode.value === "voter_id";
                if (search) {
                    search.placeholder = isVoterId ? I18n.t("search_voter_id_placeholder") : I18n.t("search_sl_placeholder");
                    search.value = "";
                }
                document.getElementById("coupon-builder-search-results").innerHTML = "";
            });
        }

        if (search)  {
            search.value = "";
            search.placeholder = I18n.t("search_voter_id_placeholder");
            let _bt;
            search.addEventListener("input", () => {
                clearTimeout(_bt);
                _bt = setTimeout(() => this._builderSearch(mode), 350);
            });
        }

        this._renderBuilderPending(mode);
        setTimeout(() => document.getElementById("coupon-builder-search")?.focus(), 150);
    },

    _closeFamilyBuilderModal() {
        document.getElementById("modal-coupon-family-builder").style.display = "none";
        this.pendingFamilyVoters = [];
        this._modalEditFamcode = null;
        this._modalEditBooth = null;
        this._searchOtherVoters();
    },

    _renderBuilderPending(mode) {
        const list = document.getElementById("coupon-builder-pending-list");
        const submitBtn = document.getElementById("btn-coupon-builder-submit");
        if (!list) return;
        if (!this.pendingFamilyVoters.length) {
            list.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:4px 0;">No members yet</div>`;
            if (submitBtn) submitBtn.disabled = true;
            return;
        }
        if (submitBtn) submitBtn.disabled = false;
        list.innerHTML = this.pendingFamilyVoters.map(v => `
            <div class="edit-member-row">
                <span class="ncc-sl">${v.sl || ""}</span>
                <span class="ncc-name">${Notice.escapeHtml(v.name || v.voter_id)}</span>
                <button class="btn btn-danger btn-sm btn-remove-builder" data-voter="${v.voter_id}">✕</button>
            </div>`).join("");
        list.querySelectorAll(".btn-remove-builder").forEach(btn => {
            btn.addEventListener("click", () => {
                this.pendingFamilyVoters = this.pendingFamilyVoters.filter(v => v.voter_id !== btn.dataset.voter);
                this._renderBuilderPending(mode);
                this._builderSearch(mode);
            });
        });
    },

    async _builderSearch(mode) {
        const searchMode = document.getElementById("coupon-builder-search-mode")?.value || "voter_id";
        if (searchMode === "sl") {
            this._builderSearchBySl(mode);
        } else {
            await this._builderSearchByVoterId(mode);
        }
    },

    // Search by Voter ID — global API search (original behavior)
    async _builderSearchByVoterId(mode) {
        const q = (document.getElementById("coupon-builder-search")?.value || "").trim();
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        if (!q || q.length < 3) {
            resultsEl.innerHTML = q.length > 0 ? `<div class="empty-state"><p>Type ${3 - q.length} more character${3 - q.length > 1 ? "s" : ""}…</p></div>` : "";
            return;
        }
        resultsEl.innerHTML = `<div style="padding:8px;color:var(--text-muted);font-size:0.8rem;">${I18n.t("searching")}</div>`;
        const pendingIds = new Set(this.pendingFamilyVoters.map(v => v.voter_id));
        const res = await API.searchCouponVoters(q);
        if (res.error) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("search_failed")}</p></div>`; return; }
        const matches = (res.results || []).filter(m => !pendingIds.has(m.voter_id));
        if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("no_results")}</p></div>`; return; }
        const qLow = q.toLowerCase();
        this._renderBuilderSearchResults(matches, qLow, mode);
    },

    // Search by SL — local search within already loaded data
    _builderSearchBySl(mode) {
        const q = (document.getElementById("coupon-builder-search")?.value || "").trim();
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        if (!q) { resultsEl.innerHTML = ""; return; }

        // Get loaded data from the current coupon mode
        const allFams = mode === "booth" ? this.boothCouponFamiliesAll
            : mode === "ward" ? this.wardCouponFamiliesAll
            : this.adminCouponFamiliesAll;

        const allMembers = (allFams || []).flatMap(f => (f.members || []).map(m => ({ ...m, booth: m.booth || f.booth || "", ward: m.ward || "" })));

        const pendingIds = new Set(this.pendingFamilyVoters.map(v => v.voter_id));
        const qLow = q.toLowerCase();
        const matches = allMembers
            .filter(m => (m.sl || "").toLowerCase().includes(qLow) && !pendingIds.has(m.voter_id))
            .slice(0, 10);

        if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("no_results")}</p></div>`; return; }
        this._renderBuilderSearchResults(matches, qLow, mode);
    },

    // Shared renderer for builder search results
    _renderBuilderSearchResults(matches, qLow, mode) {
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        const isTamil = I18n.currentLang === "ta";
        resultsEl.innerHTML = matches.map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const wardBooth = [m.ward, m.booth].filter(Boolean).join(" · ");
            return `<div class="other-search-row">
                <div class="ncc-member-left">
                    <span class="ncc-sl">${this._hl(m.sl || "", qLow)}</span>
                    <span class="ncc-name">${this._hl(name, qLow)}</span>
                    <span style="font-size:0.65rem;color:var(--text-muted)">${this._hl(m.voter_id || "", qLow)}${wardBooth ? " · " + wardBooth : ""}</span>
                </div>
                <button class="btn btn-primary btn-sm btn-builder-add" data-voter='${JSON.stringify({voter_id: m.voter_id, name, sl: m.sl || "", booth: m.booth || "", ward: m.ward || ""})}'>+ Add</button>
            </div>`;
        }).join("");
        resultsEl.querySelectorAll(".btn-builder-add").forEach(btn => {
            btn.addEventListener("click", () => {
                try {
                    const v = JSON.parse(btn.dataset.voter);
                    if (!this.pendingFamilyVoters.find(p => p.voter_id === v.voter_id)) {
                        this.pendingFamilyVoters.push(v);
                        this._renderBuilderPending(mode);
                        this._builderSearch(mode);
                    }
                } catch {}
            });
        });
    },

    async _submitFamilyFromModal(mode) {
        if (!this.pendingFamilyVoters.length) return;
        const user = App.getUser();
        const submitBtn = document.getElementById("btn-coupon-builder-submit");
        if (submitBtn) App.setBtnLoading(submitBtn, true);
        const booth = this._modalEditBooth
            || (mode === "ward" ? (this.pendingFamilyVoters[0]?.booth || document.getElementById("ward-coupon-other-booth")?.value || "") : user.booth);
        const voterIds = this.pendingFamilyVoters.map(v => v.voter_id);
        // Always send full member data so cross-ward/booth voters display correctly
        const membersData = this.pendingFamilyVoters.map(v => ({
            voter_id: v.voter_id, name: v.name || "", name_en: v.name_en || v.name || "",
            name_ta: v.name_ta || "", sl: v.sl || "", booth: v.booth || booth,
            ward: v.ward || user.ward, section: v.section || "", house: v.house || "",
            famcode: v.famcode || "", is_head: v.is_head || "No",
            age: v.age || 0, gender: v.gender || "",
        }));
        const res = this._modalEditFamcode
            ? await API.updateCouponFamily(user.ward, booth, this._modalEditFamcode, voterIds, membersData)
            : await API.createCouponFamily(user.ward, booth, voterIds, membersData);
        if (submitBtn) App.setBtnLoading(submitBtn, false);
        if (res.error) { App.showToast(res.detail || "Failed"); return; }
        App.showToast(this._modalEditFamcode ? "Family updated!" : "Family created!");
        document.getElementById("modal-coupon-family-builder").style.display = "none";
        this.pendingFamilyVoters = [];
        if (mode === "ward") {
            document.querySelectorAll("#view-ward-coupon .tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.couponTab === "family"));
            document.getElementById("ward-coupon-family-panel").style.display = "block";
            document.getElementById("ward-coupon-other-panel").style.display = "none";
            await this._loadWardFamilies();
        } else {
            document.querySelectorAll("#view-booth-coupon .tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.couponTab === "family"));
            document.getElementById("booth-coupon-family-panel").style.display = "block";
            document.getElementById("booth-coupon-other-panel").style.display = "none";
            await this._loadBoothFamilies();
        }
    },

    // kept for compatibility — no longer used by booth flow
    _renderPendingFamily() {},

    // ── Booth stats ─────────────────────────────────────────────

    async loadBoothCouponStats() {
        const user = App.getUser();
        App.showViewLoading("view-booth-coupon-stats");
        const res = await API.getCouponBoothStats(user.ward, user.booth);
        App.hideViewLoading("view-booth-coupon-stats");
        if (res.error) return;
        const cards = document.getElementById("booth-coupon-stats-cards");
        cards.innerHTML = `
            <div class="stat-card accent"><div class="stat-value">${res.total}</div><div class="stat-label">Total</div></div>
            <div class="stat-card success"><div class="stat-value">${res.delivered}</div><div class="stat-label">Delivered</div></div>
            <div class="stat-card warning"><div class="stat-value">${res.pending}</div><div class="stat-label">Pending</div></div>
            <div class="stat-card wide">
                <div class="stat-label">Completion — ${res.completion_pct}%</div>
                <div class="progress-bar-container"><div class="progress-bar" style="width:${res.completion_pct}%;background:var(--success)"></div></div>
            </div>`;
    },

    // ═══ WARD ═════════════════════════════════════════════════════

    async initWard() {
        this.wardCouponFamiliesAll = [];
        this.wardCouponFamilies = [];
        this.wardCouponPage = 0;
        this.wardPendingFamilyVoters = [];
        this.wardEditingFamcode = null;
        this.wardEditingBooth = "";
        this._bindWardCouponTabs();
        this._bindWardCouponFilters();
        this._bindWardCouponNav();
        this._bindWardOtherTab();
        await this._loadWardBooths();
        await this._loadWardFamilies();
    },

    async _loadWardBooths() {
        const user = App.getUser();
        const boothSel = document.getElementById("ward-coupon-booth");
        if (!boothSel) return;
        boothSel.innerHTML = `<option value="">All Booths</option>`;
        const res = await API.getNoticeWardBooths(user.ward);
        if (res.error) return;
        (res.booths || []).forEach(b => {
            const o = document.createElement("option");
            const val = typeof b === "object" ? b.booth : b;
            const label = typeof b === "object" ? (Ward.formatBoothLabel(b.booth_name, b.booth_number, 35, b.booth_name_tamil) || val) : val;
            o.value = val; o.textContent = label; boothSel.appendChild(o);
        });
    },

    
    async _loadWardFamilies() {
        const user = App.getUser();
        const booth = document.getElementById("ward-coupon-booth")?.value || "";
        App.showViewLoading("view-ward-coupon");
        const res = await API.getCouponWardFamilies(user.ward, booth);
        App.hideViewLoading("view-ward-coupon");
        if (res.error) { App.showToast(res.detail || "Failed to load"); return; }

        this.wardCouponFamiliesAll = res.families || [];

        const streetSel = document.getElementById("ward-coupon-street");
        if (streetSel) {
            streetSel.innerHTML = `<option value="">All Streets</option>`;
            (res.streets || []).forEach(s => {
                const o = document.createElement("option");
                o.value = s; o.textContent = s; streetSel.appendChild(o);
            });
        }
        this._applyWardFilters();
    },

    _applyWardFilters(keepPage = false) {
        const search = (document.getElementById("ward-coupon-search")?.value || "").toLowerCase().trim();
        const street = document.getElementById("ward-coupon-street")?.value || "";
        let filtered = this.wardCouponFamiliesAll;
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
        }
        this.wardCouponFamilies = filtered;
        if (!keepPage) this.wardCouponPage = 0;
        this._renderWardFamilies();
        this._refreshWardSummary();
    },

    _refreshWardSummary() {
        // Overall (above tabs)
        const allMembers = this.wardCouponFamiliesAll.flatMap(f => f.members);
        const totalDel = allMembers.filter(m => m.coupon_status === "delivered").length;
        const overallBar = document.getElementById("ward-coupon-summary");
        if (overallBar) overallBar.innerHTML = this._makeSummaryHtml(totalDel, allMembers.length, "Total");

        // Family panel — only grouped families (multi-person or custom), not ungrouped/ejected singles
        const isGrouped = f => f.is_custom || f.members.length > 1 || (f.famcode !== f.members[0]?.voter_id);
        const famMembers = this.wardCouponFamilies.filter(isGrouped).flatMap(f => f.members);
        const famDel = famMembers.filter(m => m.coupon_status === "delivered").length;
        const famBar = document.getElementById("ward-coupon-family-summary");
        if (famBar) famBar.innerHTML = this._makeSummaryHtml(famDel, famMembers.length, "in families");

        // Other panel — ungrouped
        const ungrouped = this.wardCouponFamiliesAll.filter(f => !f.is_custom && f.members.length === 1 && f.famcode === f.members[0]?.voter_id).flatMap(f => f.members);
        const otherDel = ungrouped.filter(m => m.coupon_status === "delivered").length;
        const otherBar = document.getElementById("ward-coupon-other-summary");
        if (otherBar) otherBar.innerHTML = this._makeSummaryHtml(otherDel, ungrouped.length, "Ungrouped");
    },

    _renderWardFamilies() {
        const area  = document.getElementById("ward-coupon-family-area");
        const nav   = document.getElementById("ward-coupon-nav");
        const ps = this.PAGE_SIZE;
        const total = this.wardCouponFamilies.length;
        if (total === 0) { area.innerHTML = ""; nav.style.display = "none"; return; }
        const pages = Math.ceil(total / ps);
        const pg = Math.min(this.wardCouponPage, pages - 1);
        this.wardCouponPage = pg;
        document.getElementById("ward-coupon-counter").textContent = `${pg + 1} / ${pages}`;
        document.getElementById("btn-wcp-prev").disabled = pg === 0;
        document.getElementById("btn-wcp-next").disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";
        const q = (document.getElementById("ward-coupon-search")?.value || "").trim();
        const slice = this.wardCouponFamilies.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this._buildCouponCard(fam, q, "ward")).join("");
        this._bindWardCardActions(area);
    },

    _bindWardCardActions(area) {
        area.querySelectorAll(".ncc-member-summary").forEach(row => {
            row.addEventListener("click", e => {
                if (e.target.closest(".ncc-toggle")) return;
                const d = row.nextElementSibling;
                if (d?.classList.contains("ncc-details")) d.classList.toggle("ncc-details-open");
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
                await this._wardToggleCoupon([cb.dataset.voterId], action);
            });
        });
        area.querySelectorAll(".coupon-deliver-all").forEach(btn => {
            btn.addEventListener("click", async () => {
                const fam = this.wardCouponFamiliesAll.find(f => f.famcode === btn.dataset.famcode);
                if (!fam) return;
                const allDone = fam.members.every(m => m.coupon_status === "delivered");
                if (allDone) {
                    const confirmed = await Notice.confirmUndeliver();
                    if (!confirmed) return;
                    btn.disabled = true;
                    await this._wardToggleCoupon(fam.members.map(m => m.voter_id), "undeliver", fam.booth);
                } else {
                    btn.disabled = true;
                    await this._wardToggleCoupon(fam.members.filter(m => m.coupon_status !== "delivered").map(m => m.voter_id), "deliver", fam.booth);
                }
            });
        });

        // Edit family
        area.querySelectorAll("[data-edit-famcode]").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                const fam = this.wardCouponFamiliesAll.find(f => f.famcode === btn.dataset.editFamcode);
                if (fam) this._openWardEditFamily(fam);
            });
        });
    },

    _openWardEditFamily(fam) {
        this._openFamilyBuilderModal(fam.members, "ward", { famcode: fam.famcode, booth: fam.booth || "" });
    },

    _bindWardEditSearch() {
        const searchEl = document.getElementById("ward-coupon-edit-search");
        if (!searchEl) return;
        const n = searchEl.cloneNode(true); searchEl.parentNode.replaceChild(n, searchEl);
        n.value = "";
        document.getElementById("ward-coupon-edit-results").innerHTML = "";
        n.addEventListener("input", () => {
            const q = (n.value || "").toLowerCase().trim();
            const resultsEl = document.getElementById("ward-coupon-edit-results");
            if (!q || q.length < 1) { resultsEl.innerHTML = ""; return; }
            const isTamil = I18n.currentLang === "ta";
            const fam = this.wardCouponFamiliesAll.find(f => f.famcode === this.wardEditingFamcode);
            const currentIds = new Set((fam?.members || []).map(m => m.voter_id));
            const matches = [];
            for (const f of this.wardCouponFamiliesAll) {
                for (const m of f.members) {
                    if (currentIds.has(m.voter_id)) continue;
                    const name = (isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "")).toLowerCase();
                    if (name.includes(q) || (m.sl || "").toLowerCase().includes(q) || (m.voter_id || "").toLowerCase().includes(q)) {
                        matches.push({ ...m, _fromFamcode: f.famcode });
                    }
                    if (matches.length >= 20) break;
                }
                if (matches.length >= 20) break;
            }
            if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>No results</p></div>`; return; }
            resultsEl.innerHTML = matches.map(m => {
                const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
                return `<div class="other-search-row">
                    <div class="ncc-member-left"><span class="ncc-sl">${m.sl || ""}</span><span class="ncc-name">${Notice.escapeHtml(name)}</span></div>
                    <button class="btn btn-primary btn-sm btn-ward-edit-add" data-voter='${JSON.stringify({voter_id: m.voter_id, name, sl: m.sl || "", from_famcode: m._fromFamcode})}'>+ Add</button>
                </div>`;
            }).join("");
            resultsEl.querySelectorAll(".btn-ward-edit-add").forEach(btn => {
                btn.addEventListener("click", () => {
                    try {
                        const v = JSON.parse(btn.dataset.voter);
                        const fam = this.wardCouponFamiliesAll.find(f => f.famcode === this.wardEditingFamcode);
                        if (!fam) return;
                        const srcFam = this.wardCouponFamiliesAll.find(f => f.famcode === v.from_famcode);
                        const member = srcFam?.members.find(m => m.voter_id === v.voter_id);
                        if (member) fam.members.push(member);
                        this._renderWardEditPanel(fam);
                        n.value = ""; resultsEl.innerHTML = "";
                    } catch {}
                });
            });
        });
    },

    _renderWardEditPanel(fam) {
        const isTamil = I18n.currentLang === "ta";
        const list = document.getElementById("ward-coupon-edit-members");
        list.innerHTML = (fam.members || []).map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            return `<div class="edit-member-row" data-voter="${m.voter_id}">
                <span class="ncc-sl">${m.sl || ""}</span>
                <span class="ncc-name">${Notice.escapeHtml(name)}</span>
                <button class="btn btn-danger btn-sm btn-remove-ward-member" data-voter="${m.voter_id}">✕</button>
            </div>`;
        }).join("");
        list.querySelectorAll(".btn-remove-ward-member").forEach(btn => {
            btn.addEventListener("click", async () => {
                const ok = await Notice.confirmUndeliver("confirm_remove_member");
                if (!ok) return;
                const fam = this.wardCouponFamiliesAll.find(f => f.famcode === this.wardEditingFamcode);
                if (fam) { fam.members = fam.members.filter(m => m.voter_id !== btn.dataset.voter); this._renderWardEditPanel(fam); }
            });
        });
    },

    async _wardToggleCoupon(voterIds, action, boothOverride) {
        const user = App.getUser();
        const newStatus = action === "deliver" ? "delivered" : "not_delivered";
        const idSet = new Set(voterIds);
        const me = App.getUser();
        const myName = me?.name || "";
        const myTime = new Date().toISOString();

        // Find booth from family
        const booth = boothOverride || (this.wardCouponFamiliesAll.find(f => f.members.some(m => idSet.has(m.voter_id)))?.booth || "");
        const res = await (action === "deliver"
            ? API.wardDeliverCoupon(user.ward, booth, voterIds)
            : API.wardUndeliverCoupon(user.ward, booth, voterIds));

        if (res && res.error) {
            this._applyWardFilters(true);
            App.showToast(res.detail || "Failed to update");
            return;
        }

        this.wardCouponFamiliesAll.forEach(fam => fam.members.forEach(m => {
            if (idSet.has(m.voter_id)) {
                m.coupon_status = newStatus;
                if (action === "deliver") { m.delivered_by_name = myName; m.delivered_by = me?.phone || ""; m.delivered_at = myTime; }
                else { m.delivered_by_name = ""; m.delivered_by = ""; m.delivered_at = ""; }
            }
        }));
        this._applyWardFilters(true);
    },

    _bindWardCouponTabs() {
        document.querySelectorAll("#view-ward-coupon .tabs .tab").forEach(tab => {
            tab.addEventListener("click", () => {
                document.querySelectorAll("#view-ward-coupon .tabs .tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                const isFamily = tab.dataset.couponTab === "family";
                document.getElementById("ward-coupon-family-panel").style.display = isFamily ? "block" : "none";
                document.getElementById("ward-coupon-edit-panel").style.display = "none";
                document.getElementById("ward-coupon-other-panel").style.display = isFamily ? "none" : "block";
                if (!isFamily) {
                    this.wardPendingFamilyVoters = [];
                    this._renderWardPendingFamily();
                    this._syncWardOtherStreets();
                    this._renderWardOtherList("");
                    this._refreshWardOtherSummary();
                    // Sync booth options from main filter
                    const mainBoothSel = document.getElementById("ward-coupon-booth");
                    const otherBoothSel = document.getElementById("ward-coupon-other-booth");
                    if (mainBoothSel && otherBoothSel && otherBoothSel.options.length <= 1) {
                        Array.from(mainBoothSel.options).slice(1).forEach(opt => {
                            const o = document.createElement("option");
                            o.value = opt.value; o.textContent = opt.textContent; otherBoothSel.appendChild(o);
                        });
                    }
                }
            });
        });
    },

    _bindWardCouponFilters() {
        const cloneEl = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const booth  = cloneEl("ward-coupon-booth");
        const search = cloneEl("ward-coupon-search");
        const street = cloneEl("ward-coupon-street");
        if (booth)  booth.addEventListener("change", () => this._loadWardFamilies());
        if (search) search.addEventListener("input", () => this._applyWardFilters());
        if (street) street.addEventListener("change", () => this._applyWardFilters());
    },

    _bindWardCouponNav() {
        const prev = document.getElementById("btn-wcp-prev");
        const next = document.getElementById("btn-wcp-next");
        if (prev) prev.addEventListener("click", () => {
            if (this.wardCouponPage > 0) { this.wardCouponPage--; this._renderWardFamilies(); document.getElementById("main-content").scrollTop = 0; }
        });
        if (next) next.addEventListener("click", () => {
            const pages = Math.ceil(this.wardCouponFamilies.length / this.PAGE_SIZE);
            if (this.wardCouponPage < pages - 1) { this.wardCouponPage++; this._renderWardFamilies(); document.getElementById("main-content").scrollTop = 0; }
        });

        const backBtn = document.getElementById("btn-wcp-edit-back");
        if (backBtn) backBtn.addEventListener("click", () => {
            document.getElementById("ward-coupon-edit-panel").style.display = "none";
            document.getElementById("ward-coupon-family-panel").style.display = "block";
            this.wardEditingFamcode = null;
        });

        const saveBtn = document.getElementById("btn-wcp-edit-save");
        if (saveBtn) saveBtn.addEventListener("click", async () => {
            if (!this.wardEditingFamcode) return;
            const fam = this.wardCouponFamiliesAll.find(f => f.famcode === this.wardEditingFamcode);
            if (!fam) return;
            const user = App.getUser();
            App.setBtnLoading(saveBtn, true);
            const res = await API.updateCouponFamily(user.ward, this.wardEditingBooth, this.wardEditingFamcode, fam.members.map(m => m.voter_id));
            App.setBtnLoading(saveBtn, false);
            if (res.error) { App.showToast(res.detail || "Failed to save"); return; }
            App.showToast("Family updated");
            document.getElementById("ward-coupon-edit-panel").style.display = "none";
            document.getElementById("ward-coupon-family-panel").style.display = "block";
            this.wardEditingFamcode = null;
            await this._loadWardFamilies();
        });
    },

    _bindWardOtherTab() {
        // Populate the Other tab booth selector from already-loaded ward booths
        const boothSel = document.getElementById("ward-coupon-other-booth");
        if (boothSel) {
            const mainBoothSel = document.getElementById("ward-coupon-booth");
            if (mainBoothSel) {
                boothSel.innerHTML = `<option value="">Select Booth</option>`;
                Array.from(mainBoothSel.options).slice(1).forEach(opt => {
                    const o = document.createElement("option");
                    o.value = opt.value; o.textContent = opt.textContent; boothSel.appendChild(o);
                });
            }
            boothSel.addEventListener("change", () => {
                document.getElementById("ward-coupon-other-search").value = "";
                document.getElementById("ward-coupon-other-results").innerHTML = "";
            });
        }

        const searchEl = document.getElementById("ward-coupon-other-search");
        if (searchEl) searchEl.addEventListener("input", () => this._searchWardOtherVoters());

        const streetEl = document.getElementById("ward-coupon-other-street");
        if (streetEl) streetEl.addEventListener("change", () => this._searchWardOtherVoters());

        const submitBtn = document.getElementById("btn-ward-coupon-submit-family");
        if (submitBtn) submitBtn.addEventListener("click", () => this._submitWardNewFamily());
    },

    _syncWardOtherStreets() {
        const src = document.getElementById("ward-coupon-street");
        const dst = document.getElementById("ward-coupon-other-street");
        if (!src || !dst) return;
        dst.innerHTML = `<option value="">All Streets</option>`;
        Array.from(src.options).slice(1).forEach(opt => {
            const o = document.createElement("option");
            o.value = opt.value; o.textContent = opt.textContent; dst.appendChild(o);
        });
    },

    _refreshWardOtherSummary() {
        const all = this.wardCouponFamiliesAll.flatMap(f => f.members);
        const delivered = all.filter(m => m.coupon_status === "delivered").length;
        const total = all.length;
        const bar = document.getElementById("ward-coupon-summary");
        if (bar && total > 0) bar.innerHTML = `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} Delivered</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} Total</span>
            <span class="notice-summary-pct">${Math.round(delivered / total * 100)}%</span>
        </div>`;
    },

    _renderWardOtherList(q) {
        const resultsEl = document.getElementById("ward-coupon-other-results");
        if (!resultsEl) return;
        const isTamil = I18n.currentLang === "ta";
        const pendingIds = new Set(this.wardPendingFamilyVoters.map(v => v.voter_id));
        const qLow = q.toLowerCase();
        const boothFilter = document.getElementById("ward-coupon-other-booth")?.value || "";
        const streetFilter = document.getElementById("ward-coupon-other-street")?.value || "";

        const pool = this.wardCouponFamiliesAll;

        let voters = [];
        for (const fam of pool) {
            if (boothFilter && fam.booth !== boothFilter) continue;
            for (const m of fam.members) {
                if (streetFilter && m.section !== streetFilter) continue;
                const isUngrouped = !fam.is_custom && fam.members.length === 1 && fam.famcode === m.voter_id;
                const isCustom = fam.is_custom;
                if (!qLow) {
                    if (isUngrouped) voters.push({ ...m, booth: fam.booth, in_custom_family: isCustom ? fam.famcode : "" });
                } else {
                    const name = (isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "")).toLowerCase();
                    if (name.includes(qLow) || (m.sl || "").toLowerCase().includes(qLow) || (m.voter_id || "").toLowerCase().includes(qLow)) {
                        voters.push({ ...m, booth: fam.booth, in_custom_family: isCustom ? fam.famcode : "" });
                    }
                }
            }
        }

        if (!voters.length) {
            resultsEl.innerHTML = `<div class="empty-state"><p>${qLow ? "No results" : "No ungrouped voters"}</p></div>`;
            return;
        }

        if (qLow) this._sortByQuery(voters, qLow);

        resultsEl.innerHTML = voters.map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const inPending = pendingIds.has(m.voter_id);
            const tag = m.in_custom_family ? `<span class="notice-tag notice-tag-partial">Custom fam</span>` : "";
            return `<div class="other-search-row">
                <div class="ncc-member-left">
                    <span class="ncc-sl">${this._hl(m.sl || "", qLow)}</span>
                    <span class="ncc-name">${this._hl(name, qLow)} ${tag}</span>
                    ${qLow ? `<span style="font-size:0.65rem;color:var(--text-muted)">${this._hl(m.voter_id || "", qLow)}</span>` : ""}
                    <span style="font-size:0.65rem;color:var(--text-muted)">${m.booth || ""}</span>
                </div>
                <button class="btn btn-sm ${inPending ? "btn-success" : "btn-primary"} btn-add-ward-pending"
                    data-voter='${JSON.stringify({voter_id: m.voter_id, name, sl: m.sl || "", booth: m.booth || "", in_custom_family: m.in_custom_family || ""})}'
                    ${inPending ? "disabled" : ""}>
                    ${inPending ? "✓ Added" : "+ Add"}
                </button>
            </div>`;
        }).join("");

        resultsEl.querySelectorAll(".btn-add-ward-pending").forEach(btn => {
            btn.addEventListener("click", () => {
                try { this._addToWardPending(JSON.parse(btn.dataset.voter)); } catch {}
            });
        });
    },

        _searchWardOtherVoters() {
        const q = (document.getElementById("ward-coupon-other-search")?.value || "").trim();
        this._renderWardOtherList(q);
    },

    _addToWardPending(voter) {
        this._openFamilyBuilderModal([voter], "ward");
    },

    _renderWardPendingFamily() {
        const list = document.getElementById("ward-coupon-pending-list");
        const btn = document.getElementById("btn-ward-coupon-submit-family");
        if (!list) return;
        if (this.wardPendingFamilyVoters.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:8px;"><p>Add people above to build a family</p></div>`;
            if (btn) btn.disabled = true;
            return;
        }
        if (btn) btn.disabled = false;
        list.innerHTML = this.wardPendingFamilyVoters.map(v => `
            <div class="edit-member-row">
                <span class="ncc-sl">${v.sl || ""}</span>
                <span class="ncc-name">${Notice.escapeHtml(v.name || v.voter_id)}</span>
                <button class="btn btn-danger btn-sm btn-remove-ward-pending" data-voter="${v.voter_id}">✕</button>
            </div>`).join("");
        list.querySelectorAll(".btn-remove-ward-pending").forEach(btn => {
            btn.addEventListener("click", () => {
                this.wardPendingFamilyVoters = this.wardPendingFamilyVoters.filter(v => v.voter_id !== btn.dataset.voter);
                this._renderWardPendingFamily();
                this._searchWardOtherVoters();
            });
        });
    },

    async _submitWardNewFamily() {
        if (!this.wardPendingFamilyVoters.length) return;
        const user = App.getUser();
        const booth = this.wardPendingFamilyVoters[0]?.booth || document.getElementById("ward-coupon-other-booth")?.value || "";
        if (!booth) { App.showToast("Select a booth first"); return; }
        const btn = document.getElementById("btn-ward-coupon-submit-family");
        if (btn) App.setBtnLoading(btn, true);
        const res = await API.createCouponFamily(user.ward, booth, this.wardPendingFamilyVoters.map(v => v.voter_id));
        if (btn) App.setBtnLoading(btn, false);
        if (res.error) { App.showToast(res.detail || "Failed to create family"); return; }
        App.showToast("Family created!");
        this.wardPendingFamilyVoters = [];
        this._renderWardPendingFamily();
        document.getElementById("ward-coupon-other-search").value = "";
        document.getElementById("ward-coupon-other-results").innerHTML = "";
        document.querySelectorAll("#view-ward-coupon .tabs .tab").forEach(t => {
            t.classList.toggle("active", t.dataset.couponTab === "family");
        });
        document.getElementById("ward-coupon-family-panel").style.display = "block";
        document.getElementById("ward-coupon-other-panel").style.display = "none";
        await this._loadWardFamilies();
    },

    async loadWardCouponStats() {
        const user = App.getUser();
        App.showViewLoading("view-ward-coupon-stats");
        const booths = await API.getNoticeWardBooths(user.ward);
        const boothList = (booths.booths || []).map(b => typeof b === "object" ? b.booth : b);
        const statsArr = await Promise.all(boothList.map(b => API.getCouponBoothStats(user.ward, b)));
        App.hideViewLoading("view-ward-coupon-stats");

        const total     = statsArr.reduce((s, r) => s + (r.total || 0), 0);
        const delivered = statsArr.reduce((s, r) => s + (r.delivered || 0), 0);
        const pending   = total - delivered;
        const pct       = total > 0 ? Math.round(delivered / total * 100) : 0;

        const cards = document.getElementById("ward-coupon-stats-cards");
        cards.innerHTML = `
            <div class="stat-card accent"><div class="stat-value">${total}</div><div class="stat-label">Total</div></div>
            <div class="stat-card success"><div class="stat-value">${delivered}</div><div class="stat-label">Delivered</div></div>
            <div class="stat-card warning"><div class="stat-value">${pending}</div><div class="stat-label">Pending</div></div>
            <div class="stat-card wide">
                <div class="stat-label">Completion — ${pct}%</div>
                <div class="progress-bar-container"><div class="progress-bar" style="width:${pct}%;background:var(--success)"></div></div>
            </div>`;

        const boothsEl = document.getElementById("ward-coupon-stats-booths");
        if (boothsEl) {
            boothsEl.innerHTML = boothList.map((b, i) => {
                const s = statsArr[i];
                if (!s || s.error) return "";
                const p = s.total > 0 ? Math.round(s.delivered / s.total * 100) : 0;
                return `<div class="street-stat-row">
                    <div class="stat-row-top"><span class="stat-row-name">${b}</span><span class="stat-row-pct">${p}%</span></div>
                    <div class="progress-bar-container"><div class="progress-bar" style="width:${p}%;background:var(--success)"></div></div>
                    <div class="stat-row-nums">
                        <span>Delivered: ${s.delivered}</span>
                        <span>Pending: ${s.pending}</span>
                        <span>Total: ${s.total}</span>
                    </div>
                </div>`;
            }).join("");
        }
    },

    // ═══ ADMIN ════════════════════════════════════════════════════

    // ═══ AUDIT LOG ═══════════════════════════════════════════════════

    async initAdminCoupon() {
        this._bindAdminCouponPageTabs();
        await this.initAdmin();
    },

    _bindAdminCouponPageTabs() {
        document.querySelectorAll("#view-admin-coupon-browser .tabs .tab[data-admin-coupon-tab]").forEach(tab => {
            tab.addEventListener("click", async () => {
                document.querySelectorAll("#view-admin-coupon-browser .tabs .tab[data-admin-coupon-tab]").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                const isBrowse = tab.dataset.adminCouponTab === "browse";
                document.getElementById("admin-coupon-browse-panel").style.display = isBrowse ? "block" : "none";
                document.getElementById("admin-coupon-audit-panel").style.display = isBrowse ? "none" : "block";
                if (!isBrowse) await this.loadCouponAuditLog();
            });
        });
    },

    async loadCouponAuditLog() {
        const ward    = document.getElementById("audit-filter-ward")?.value || "";
        const booth   = document.getElementById("audit-filter-booth")?.value || "";
        const who     = (document.getElementById("audit-filter-who")?.value || "").trim();
        const list    = document.getElementById("audit-log-list");
        list.innerHTML = `<div class="loading-spinner-sm"></div>`;

        const res = await API.getCouponAuditLog(ward, booth, "");
        if (res.error) { list.innerHTML = `<p class="empty-state">${res.detail}</p>`; return; }

        let entries = res.entries || [];
        // Client-side filter by name/phone since Azure doesn't index by_name
        if (who) {
            const w = who.toLowerCase();
            entries = entries.filter(e =>
                (e.by_name || "").toLowerCase().includes(w) ||
                (e.by_phone || "").includes(w)
            );
        }

        // Populate ward/booth dropdowns once
        this._populateAuditFilters(res.entries || []);

        if (!entries.length) { list.innerHTML = `<div class="empty-state"><p>No audit entries found.</p></div>`; return; }

        const actionLabel = { create: "Created", update: "Updated", delete: "Deleted", undo_create: "Undo Create", undo_update: "Undo Update", undo_delete: "Undo Delete" };
        const actionColor = { create: "success", update: "accent", delete: "danger", undo_create: "warning", undo_update: "warning", undo_delete: "warning" };
        const canUndo = a => ["create", "update", "delete"].includes(a);

        list.innerHTML = entries.map(e => {
            const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : "-";
            const label = actionLabel[e.action] || e.action;
            const color = actionColor[e.action] || "accent";
            const voters = (e.voter_ids || []).length;
            const oldVoters = (e.old_voter_ids || []).length;
            const detail = e.action === "update"
                ? `${oldVoters} → ${voters} members`
                : `${voters} member${voters !== 1 ? "s" : ""}`;
            return `<div class="sync-failure-row">
                <div class="sync-failure-header">
                    <span class="sync-failure-action ${color === "danger" ? "undeliver" : "deliver"}">${label}</span>
                    <span class="sync-failure-time">${time}</span>
                </div>
                <div class="sync-failure-meta">
                    <span>${e.ward} · ${e.booth}</span>
                    <span>${detail}</span>
                    <span>${e.by_name || e.by_phone || "-"}</span>
                </div>
                <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Family: ${e.famcode}</div>
                ${canUndo(e.action) ? `<button class="btn btn-secondary btn-sm mt-8 btn-audit-undo" data-log-id="${e.log_id}" data-ward="${e.ward}">↩ Undo</button>` : ""}
            </div>`;
        }).join("");

        list.querySelectorAll(".btn-audit-undo").forEach(btn => {
            btn.addEventListener("click", async () => {
                if (!confirm("Undo this action?")) return;
                App.setBtnLoading(btn, true);
                const res = await API.undoCouponAction(btn.dataset.logId, btn.dataset.ward);
                App.setBtnLoading(btn, false);
                if (res.error) { App.showToast(res.detail || "Failed to undo"); return; }
                App.showToast("Action undone");
                await this.loadCouponAuditLog();
            });
        });
    },

    _populateAuditFilters(entries) {
        const wardSel  = document.getElementById("audit-filter-ward");
        const boothSel = document.getElementById("audit-filter-booth");
        if (!wardSel || wardSel.options.length > 1) return; // already populated
        const wards  = [...new Set(entries.map(e => e.ward).filter(Boolean))].sort();
        const booths = [...new Set(entries.map(e => e.booth).filter(Boolean))].sort();
        wards.forEach(w => { const o = document.createElement("option"); o.value = w; o.textContent = w; wardSel.appendChild(o); });
        booths.forEach(b => { const o = document.createElement("option"); o.value = b; o.textContent = b; boothSel.appendChild(o); });
        [wardSel, boothSel, document.getElementById("audit-filter-who")].forEach(el => {
            if (el) el.addEventListener("change", () => this.loadCouponAuditLog());
        });
        const who = document.getElementById("audit-filter-who");
        if (who) who.addEventListener("input", () => this.loadCouponAuditLog());
    },

    async initAdmin() {
        // Reuse admin browse pattern — same ward/booth/street cascading filters
        this.adminCouponWard = "";
        this.adminCouponBooth = "";
        this.adminCouponFamiliesAll = [];
        this.adminCouponFamilies = [];
        this.adminCouponPage = 0;
        this._bindAdminCouponFilters();
        await this._loadAdminCouponWards();
    },

    async _loadAdminCouponWards() {
        const wardSel = document.getElementById("admin-coupon-ward");
        wardSel.innerHTML = `<option value="">Select Ward</option>`;
        App.showViewLoading("view-admin-coupon-browser");
        const res = await API.getCouponAdminStats("", "");
        if (res.error) { App.hideViewLoading("view-admin-coupon-browser"); return; }

        // Use notice ward booths for ward list
        const statsRes = await API.getNoticeAdminStats("", "");
        App.hideViewLoading("view-admin-coupon-browser");
        const wards = statsRes.wards || [];
        wards.forEach(w => {
            const o = document.createElement("option");
            o.value = w.ward; o.textContent = w.ward_name || w.ward; wardSel.appendChild(o);
        });
        if (wards.length > 0) {
            wardSel.value = wards[0].ward;
            this.adminCouponWard = wards[0].ward;
            await this._loadAdminCouponBooths(this.adminCouponWard);
            await this._loadAdminCouponFamilies();
        }
    },

    async _loadAdminCouponBooths(ward) {
        const boothSel = document.getElementById("admin-coupon-booth");
        boothSel.innerHTML = `<option value="">All Booths</option>`;
        document.getElementById("admin-coupon-street").innerHTML = `<option value="">All Streets</option>`;
        if (!ward) return;
        const res = await API.getNoticeWardBooths(ward);
        if (res.error) return;
        (res.booths || []).forEach(b => {
            const o = document.createElement("option");
            const val = typeof b === "object" ? b.booth : b;
            const label = typeof b === "object" ? (Ward.formatBoothLabel(b.booth_name, b.booth_number, 40, b.booth_name_tamil) || val) : val;
            o.value = val; o.textContent = label; boothSel.appendChild(o);
        });
        boothSel.value = ""; this.adminCouponBooth = "";
    },

    async _loadAdminCouponFamilies() {
        const ward = this.adminCouponWard;
        if (!ward) { App.hideViewLoading("view-admin-coupon-browser"); return; }
        App.showViewLoading("view-admin-coupon-browser");
        const res = await API.getCouponWardFamilies(ward, this.adminCouponBooth);
        App.hideViewLoading("view-admin-coupon-browser");
        if (res.error) return;
        this.adminCouponFamiliesAll = res.families || [];

        const streetSel = document.getElementById("admin-coupon-street");
        streetSel.innerHTML = `<option value="">All Streets</option>`;
        (res.streets || []).forEach(s => {
            const o = document.createElement("option");
            o.value = s; o.textContent = s; streetSel.appendChild(o);
        });

        const all = this.adminCouponFamiliesAll.flatMap(f => f.members);
        const delivered = all.filter(m => m.coupon_status === "delivered").length;
        const total = all.length;
        document.getElementById("admin-coupon-summary").innerHTML = total === 0 ? "" : `<div class="notice-summary">
            <span class="notice-summary-delivered">${delivered} Delivered</span>
            <span class="notice-summary-sep">/</span>
            <span class="notice-summary-total">${total} Total</span>
            <span class="notice-summary-pct">${Math.round(delivered / total * 100)}%</span>
        </div>`;
        this._applyAdminCouponFilters();
    },

    _applyAdminCouponFilters(keepPage = false) {
        const search = (document.getElementById("admin-coupon-search")?.value || "").toLowerCase().trim();
        const street = document.getElementById("admin-coupon-street")?.value || "";
        let filtered = this.adminCouponFamiliesAll;
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
        }
        this.adminCouponFamilies = filtered;
        if (!keepPage) this.adminCouponPage = 0;
        this._renderAdminCouponFamilies();
    },

    _renderAdminCouponFamilies() {
        const area  = document.getElementById("admin-coupon-family-area");
        const nav   = document.getElementById("admin-coupon-nav");
        const ps = this.PAGE_SIZE;
        const total = this.adminCouponFamilies.length;
        if (total === 0) { area.innerHTML = ""; nav.style.display = "none"; return; }
        const pages = Math.ceil(total / ps);
        const pg = Math.min(this.adminCouponPage, pages - 1);
        this.adminCouponPage = pg;
        document.getElementById("admin-coupon-counter").textContent = `${pg + 1} / ${pages}`;
        document.getElementById("btn-acp-prev").disabled = pg === 0;
        document.getElementById("btn-acp-next").disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";
        const q = (document.getElementById("admin-coupon-search")?.value || "").trim();
        const slice = this.adminCouponFamilies.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this._buildCouponCard(fam, q, "ward")).join("");
        this._bindWardCardActions(area); // reuse ward card actions (uses wardDeliverCoupon internally)
    },

    _bindAdminCouponFilters() {
        const cloneEl = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const wardSel   = cloneEl("admin-coupon-ward");
        const boothSel  = cloneEl("admin-coupon-booth");
        const streetSel = cloneEl("admin-coupon-street");
        const search    = cloneEl("admin-coupon-search");
        const prev = document.getElementById("btn-acp-prev");
        const next = document.getElementById("btn-acp-next");
        if (prev) { const p = prev.cloneNode(true); prev.parentNode.replaceChild(p, prev);
            p.addEventListener("click", () => { if (this.adminCouponPage > 0) { this.adminCouponPage--; this._renderAdminCouponFamilies(); document.getElementById("main-content").scrollTop = 0; } }); }
        if (next) { const n = next.cloneNode(true); next.parentNode.replaceChild(n, next);
            n.addEventListener("click", () => { const pages = Math.ceil(this.adminCouponFamilies.length / this.PAGE_SIZE); if (this.adminCouponPage < pages - 1) { this.adminCouponPage++; this._renderAdminCouponFamilies(); document.getElementById("main-content").scrollTop = 0; } }); }
        if (wardSel) wardSel.addEventListener("change", async () => {
            this.adminCouponWard = wardSel.value;
            this.adminCouponBooth = "";
            await this._loadAdminCouponBooths(this.adminCouponWard);
            await this._loadAdminCouponFamilies();
        });
        if (boothSel) boothSel.addEventListener("change", async () => {
            this.adminCouponBooth = boothSel.value;
            await this._loadAdminCouponFamilies();
        });
        if (streetSel) streetSel.addEventListener("change", () => this._applyAdminCouponFilters());
        if (search) search.addEventListener("input", () => this._applyAdminCouponFilters());
    },
};
