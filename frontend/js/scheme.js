/**
 * Scheme — unified distribution scheme module.
 *
 * Handles both booth and ward views for any scheme.
 * Each scheme has:
 *   id    — "notice" | "coupon" | future ids
 *   name  — display name
 *   type  — "individual" (per-member toggles, partial OK) | "family" (all-or-nothing per family)
 *
 * Layout:
 *   Scheme dropdown → [Family] [Other] tabs
 *   Booth: street filter
 *   Ward:  booth filter + street filter (both client-side)
 */

const Scheme = {
    PAGE_SIZE: 10,
    schemes: [],   // loaded from /api/schemes
    _lastDeliverAt: 0,
    DELIVER_COOLDOWN_MS: 10000,

    // ── Booth state ────────────────────────────────────────────────
    boothMode: {
        scheme: null,
        tab: "family",
        familiesAll: [],
        families: [],
        page: 0,
        ungroupedAll: [],
        ungrouped: [],
        street: "",
        search: "",
        otherStreet: "",
        otherSearch: "",
        unfilledOnly: false,
    },

    // ── Ward state ─────────────────────────────────────────────────
    wardMode: {
        scheme: null,
        tab: "family",
        familiesAll: [],
        families: [],
        page: 0,
        ungroupedAll: [],
        ungrouped: [],
        booth: "",
        street: "",
        search: "",
        booths: [],
        unfilledOnly: false,
    },

    // ── Admin state ────────────────────────────────────────────────
    adminMode: {
        scheme: null,
        tab: "family",
        ward: "",
        booth: "",
        familiesAll: [],
        families: [],
        page: 0,
        ungroupedAll: [],
        ungrouped: [],
        search: "",
        unfilledOnly: false,
    },

    // ── Family builder modal state ─────────────────────────────────
    _modalPending: [],
    _modalEditFamcode: null,
    _modalEditBooth: null,
    _modalMode: null,

    // ── API wiring per scheme id ───────────────────────────────────

    _def(id) {
        const defs = {
            notice: {
                statusField: "status",
                loadBooth(ward, booth)        { return API.getNoticeVoters(ward, booth, ""); },
                loadWard(ward)                { return API.getNoticeWardAllVoters(ward); },
                loadAdmin(ward, booth)        { return booth ? API.getNoticeWardBoothVoters(ward, booth, "") : API.getNoticeWardAllVoters(ward); },
                deliver(ward, booth, ids, isWard) {
                    return isWard ? API.wardDeliverNotice(ward, booth, ids) : API.deliverNotice(ward, booth, ids);
                },
                undeliver(ward, booth, ids, isWard) {
                    return isWard ? API.wardUndeliverNotice(ward, booth, ids) : API.undeliverNotice(ward, booth, ids);
                },
            },
            coupon: {
                statusField: "coupon_status",
                loadBooth(ward, booth)        { return API.getCouponFamilies(ward, booth); },
                loadWard(ward)                { return API.getCouponWardFamilies(ward, ""); },
                loadAdmin(ward, booth)        { return API.getCouponWardFamilies(ward, booth); },
                deliver(ward, booth, ids, isWard) {
                    return isWard ? API.wardDeliverCoupon(ward, booth, ids) : API.deliverCoupon(ward, booth, ids);
                },
                undeliver(ward, booth, ids, isWard) {
                    return isWard ? API.wardUndeliverCoupon(ward, booth, ids) : API.undeliverCoupon(ward, booth, ids);
                },
            },
        };
        if (defs[id]) return defs[id];

        // ── Generic handler for any custom scheme (cs_*) ───────────────
        return {
            statusField: "scheme_status",
            loadBooth:  (ward, booth) => API.getSchemeFamilies(id, ward, booth),
            loadWard:   (ward)        => API.getSchemeWardFamilies(id, ward),
            loadAdmin:  (ward, booth) => booth ? API.getSchemeFamilies(id, ward, booth) : API.getSchemeWardFamilies(id, ward),
            deliver:    (ward, booth, ids, isWard) =>
                isWard ? API.wardDeliverScheme(id, ward, booth, ids) : API.deliverScheme(id, ward, booth, ids),
            undeliver:  (ward, booth, ids, isWard) =>
                isWard ? API.wardUndeliverScheme(id, ward, booth, ids) : API.undeliverScheme(id, ward, booth, ids),
        };
    },

    // ── Response normaliser ────────────────────────────────────────
    // Returns { families, ungrouped } regardless of scheme

    _parse(schemeId, res) {
        if (schemeId === "notice") {
            const families = res.families || [];
            const ungrouped = (res.ungrouped || []).map(m => ({
                famcode: m.voter_id,
                house: m.house,
                section: m.section,
                booth: m.booth,
                members: [m],
                _single: true,
            }));
            return { families, ungrouped };
        }
        // coupon (and future family-type schemes)
        const all = res.families || [];
        all.forEach(fam => fam.members.forEach(m => {
            m._delivered_by_name = m.delivered_by_name || "";
            m._delivered_at      = m.delivered_at      || "";
        }));
        const isGrouped = f =>
            f.is_custom ||
            f.members.length > 1 ||
            f.famcode !== (f.members[0]?.voter_id);
        return {
            families: all.filter(isGrouped),
            ungrouped: all.filter(f => !isGrouped(f)),
        };
    },

    _fmtDeliveredAt(isoStr) {
        if (!isoStr) return "";
        const d = new Date(isoStr);
        if (isNaN(d)) return "";
        return String(d.getDate()).padStart(2,"0") + "/"
             + String(d.getMonth()+1).padStart(2,"0") + " "
             + String(d.getHours()).padStart(2,"0") + ":"
             + String(d.getMinutes()).padStart(2,"0");
    },

    // ── Booth: init ───────────────────────────────────────────────

    async initBooth() {
        App.showViewLoading("view-booth-scheme");
        const res = await API.getSchemes();
        this.schemes = res.schemes || [];

        const state = this.boothMode;
        Object.assign(state, {
            scheme: null, tab: "family",
            familiesAll: [], families: [],
            ungroupedAll: [], ungrouped: [],
            page: 0, street: "", search: "",
            otherStreet: "", otherSearch: "",
            unfilledOnly: false,
        });

        this._populateSchemeDropdown("booth-scheme-select", id => this._onBoothSchemeChange(id));
        document.getElementById("booth-scheme-content").style.display = "none";

        // Auto-select if only one scheme
        if (this.schemes.length === 1) {
            const sel = document.getElementById("booth-scheme-select");
            if (sel) sel.value = this.schemes[0].id;
            await this._onBoothSchemeChange(this.schemes[0].id);
        }
        App.hideViewLoading("view-booth-scheme");
    },

    async _onBoothSchemeChange(schemeId) {
        const content = document.getElementById("booth-scheme-content");
        if (!schemeId) { content.style.display = "none"; this.boothMode.scheme = null; return; }

        const schemeObj = this.schemes.find(s => s.id === schemeId);
        if (!schemeObj) return;

        Object.assign(this.boothMode, {
            scheme: schemeObj, tab: "family", page: 0,
            street: "", search: "", otherStreet: "", otherSearch: "",
            unfilledOnly: false,
        });

        content.style.display = "block";
        this._resetTabUI("#view-booth-scheme", "booth-scheme-family-panel", "booth-scheme-other-panel");
        this._bindBoothTabs();
        this._bindBoothFilters();
        this._bindBoothNav();
        await this._loadBoothData();
    },

    async _loadBoothData() {
        const state = this.boothMode;
        const user = App.getUser();
        const def = this._def(state.scheme.id);

        App.showViewLoading("view-booth-scheme");
        const res = await def.loadBooth(user.ward, user.booth);
        App.hideViewLoading("view-booth-scheme");
        if (res.error) { App.showToast(res.detail || I18n.t("error")); return; }

        const { families, ungrouped } = this._parse(state.scheme.id, res);
        state.familiesAll = families;
        state.ungroupedAll = ungrouped;

        // Populate street dropdowns
        const streets = this._extractStreets([...families, ...ungrouped]);
        this._fillStreetSel("booth-scheme-street", streets);
        this._fillStreetSel("booth-scheme-other-street", streets);

        this._applyBoothFilters();
        this._refreshSummary("booth");
    },

    _applyBoothFilters() {
        const state = this.boothMode;

        state.families = this._filterFams(
            state.familiesAll, state.street, state.search, state.unfilledOnly
        );
        state.ungrouped = this._filterFams(
            state.ungroupedAll, state.otherStreet, state.search, state.unfilledOnly
        );

        if (state.tab === "family") this._renderBoothFamilies();
        else this._renderBoothOther();
        this._refreshSummary("booth");
        this._updateTabCounts("#view-booth-scheme", state);
    },

    _renderBoothFamilies() {
        const state = this.boothMode;
        this._renderPage(
            state, "booth-scheme-family-area", "booth-scheme-nav",
            "booth-scheme-empty", "booth-scheme-counter",
            "btn-bsp-prev", "btn-bsp-next", "booth"
        );
    },

    _renderBoothOther() {
        const state = this.boothMode;
        const area  = document.getElementById("booth-scheme-other-area");
        if (!area) return;

        let html = `<button class="btn btn-primary btn-sm btn-scheme-new-family" style="margin-bottom:12px;width:100%;">${I18n.t("new_family")}</button>`;
        if (!state.ungrouped.length) {
            html += `<div class="empty-state"><p>${I18n.t("no_ungrouped_voters")}</p></div>`;
        } else {
            html += state.ungrouped.map(fam => this._buildOtherRow(fam.members[0], fam.famcode, state.scheme, state.search)).join("");
        }
        area.innerHTML = html;

        area.querySelector(".btn-scheme-new-family")?.addEventListener("click", () => {
            this._openModal([], null, "booth");
        });
        this._bindCardActions(area, "booth");
    },

    _bindBoothTabs() {
        this._bindTabs("#view-booth-scheme", "booth-scheme-family-panel", "booth-scheme-other-panel",
            tab => {
                this.boothMode.tab = tab;
                this.boothMode.page = 0;
                this._applyBoothFilters();
            });
    },

    _bindBoothFilters() {
        const c = id => this._clone(id);
        const search      = c("booth-scheme-search");
        const street      = c("booth-scheme-street");
        const otherStreet = c("booth-scheme-other-street");

        if (search)      search.addEventListener("input",  () => { this.boothMode.search      = search.value;      this.boothMode.page = 0; this._applyBoothFilters(); });
        if (street)      street.addEventListener("change", () => { this.boothMode.street      = street.value;      this.boothMode.page = 0; this._applyBoothFilters(); });
        if (otherStreet) otherStreet.addEventListener("change", () => { this.boothMode.otherStreet = otherStreet.value; this._applyBoothFilters(); });

        this._bindUnfilledToggle("btn-booth-scheme-unfilled", this.boothMode, () => this._applyBoothFilters());
    },

    _bindBoothNav() {
        this._bindPageNav(
            "btn-bsp-prev", "btn-bsp-next",
            () => this.boothMode,
            () => this._renderBoothFamilies()
        );
    },

    // ── Ward: init ────────────────────────────────────────────────

    async initWard() {
        App.showViewLoading("view-ward-scheme");
        const res = await API.getSchemes();
        this.schemes = res.schemes || [];

        const state = this.wardMode;
        Object.assign(state, {
            scheme: null, tab: "family",
            familiesAll: [], families: [],
            ungroupedAll: [], ungrouped: [],
            page: 0, booth: "", street: "", search: "", otherSearch: "",
            booths: [], unfilledOnly: false,
        });

        this._populateSchemeDropdown("ward-scheme-select", id => this._onWardSchemeChange(id));
        document.getElementById("ward-scheme-content").style.display = "none";

        if (this.schemes.length === 1) {
            const sel = document.getElementById("ward-scheme-select");
            if (sel) sel.value = this.schemes[0].id;
            await this._onWardSchemeChange(this.schemes[0].id);
        }
        App.hideViewLoading("view-ward-scheme");
    },

    async _onWardSchemeChange(schemeId) {
        const content = document.getElementById("ward-scheme-content");
        if (!schemeId) { content.style.display = "none"; this.wardMode.scheme = null; return; }

        const schemeObj = this.schemes.find(s => s.id === schemeId);
        if (!schemeObj) return;

        Object.assign(this.wardMode, {
            scheme: schemeObj, tab: "family", page: 0,
            booth: "", street: "", search: "", otherSearch: "",
            unfilledOnly: false,
        });

        content.style.display = "block";
        this._resetTabUI("#view-ward-scheme", "ward-scheme-family-panel", "ward-scheme-other-panel");
        this._bindWardTabs();
        this._bindWardFilters();
        this._bindWardNav();
        await this._loadWardData();
    },

    async _loadWardData() {
        const state = this.wardMode;
        const user = App.getUser();
        const def = this._def(state.scheme.id);

        App.showViewLoading("view-ward-scheme");
        const res = await def.loadWard(user.ward);
        App.hideViewLoading("view-ward-scheme");
        if (res.error) { App.showToast(res.detail || I18n.t("error")); return; }

        const { families, ungrouped } = this._parse(state.scheme.id, res);
        state.familiesAll = families;
        state.ungroupedAll = ungrouped;

        // Build booth dropdown from data
        const boothMap = {};
        [...families, ...ungrouped].forEach(fam => {
            const bid = fam.booth || fam.members[0]?.booth;
            if (bid && !boothMap[bid]) {
                boothMap[bid] = {
                    id: bid,
                    name: fam.booth_name || fam.members[0]?.booth_name || bid,
                    number: fam.booth_number || fam.members[0]?.booth_number || "",
                };
            }
        });
        state.booths = Object.values(boothMap).sort((a, b) => a.id.localeCompare(b.id));

        const boothSel = document.getElementById("ward-scheme-booth");
        boothSel.innerHTML = `<option value="">${I18n.t("all_booths")}</option>`;
        state.booths.forEach(b => {
            const o = document.createElement("option");
            o.value = b.id;
            o.textContent = b.number ? `${b.number} - ${b.name}` : b.name;
            boothSel.appendChild(o);
        });

        this._updateWardStreetFilter();
        this._applyWardFilters();
        this._refreshSummary("ward");
    },

    _updateWardStreetFilter() {
        const state = this.wardMode;
        const all = [...state.familiesAll, ...state.ungroupedAll];
        const src = state.booth
            ? all.filter(f => (f.booth || f.members[0]?.booth) === state.booth)
            : all;
        const streets = this._extractStreets(src);
        const sel = document.getElementById("ward-scheme-street");
        const prev = sel.value;
        this._fillStreetSel("ward-scheme-street", streets);
        if (streets.includes(prev)) sel.value = prev;
    },

    _applyWardFilters() {
        const state = this.wardMode;
        const byBooth = arr => state.booth
            ? arr.filter(f => (f.booth || f.members[0]?.booth) === state.booth)
            : arr;

        state.families = this._filterFams(byBooth(state.familiesAll), state.street, state.search, state.unfilledOnly);
        state.ungrouped = this._filterFams(byBooth(state.ungroupedAll), state.street, state.search, state.unfilledOnly);

        if (state.tab === "family") this._renderWardFamilies();
        else this._renderWardOther();
        this._refreshSummary("ward");
        this._updateTabCounts("#view-ward-scheme", state);
    },

    _renderWardFamilies() {
        const state = this.wardMode;
        this._renderPage(
            state, "ward-scheme-family-area", "ward-scheme-nav",
            "ward-scheme-empty", "ward-scheme-counter",
            "btn-wsp-prev", "btn-wsp-next", "ward"
        );
    },

    _renderWardOther() {
        const state = this.wardMode;
        const area  = document.getElementById("ward-scheme-other-area");
        if (!area) return;

        let html = `<button class="btn btn-primary btn-sm btn-scheme-new-family" style="margin-bottom:12px;width:100%;">${I18n.t("new_family")}</button>`;
        if (!state.ungrouped.length) {
            html += `<div class="empty-state"><p>${I18n.t("no_ungrouped_voters")}</p></div>`;
        } else {
            html += state.ungrouped.map(fam => this._buildOtherRow(fam.members[0], fam.famcode, state.scheme, state.search)).join("");
        }
        area.innerHTML = html;

        area.querySelector(".btn-scheme-new-family")?.addEventListener("click", () => {
            this._openModal([], null, "ward");
        });
        this._bindCardActions(area, "ward");
    },

    _bindWardTabs() {
        this._bindTabs("#view-ward-scheme", "ward-scheme-family-panel", "ward-scheme-other-panel",
            tab => {
                this.wardMode.tab = tab;
                this.wardMode.page = 0;
                this._applyWardFilters();
            });
    },

    _bindWardFilters() {
        const c = id => this._clone(id);
        const search = c("ward-scheme-search");
        const booth  = c("ward-scheme-booth");
        const street = c("ward-scheme-street");

        if (search) search.addEventListener("input", () => {
            this.wardMode.search = search.value;
            this.wardMode.page = 0;
            this._applyWardFilters();
        });
        if (booth) booth.addEventListener("change", () => {
            this.wardMode.booth = booth.value;
            this.wardMode.street = "";
            this.wardMode.page = 0;
            this._updateWardStreetFilter();
            this._applyWardFilters();
        });
        if (street) street.addEventListener("change", () => {
            this.wardMode.street = street.value;
            this.wardMode.page = 0;
            this._applyWardFilters();
        });

        this._bindUnfilledToggle("btn-ward-scheme-unfilled", this.wardMode, () => this._applyWardFilters());
    },

    _bindWardNav() {
        this._bindPageNav(
            "btn-wsp-prev", "btn-wsp-next",
            () => this.wardMode,
            () => this._renderWardFamilies()
        );
    },

    // ── Card builder ──────────────────────────────────────────────

    _buildCard(fam, scheme, query, isSingle = false) {
        const def = this._def(scheme.id);
        const sf = def.statusField;
        const members = fam.members || [];
        const deliveredCount = members.filter(m => m[sf] === "delivered").length;
        const allDelivered = deliveredCount === members.length;
        const q = query || "";

        let html = `<div class="family-card ncc">`;

        // ── Header ──────────────────────────────────────────────
        html += `<div class="ncc-header"><div class="ncc-header-left">`;
        html += `<span class="ncc-house">🏠 ${this._esc(fam.house || "-")}</span>`;
        if (!isSingle) html += `<span class="ncc-count">(${members.length})</span>`;
        if (fam.section) html += `<span class="ncc-section">${this._hl(fam.section, q)}</span>`;
        if (!isSingle && deliveredCount > 0) {
            html += `<span class="ncc-progress ${allDelivered ? "ncc-progress-full" : ""}">
                ${deliveredCount}/${members.length} ✓</span>`;
        }
        html += `</div>`;

        // Edit family button (always shown — family grouping is scheme-independent)
        const editSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        html += `<div style="display:flex;gap:4px;align-items:center;">`;
        html += `<button class="btn btn-secondary btn-sm scheme-edit-family" data-famcode="${this._esc(fam.famcode)}" title="Edit family members" style="padding:4px 8px;">${editSvg}</button>`;

        if (scheme.type === "individual") {
            // "Deliver All" toggle on header (only for multi-member families)
            if (!isSingle) {
                html += `<button class="btn ${allDelivered ? "btn-success" : "btn-secondary"} btn-sm scheme-deliver-all"
                    data-famcode="${this._esc(fam.famcode)}">${allDelivered ? I18n.t("undeliver_all") : I18n.t("deliver_all")}</button>`;
            }
        } else {
            // Family-level deliver button
            html += `<button class="btn ${allDelivered ? "btn-success" : "btn-primary"} btn-sm scheme-deliver-family"
                data-famcode="${this._esc(fam.famcode)}">${allDelivered ? "✓ " + I18n.t("delivered") : I18n.t("deliver")}</button>`;
        }
        html += `</div>`;
        html += `</div>`; // ncc-header

        // ── Members ─────────────────────────────────────────────
        html += `<div class="ncc-members">`;
        members.forEach(m => {
            const isDelivered = m[sf] === "delivered";
            const isTa = I18n.currentLang === "ta";
            const dispName = isTa
                ? (m.name_ta || m.name_seg || m.name_en || m.name || "")
                : (m.name_seg || m.name_en || m.name || m.name_ta || "");
            const isHead = m.is_head === "Yes";

            html += `<div class="ncc-member-row ${isDelivered ? "ncc-delivered" : ""}${m._pending ? " ncc-pending-sync" : ""}">`;
            html += `<div class="ncc-member-info">`;
            const phoneIcon = `<span style="font-size:0.7rem;">&#9742;</span>`;

            // Line 1: Name + data badge + head badge + age/gender + phone last4
            const hasData = !!(m.phone_last4 || m.party_support);
            const dataBadge = hasData ? '<span class="ncc-data-badge"><svg width="16" height="16" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" fill="#22c55e"/><path d="M6.5 11.5l3 3 6-6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : "";
            const ageParts = [m.age, m.gender ? m.gender[0] : ""].filter(Boolean).join(" · ");
            const phonePart = m.phone_last4 ? `<span class="ncc-name-phone">${phoneIcon} ******${this._esc(m.phone_last4)}</span>` : "";
            html += `<span class="ncc-name">${this._hl(dispName, q)}${dataBadge}${isHead ? ` <span class="member-head-badge">👑</span>` : ""}${ageParts ? ` <span class="ncc-name-meta">${this._esc(ageParts)}</span>` : ""}${phonePart}</span>`;

            // Line 2: SL + EPIC + Relation (all merged)
            const line2 = [];
            if (m.sl) line2.push(`${I18n.t("sl_no")} ${this._hl(m.sl, q)}`);
            if (m.voter_id) line2.push(`${I18n.t("id_label")} <span class="ncc-epic">${this._hl(m.voter_id, q)}</span>`);
            const relName = isTa ? (m.relation_name_ta || m.relation_name || "") : (m.relation_name || "");
            if (m.relation_type || relName) {
                line2.push(this._esc([m.relation_type, relName].filter(Boolean).join(" ")));
            }
            if (line2.length) html += `<span class="ncc-sl">${line2.join(" · ")}</span>`;

            // Line 3: Delivered by (only if delivered)
            if (isDelivered && m._delivered_by_name) {
                const atStr = this._fmtDeliveredAt(m._delivered_at);
                html += `<span class="ncc-by">by ${this._esc(m._delivered_by_name)}${atStr ? ` · ${atStr}` : ""}</span>`;
            }
            html += `</div>`; // ncc-member-info

            // Edit person icon — right-aligned
            html += `<svg class="scheme-edit-person" data-voter-id="${m.voter_id}" data-booth="${this._esc(m.booth || "")}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

            if (scheme.type === "individual") {
                html += `<label class="notice-toggle">
                    <input type="checkbox" class="scheme-member-toggle"
                        data-voter-id="${m.voter_id}"
                        data-famcode="${this._esc(fam.famcode)}"
                        data-booth="${this._esc(m.booth || "")}"
                        ${isDelivered ? "checked" : ""}>
                    <span class="notice-toggle-label">${m._pending ? "⟳ " + (I18n.t("syncing") || "Syncing") : isDelivered ? "✓ " + I18n.t("done_label") : "● " + I18n.t("pending")}</span>
                </label>`;
            } else if (isDelivered) {
                html += `<span class="ncc-check-icon">${m._pending ? "⟳" : "✓"}</span>`;
            }

            html += `</div>`; // ncc-member-row
        });
        html += `</div></div>`; // ncc-members, family-card
        return html;
    },

    // ── Card action binding ───────────────────────────────────────

    _bindCardActions(area, mode) {
        const state  = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
        const scheme = state.scheme;
        if (!scheme) return;
        const def    = this._def(scheme.id);
        const sf     = def.statusField;

        // Edit family — available for all scheme types
        area.querySelectorAll(".scheme-edit-family").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                const fam = this._findFam(state, btn.dataset.famcode);
                if (!fam) return;
                this._openModal(
                    fam.members,
                    { famcode: fam.famcode, booth: fam.booth || fam.members[0]?.booth || "" },
                    mode
                );
            });
        });

        // Edit person — pencil icon next to each member name
        area.querySelectorAll(".scheme-edit-person").forEach(icon => {
            icon.addEventListener("click", e => {
                e.stopPropagation();
                e.preventDefault();
                const voterId = icon.dataset.voterId;
                const memberBooth = icon.dataset.booth || "";
                this._openEditPersonModal(voterId, memberBooth, mode);
            });
        });

        // Other-tab "start family" buttons
        area.querySelectorAll(".scheme-other-start-family").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                const fam = this._findFam(state, btn.dataset.famcode);
                if (!fam) return;
                this._openModal(fam.members, null, mode);
            });
        });

        if (scheme.type === "individual") {
            area.querySelectorAll(".scheme-member-toggle").forEach(cb => {
                cb.addEventListener("change", async () => {
                    const vid         = cb.dataset.voterId;
                    const memberBooth = cb.dataset.booth || null;
                    const action      = cb.checked ? "deliver" : "undeliver";
                    if (action === "undeliver") {
                        cb.checked = true;
                        const ok = await Notice.confirmUndeliver();
                        if (!ok) return;
                        cb.checked = false;
                    }
                    cb.disabled = true;
                    await this._toggle(mode, [vid], action, memberBooth);
                });
            });

            // Other tab — individual deliver button (same look as family deliver)
            area.querySelectorAll(".scheme-other-individual-deliver").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const vid         = btn.dataset.voterId;
                    const memberBooth = btn.dataset.booth || null;
                    const isDelivered = btn.classList.contains("btn-success");
                    if (isDelivered) {
                        const ok = await Notice.confirmUndeliver();
                        if (!ok) return;
                    }
                    btn.disabled = true;
                    await this._toggle(mode, [vid], isDelivered ? "undeliver" : "deliver", memberBooth);
                });
            });

            area.querySelectorAll(".scheme-deliver-all").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const fam      = this._findFam(state, btn.dataset.famcode);
                    if (!fam) return;
                    const famBooth = fam.booth || fam.members[0]?.booth || null;
                    const allDelivered = fam.members.every(m => m[sf] === "delivered");
                    if (allDelivered) {
                        const ok = await Notice.confirmUndeliver();
                        if (!ok) return;
                        btn.disabled = true;
                        await this._toggle(mode, fam.members.map(m => m.voter_id), "undeliver", famBooth);
                    } else {
                        btn.disabled = true;
                        await this._toggle(mode, fam.members.filter(m => m[sf] !== "delivered").map(m => m.voter_id), "deliver", famBooth);
                    }
                });
            });
        } else {
            area.querySelectorAll(".scheme-deliver-family").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const fam      = this._findFam(state, btn.dataset.famcode);
                    if (!fam) return;
                    const famBooth = fam.booth || fam.members[0]?.booth || null;
                    const allDelivered = fam.members.every(m => m[sf] === "delivered");
                    if (allDelivered) {
                        const ok = await Notice.confirmUndeliver();
                        if (!ok) return;
                        btn.disabled = true;
                        await this._toggle(mode, fam.members.map(m => m.voter_id), "undeliver", famBooth);
                    } else {
                        btn.disabled = true;
                        await this._toggle(mode, fam.members.map(m => m.voter_id), "deliver", famBooth);
                    }
                });
            });
        }
    },

    async _toggle(mode, voterIds, action, boothOverride = null) {
        // 10-second cooldown between deliver actions
        if (action === "deliver") {
            const now = Date.now();
            const elapsed = now - this._lastDeliverAt;
            if (elapsed < this.DELIVER_COOLDOWN_MS) {
                const secs = Math.ceil((this.DELIVER_COOLDOWN_MS - elapsed) / 1000);
                App.showToast(`Please wait ${secs}s before delivering again`);
                return;
            }
            this._lastDeliverAt = now;
        }
        const state  = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
        const scheme = state.scheme;
        const def    = this._def(scheme.id);
        const sf     = def.statusField;
        const user   = App.getUser();
        const isWard = mode !== "booth";
        const ward   = mode === "admin" ? state.ward : user.ward;
        const booth  = boothOverride || (mode === "booth" ? user.booth : state.booth);
        const idSet  = new Set(voterIds);
        const myName = user.name || "";
        const myTime = new Date().toISOString();
        const newSt  = action === "deliver" ? "delivered" : "not_delivered";

        // Capture original statuses so we can revert on failure
        const originalStatuses = {};
        [...state.familiesAll, ...state.ungroupedAll].forEach(fam =>
            fam.members.forEach(m => {
                if (idSet.has(m.voter_id)) originalStatuses[m.voter_id] = m[sf] || "not_delivered";
            })
        );

        // 1. Optimistic update — mark as done immediately, show pending-sync indicator
        this._applyLocalUpdate(state, idSet, sf, newSt, myName, myTime, action, true);
        this._rerender(mode);

        // 2. Persist to queue (survives offline / page reload)
        const queueId = `${Date.now()}-${Math.random()}`;
        DeliveryQueue.add({
            id: queueId, schemeId: scheme.id, mode,
            ward, booth, voterIds, action, sf,
            originalStatuses, myName, myPhone: user.phone || "",
            myTime, timestamp: Date.now(),
        });

        // 3. Try API immediately
        const res = await (action === "deliver"
            ? def.deliver(ward, booth, voterIds, isWard)
            : def.undeliver(ward, booth, voterIds, isWard));

        if (!res || !res.error) {
            // Success — confirm, clear pending-sync indicator
            DeliveryQueue.remove(queueId);
            this._applyLocalUpdate(state, idSet, sf, newSt, myName, myTime, action, false);
            this._rerender(mode);
            return;
        }

        if (res.detail === "Network error") {
            // Stays in queue — background retry every 30s up to 6 hrs
            App.showToast(I18n.t("no_internet_queue") || "No internet — will sync when connected");
            DeliveryQueue._updateBanner();
        } else {
            // Server/auth error — revert immediately, log to errors tab
            DeliveryQueue.remove(queueId);
            this._revertOptimistic({ schemeId: scheme.id, sf, voterIds, originalStatuses });
            this._rerender(mode);
            App.showToast(res.detail || I18n.t("error"));
            API.post("/api/notice/sync-failures", { failures: [{
                ward, booth, voter_ids: voterIds, action,
                by_phone: user.phone || "", by_name: myName,
                attempted_at: myTime, failed_at: new Date().toISOString(),
                fail_reason: res.detail, scheme_id: scheme.id,
            }]});
        }
    },

    _rerender(mode) {
        if (mode === "booth")     { this._applyBoothFilters(); this._refreshSummary("booth"); }
        else if (mode === "ward") { this._applyWardFilters();  this._refreshSummary("ward"); }
        else                      { this._applyAdminFilters(); this._refreshSummary("admin"); }
    },

    _revertOptimistic({ schemeId, sf, voterIds, originalStatuses }) {
        const idSet = new Set(voterIds);
        [this.boothMode, this.wardMode, this.adminMode].forEach(state => {
            if (!state.scheme || state.scheme.id !== schemeId) return;
            [...state.familiesAll, ...state.ungroupedAll].forEach(fam =>
                fam.members.forEach(m => {
                    if (!idSet.has(m.voter_id)) return;
                    m[sf] = originalStatuses[m.voter_id] || "not_delivered";
                    m._pending = false;
                    m._delivered_by_name = "";
                    m._delivered_at = "";
                })
            );
        });
        ["booth", "ward", "admin"].forEach(md => {
            const st = md === "booth" ? this.boothMode : md === "ward" ? this.wardMode : this.adminMode;
            if (st.scheme?.id === schemeId) this._rerender(md);
        });
    },

    _applyLocalUpdate(state, idSet, sf, newSt, myName, myTime, action, pending = false) {
        [...state.familiesAll, ...state.ungroupedAll].forEach(fam => {
            fam.members.forEach(m => {
                if (!idSet.has(m.voter_id)) return;
                m[sf] = newSt;
                m._pending = pending;
                if (action === "deliver") { m._delivered_by_name = myName; m._delivered_at = myTime; }
                else                     { m._delivered_by_name = "";     m._delivered_at = ""; }
            });
        });
    },

    // ── Summary bar ───────────────────────────────────────────────

    _refreshSummary(mode) {
        const state = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
        if (!state.scheme) return;
        const def = this._def(state.scheme.id);
        const sf  = def.statusField;
        const p   = mode === "booth" ? "booth-scheme" : mode === "ward" ? "ward-scheme" : "admin-scheme";

        const fillBar = (barId, families, members, familyLabel, voterLabel) => {
            const bar = document.getElementById(barId);
            if (!bar) return;
            const deliveredVoters   = members.filter(m => m[sf] === "delivered").length;
            const totalVoters       = members.length;
            const deliveredFamilies = families.filter(f => f.members.length > 0 && f.members.every(m => m[sf] === "delivered")).length;
            const totalFamilies     = families.length;
            if (!totalVoters) { bar.innerHTML = ""; return; }
            const pct = Math.round(deliveredVoters / totalVoters * 100);
            bar.innerHTML = `<div class="notice-summary">
                ${totalFamilies ? `<span class="notice-summary-delivered">${deliveredFamilies}/${totalFamilies} ${familyLabel}</span>
                <span class="notice-summary-sep">·</span>` : ""}
                <span class="notice-summary-delivered">${deliveredVoters}/${totalVoters} ${voterLabel}</span>
                <span class="notice-summary-pct">${pct}% ${I18n.t("done_pct")}</span>
            </div>`;
        };

        const filteredFamilies = state.families || state.familiesAll;
        const filteredUngrouped = state.ungrouped || state.ungroupedAll;
        const allFamilies = [...filteredFamilies, ...filteredUngrouped];
        const allMembers  = allFamilies.flatMap(f => f.members);

        // Overall bar (above tabs)
        fillBar(`${p}-summary`,    allFamilies,        allMembers,                               I18n.t("families"), I18n.t("voters_label"));
        // Family tab bar
        fillBar(`${p}-family-summary`, filteredFamilies, filteredFamilies.flatMap(f => f.members), I18n.t("families"), I18n.t("voters_label"));
        // Other tab bar — single voters, no family count needed
        fillBar(`${p}-other-summary`,  [],               filteredUngrouped.flatMap(f => f.members), "", I18n.t("voters_label"));
    },

    _updateTabCounts(viewSel, state) {
        const famCount   = (state.families  || []).length;
        const otherCount = (state.ungrouped || []).length;
        document.querySelectorAll(`${viewSel} .tab[data-scheme-tab]`).forEach(tab => {
            if (tab.dataset.schemeTab === "family") {
                tab.textContent = `${I18n.t("family")} (${famCount})`;
            } else if (tab.dataset.schemeTab === "other") {
                tab.textContent = `${I18n.t("other")} (${otherCount})`;
            }
        });
    },

    // ── Shared helpers ────────────────────────────────────────────

    _populateSchemeDropdown(selId, onChange) {
        const old = document.getElementById(selId);
        if (!old) return;
        const sel = old.cloneNode(false); // fresh, no options
        sel.id = old.id;
        old.parentNode.replaceChild(sel, old);
        sel.innerHTML = `<option value="">${I18n.t("select_scheme")}</option>`;
        this.schemes.forEach(s => {
            const o = document.createElement("option");
            o.value = s.id; o.textContent = s.name; sel.appendChild(o);
        });
        sel.addEventListener("change", () => onChange(sel.value));
    },

    _resetTabUI(viewSel, familyPanelId, otherPanelId) {
        document.querySelectorAll(`${viewSel} .tab[data-scheme-tab]`).forEach(t => {
            t.classList.toggle("active", t.dataset.schemeTab === "family");
        });
        document.getElementById(familyPanelId).style.display = "block";
        document.getElementById(otherPanelId).style.display  = "none";
    },

    _bindTabs(viewSel, familyPanelId, otherPanelId, onSwitch) {
        document.querySelectorAll(`${viewSel} .tab[data-scheme-tab]`).forEach(tab => {
            const fresh = tab.cloneNode(true);
            tab.parentNode.replaceChild(fresh, tab);
            fresh.addEventListener("click", () => {
                document.querySelectorAll(`${viewSel} .tab[data-scheme-tab]`).forEach(t => t.classList.remove("active"));
                fresh.classList.add("active");
                const isFamily = fresh.dataset.schemeTab === "family";
                document.getElementById(familyPanelId).style.display = isFamily ? "block" : "none";
                document.getElementById(otherPanelId).style.display  = isFamily ? "none"  : "block";
                onSwitch(fresh.dataset.schemeTab);
            });
        });
    },

    _bindPageNav(prevId, nextId, getState, renderFn) {
        const prev = document.getElementById(prevId);
        const next = document.getElementById(nextId);
        const ps   = this.PAGE_SIZE;
        if (prev) {
            const np = prev.cloneNode(true);
            prev.parentNode.replaceChild(np, prev);
            np.addEventListener("click", () => {
                const st = getState();
                if (st.page > 0) { st.page--; renderFn(); }
            });
        }
        if (next) {
            const nn = next.cloneNode(true);
            next.parentNode.replaceChild(nn, next);
            nn.addEventListener("click", () => {
                const st    = getState();
                const pages = Math.ceil(st.families.length / ps);
                if (st.page < pages - 1) { st.page++; renderFn(); }
            });
        }
    },

    _renderPage(state, areaId, navId, emptyId, counterId, prevId, nextId, mode) {
        const area  = document.getElementById(areaId);
        const nav   = document.getElementById(navId);
        const empty = document.getElementById(emptyId);
        const ps    = this.PAGE_SIZE;
        const total = state.families.length;

        if (total === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            if (empty) { empty.style.display = "block"; empty.querySelector("p").textContent = I18n.t("no_families_found"); }
            return;
        }
        if (empty) empty.style.display = "none";

        const pages = Math.ceil(total / ps);
        const pg    = Math.min(state.page, pages - 1);
        state.page  = pg;

        document.getElementById(counterId).textContent = `${pg + 1} / ${pages}`;
        document.getElementById(prevId).disabled = pg === 0;
        document.getElementById(nextId).disabled = pg >= pages - 1;
        nav.style.display = pages > 1 ? "flex" : "none";

        const slice = state.families.slice(pg * ps, pg * ps + ps);
        area.innerHTML = slice.map(fam => this._buildCard(fam, state.scheme, state.search)).join("");
        this._bindCardActions(area, mode);
    },

    _filterFams(arr, street, search, unfilledOnly) {
        let f = arr;
        if (street) f = f.filter(fam => fam.members.some(m => m.section === street));
        if (search) {
            const q = search.toLowerCase().trim();
            f = f.filter(fam => fam.members.some(m =>
                (m.sl || "").toLowerCase().includes(q) ||
                (m.voter_id || "").toLowerCase().includes(q) ||
                (m.name || "").toLowerCase().includes(q) ||
                (m.name_en || "").toLowerCase().includes(q) ||
                (m.name_ta || "").includes(q) ||
                (m.section || "").toLowerCase().includes(q)
            ));
        }
        if (unfilledOnly) {
            f = f.filter(fam => fam.members.some(m => !(m.phone_last4 || m.party_support)));
        }
        return f;
    },

    _bindUnfilledToggle(btnId, state, applyFn) {
        const btn = this._clone(btnId);
        if (!btn) return;
        btn.textContent = state.unfilledOnly ? "Unfilled" : "All";
        if (state.unfilledOnly) { btn.classList.remove("btn-secondary"); btn.classList.add("btn-primary"); }
        btn.addEventListener("click", () => {
            state.unfilledOnly = !state.unfilledOnly;
            state.page = 0;
            btn.textContent = state.unfilledOnly ? "Unfilled" : "All";
            if (state.unfilledOnly) { btn.classList.remove("btn-secondary"); btn.classList.add("btn-primary"); }
            else { btn.classList.remove("btn-primary"); btn.classList.add("btn-secondary"); }
            applyFn();
        });
    },

    _extractStreets(fams) {
        return [...new Set(fams.flatMap(f => f.members.map(m => m.section)).filter(Boolean))].sort();
    },

    _fillStreetSel(selId, streets) {
        const sel = document.getElementById(selId);
        if (!sel) return;
        sel.innerHTML = `<option value="">${I18n.t("all_streets")}</option>`;
        streets.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o); });
    },

    _findFam(state, famcode) {
        return [...state.familiesAll, ...state.ungroupedAll].find(f => f.famcode === famcode) || null;
    },

    _clone(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        const n = el.cloneNode(true);
        el.parentNode.replaceChild(n, el);
        return n;
    },

    // ── Admin: init ───────────────────────────────────────────────

    async initAdmin() {
        if (!App.getUser()) return;
        App.showViewLoading("view-admin-scheme");
        const res = await API.getSchemes();
        this.schemes = res.schemes || [];
        console.log("[scheme-admin] schemes loaded:", this.schemes.length);

        const state = this.adminMode;
        Object.assign(state, {
            scheme: null, tab: "family",
            ward: "", booth: "",
            familiesAll: [], families: [],
            ungroupedAll: [], ungrouped: [],
            page: 0, search: "", otherSearch: "",
            unfilledOnly: false,
        });

        // Hide ward + booth rows until scheme is picked
        document.getElementById("admin-scheme-ward-row").style.display  = "none";
        document.getElementById("admin-scheme-booth-row").style.display = "none";
        document.getElementById("admin-scheme-content").style.display   = "none";
        document.getElementById("admin-scheme-init").style.display      = "block";

        this._populateSchemeDropdown("admin-scheme-select", id => this._onAdminSchemeChange(id));
        this._bindAdminFilters();
        this._bindAdminTabs();
        this._bindAdminNav();
        this._bindAddSchemeModal();
        this._bindManageSchemesModal();

        // Auto-select if only one scheme
        if (this.schemes.length === 1) {
            const sel = document.getElementById("admin-scheme-select");
            if (sel) { sel.value = this.schemes[0].id; }
            await this._onAdminSchemeChange(this.schemes[0].id);
        }

        App.hideViewLoading("view-admin-scheme");
    },

    async _onAdminSchemeChange(schemeId) {
        console.log("[scheme-admin] _onAdminSchemeChange called, schemeId:", schemeId);
        const state = this.adminMode;
        state.scheme = this.schemes.find(s => s.id === schemeId) || null;
        console.log("[scheme-admin] scheme found:", state.scheme ? state.scheme.name : "null");
        state.ward   = "";
        state.booth  = "";
        state.familiesAll  = [];
        state.ungroupedAll = [];

        if (!state.scheme) {
            console.log("[scheme-admin] no scheme selected, hiding content");
            document.getElementById("admin-scheme-ward-row").style.display  = "none";
            document.getElementById("admin-scheme-booth-row").style.display = "none";
            document.getElementById("admin-scheme-content").style.display   = "none";
            document.getElementById("admin-scheme-init").style.display      = "block";
            return;
        }

        // Show ward row, load wards, auto-select first
        console.log("[scheme-admin] showing ward row, calling _loadAdminWards");
        document.getElementById("admin-scheme-ward-row").style.display = "block";
        await this._loadAdminWards();
    },

    async _loadAdminWards() {
        console.log("[scheme-admin] _loadAdminWards called");
        const wardSel = document.getElementById("admin-scheme-ward");
        console.log("[scheme-admin] wardSel element:", wardSel ? "found" : "NULL");
        wardSel.innerHTML = `<option value="">${I18n.t("select_ward")}</option>`;

        // Use notice admin stats — returns wards with names, works for all schemes
        App.showViewLoading("view-admin-scheme");
        console.log("[scheme-admin] calling API.getNoticeAdminStats");
        const res = await API.getNoticeAdminStats("", "");
        App.hideViewLoading("view-admin-scheme");
        console.log("[scheme-admin] API response:", res.error ? "ERROR: " + res.detail : "OK");
        if (res.error) { console.log("[scheme-admin] aborting due to API error"); return; }

        const wards = res.wards || [];
        console.log("[scheme-admin] wards received:", wards.length, wards.map(w => w.ward));
        wards.forEach(w => {
            const o = document.createElement("option");
            o.value = w.ward; o.textContent = w.ward_name || w.ward; wardSel.appendChild(o);
        });

        // Auto-select first ward and load data
        if (wards.length > 0) {
            console.log("[scheme-admin] auto-selecting first ward:", wards[0].ward);
            wardSel.value         = wards[0].ward;
            this.adminMode.ward   = wards[0].ward;
            this.adminMode.booth  = "";
            await this._loadAdminBooths(wards[0].ward);
            console.log("[scheme-admin] booths loaded, now loading data");
            await this._loadAdminData();
            console.log("[scheme-admin] data loaded successfully");
        } else {
            console.log("[scheme-admin] no wards found - nothing to display");
        }
    },

    async _loadAdminBooths(ward) {
        const boothRow = document.getElementById("admin-scheme-booth-row");
        const boothSel = document.getElementById("admin-scheme-booth");
        boothSel.innerHTML = `<option value="">${I18n.t("all_booths")}</option>`;
        if (!ward) { boothRow.style.display = "none"; return; }
        const res = await API.getWardBoothsList(ward);
        if (res.error) { boothRow.style.display = "none"; return; }
        (res.booths || []).forEach(b => {
            const o = document.createElement("option");
            const val   = typeof b === "object" ? (b.booth || "") : b;
            const label = typeof b === "object"
                ? (Ward.formatBoothLabel(b.booth_name, b.booth_number, 40, b.booth_name_tamil) || val)
                : val;
            o.value = val; o.textContent = label; boothSel.appendChild(o);
        });
        boothRow.style.display = "block";
    },


    async _loadAdminData() {
        const state = this.adminMode;
        const content = document.getElementById("admin-scheme-content");
        const initMsg = document.getElementById("admin-scheme-init");

        if (!state.scheme || !state.ward) {
            content.style.display = "none";
            initMsg.style.display = "block";
            return;
        }

        initMsg.style.display    = "none";
        content.style.display    = "block";
        state.page        = 0;
        state.search      = "";
        const searchEl = document.getElementById("admin-scheme-search");
        if (searchEl) searchEl.value = "";
        this._resetTabUI("#view-admin-scheme", "admin-scheme-family-panel", "admin-scheme-other-panel");

        const def = this._def(state.scheme.id);
        App.showViewLoading("view-admin-scheme");
        const res = await def.loadAdmin(state.ward, state.booth);
        App.hideViewLoading("view-admin-scheme");
        if (res.error) { App.showToast(res.detail || I18n.t("error")); return; }

        const { families, ungrouped } = this._parse(state.scheme.id, res);
        state.familiesAll  = families;
        state.ungroupedAll = ungrouped;

        this._applyAdminFilters();
        this._refreshSummary("admin");
    },

    _applyAdminFilters() {
        const state = this.adminMode;
        state.families = this._filterFams(state.familiesAll, "", state.search, state.unfilledOnly);
        state.ungrouped = this._filterFams(state.ungroupedAll, "", state.search, state.unfilledOnly);
        if (state.tab === "family") this._renderAdminFamilies();
        else this._renderAdminOther();
        this._refreshSummary("admin");
        this._updateTabCounts("#view-admin-scheme", state);
    },

    _renderAdminFamilies() {
        const state = this.adminMode;
        this._renderPage(
            state, "admin-scheme-family-area", "admin-scheme-nav",
            "admin-scheme-empty", "admin-scheme-counter",
            "btn-asp-prev", "btn-asp-next", "admin"
        );
    },

    _renderAdminOther() {
        const state = this.adminMode;
        const area  = document.getElementById("admin-scheme-other-area");
        if (!area) return;
        let html = `<button class="btn btn-primary btn-sm btn-scheme-new-family" style="margin-bottom:12px;width:100%;">${I18n.t("new_family")}</button>`;
        if (!state.ungrouped.length) {
            html += `<div class="empty-state"><p>${I18n.t("no_ungrouped_voters")}</p></div>`;
        } else {
            html += state.ungrouped.map(fam => this._buildOtherRow(fam.members[0], fam.famcode, state.scheme, state.search)).join("");
        }
        area.innerHTML = html;
        area.querySelector(".btn-scheme-new-family")?.addEventListener("click", () => this._openModal([], null, "admin"));
        this._bindCardActions(area, "admin");
    },

    _bindAdminTabs() {
        this._bindTabs("#view-admin-scheme", "admin-scheme-family-panel", "admin-scheme-other-panel",
            tab => { this.adminMode.tab = tab; this.adminMode.page = 0; this._applyAdminFilters(); });
    },

    _bindAdminFilters() {
        const c = id => this._clone(id);
        const schemeSel = c("admin-scheme-select");
        const wardSel   = c("admin-scheme-ward");
        const boothSel  = c("admin-scheme-booth");
        const search = c("admin-scheme-search");

        if (schemeSel) schemeSel.addEventListener("change", () => this._onAdminSchemeChange(schemeSel.value));
        if (wardSel) wardSel.addEventListener("change", async () => {
            this.adminMode.ward  = wardSel.value;
            this.adminMode.booth = "";
            const bs = document.getElementById("admin-scheme-booth");
            if (bs) bs.value = "";
            await this._loadAdminBooths(wardSel.value);
            await this._loadAdminData();
        });
        if (boothSel) boothSel.addEventListener("change", async () => {
            this.adminMode.booth = boothSel.value;
            await this._loadAdminData();
        });
        if (search) search.addEventListener("input", () => {
            this.adminMode.search = search.value;
            this.adminMode.page   = 0;
            this._applyAdminFilters();
        });

        this._bindUnfilledToggle("btn-admin-scheme-unfilled", this.adminMode, () => this._applyAdminFilters());
    },

    _bindAdminNav() {
        this._bindPageNav(
            "btn-asp-prev", "btn-asp-next",
            () => this.adminMode,
            () => this._renderAdminFamilies()
        );
    },

    // ── Manage Schemes modal (admin only) ─────────────────────────

    _bindManageSchemesModal() {
        const openBtn = document.getElementById("btn-manage-schemes");
        if (openBtn) {
            const nb = openBtn.cloneNode(true);
            openBtn.parentNode.replaceChild(nb, openBtn);
            nb.addEventListener("click", () => this._openManageSchemesModal());
        }
        const closeBtn = document.getElementById("btn-manage-schemes-close");
        if (closeBtn) {
            const nc = closeBtn.cloneNode(true);
            closeBtn.parentNode.replaceChild(nc, closeBtn);
            nc.addEventListener("click", () => this._closeManageSchemesModal());
        }
        const overlay = document.getElementById("modal-manage-schemes-overlay");
        if (overlay) {
            const no = overlay.cloneNode(true);
            overlay.parentNode.replaceChild(no, overlay);
            no.addEventListener("click", () => this._closeManageSchemesModal());
        }
    },

    async _openManageSchemesModal() {
        document.getElementById("modal-manage-schemes").style.display = "flex";
        await this._renderManageList();
    },

    _closeManageSchemesModal() {
        document.getElementById("modal-manage-schemes").style.display = "none";
    },

    // ── helpers to switch modal between list-mode and edit-mode ──────

    _manageModalListMode() {
        document.querySelector("#modal-manage-schemes h3").textContent = "Manage Schemes";
        document.getElementById("btn-manage-schemes-close").style.display = "";
    },

    _manageModalEditMode(schemeName) {
        document.querySelector("#modal-manage-schemes h3").textContent = `Edit — ${schemeName}`;
        document.getElementById("btn-manage-schemes-close").style.display = "none";
    },

    async _renderManageList() {
        this._manageModalListMode();

        const list = document.getElementById("manage-schemes-list");
        list.innerHTML = `<div style="padding:8px;color:var(--text-muted);font-size:0.8rem;">Loading…</div>`;

        const res = await API.getAdminAllSchemes();
        if (res.error) { list.innerHTML = `<div style="padding:8px;color:var(--danger);">Failed to load schemes.</div>`; return; }

        const schemes = res.schemes || [];

        // Built-in schemes
        let html = `<div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;padding:4px 0 8px;">Built-in (Notice & Coupon)</div>`;
        ["Notice", "Coupon"].forEach(name => {
            html += `<div class="manage-scheme-row manage-scheme-row-builtin">
                <div class="manage-scheme-info">
                    <span class="manage-scheme-name">${this._esc(name)}</span>
                    <span class="manage-scheme-type">${name === "Notice" ? "Voter Level" : "Family Level"}</span>
                </div>
                <span style="font-size:0.7rem;color:var(--text-muted);padding:4px 8px;">Built-in</span>
            </div>`;
        });

        if (schemes.length > 0) {
            html += `<div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;padding:12px 0 8px;">Custom Schemes</div>`;
            schemes.forEach(s => {
                const typeLabel = s.type === "individual" ? "Voter Level" : "Family Level";
                const enabledBadge = s.enabled
                    ? `<span class="manage-scheme-badge manage-scheme-badge-on">On</span>`
                    : `<span class="manage-scheme-badge manage-scheme-badge-off">Off</span>`;
                html += `<div class="manage-scheme-row" data-scheme-id="${this._esc(s.id)}">
                    <div class="manage-scheme-info" style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span class="manage-scheme-name">${this._esc(s.name)}</span>
                            ${enabledBadge}
                        </div>
                        <span class="manage-scheme-type">${typeLabel}</span>
                    </div>
                    <div style="display:flex;gap:6px;flex-shrink:0;">
                        <button class="btn btn-secondary btn-sm btn-ms-edit" data-id="${this._esc(s.id)}" data-name="${this._esc(s.name)}" data-type="${s.type}">Edit</button>
                        <button class="btn btn-danger btn-sm btn-ms-delete" data-id="${this._esc(s.id)}" data-name="${this._esc(s.name)}">Delete</button>
                    </div>
                </div>`;
            });
        } else {
            html += `<div style="padding:16px 0;color:var(--text-muted);font-size:0.875rem;">No custom schemes yet.</div>`;
        }

        list.innerHTML = html;
        this._bindManageListActions(list);
    },

    _bindManageListActions(list) {
        list.querySelectorAll(".btn-ms-edit").forEach(btn => {
            btn.addEventListener("click", () => {
                this._showEditView(btn.dataset.id, btn.dataset.name, btn.dataset.type);
            });
        });

        list.querySelectorAll(".btn-ms-delete").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id   = btn.dataset.id;
                const name = btn.dataset.name;
                if (!btn.dataset.confirm) {
                    btn.dataset.confirm = "1";
                    btn.textContent = "Confirm?";
                    btn.style.background = "var(--danger)";
                    setTimeout(() => { if (btn.dataset.confirm) { delete btn.dataset.confirm; btn.textContent = "Delete"; btn.style.background = ""; } }, 3000);
                    return;
                }
                delete btn.dataset.confirm;
                App.setBtnLoading(btn, true);
                const res = await API.deleteScheme(id);
                App.setBtnLoading(btn, false);
                if (res.error) { App.showToast(res.detail || "Failed to delete"); return; }
                App.showToast(`"${name}" deleted`);
                await this._renderManageList();
                const schemesRes = await API.getSchemes();
                this.schemes = schemesRes.schemes || [];
                this._populateSchemeDropdown("admin-scheme-select", sid => this._onAdminSchemeChange(sid));
                if (this.adminMode.scheme?.id === id) {
                    this.adminMode.scheme = null;
                    document.getElementById("admin-scheme-select").value = "";
                    document.getElementById("admin-scheme-content").style.display = "none";
                    document.getElementById("admin-scheme-init").style.display = "block";
                }
            });
        });
    },

    // ── Full-modal edit view (replaces list; no Close button) ────────

    _showEditView(id, currentName, currentType) {
        this._manageModalEditMode(currentName);

        const list = document.getElementById("manage-schemes-list");
        list.innerHTML = `
            <div style="padding:4px 0 8px;">
                <div style="margin-bottom:12px;">
                    <label style="font-size:0.8rem;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Scheme Name</label>
                    <input class="select-field ms-edit-name" type="text" value="${this._esc(currentName)}" maxlength="60" autocomplete="off"/>
                </div>
                <div style="margin-bottom:8px;">
                    <label style="font-size:0.8rem;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Type</label>
                    <select class="select-field ms-edit-type">
                        <option value="individual" ${currentType === "individual" ? "selected" : ""}>Voter Level (Individual)</option>
                        <option value="family"     ${currentType === "family"     ? "selected" : ""}>Family Level</option>
                    </select>
                </div>
                <div class="ms-edit-error" style="color:var(--danger);font-size:0.75rem;min-height:16px;margin-bottom:8px;"></div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-primary ms-edit-save" style="flex:1;">Save Changes</button>
                    <button class="btn btn-secondary ms-edit-back" style="flex:1;">Back</button>
                </div>
            </div>`;

        setTimeout(() => list.querySelector(".ms-edit-name")?.focus(), 50);

        list.querySelector(".ms-edit-back").addEventListener("click", () => this._renderManageList());

        list.querySelector(".ms-edit-save").addEventListener("click", async () => {
            const name   = (list.querySelector(".ms-edit-name").value || "").trim();
            const type   = list.querySelector(".ms-edit-type").value;
            const errEl  = list.querySelector(".ms-edit-error");
            const saveBtn = list.querySelector(".ms-edit-save");
            if (!name) { errEl.textContent = "Name is required."; return; }
            App.setBtnLoading(saveBtn, true);
            const res = await API.updateScheme(id, name, type);
            App.setBtnLoading(saveBtn, false);
            if (res.error) { errEl.textContent = res.detail || "Failed to save."; return; }
            App.showToast("Scheme updated");
            await this._renderManageList();
            const schemesRes = await API.getSchemes();
            this.schemes = schemesRes.schemes || [];
            this._populateSchemeDropdown("admin-scheme-select", sid => this._onAdminSchemeChange(sid));
            if (this.adminMode.scheme?.id === id) {
                this.adminMode.scheme = this.schemes.find(s => s.id === id) || null;
            }
        });
    },

    // ── Add Scheme modal (admin only) ─────────────────────────────

    _bindAddSchemeModal() {
        const btn = document.getElementById("btn-add-scheme");
        if (!btn) return;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", () => this._openAddSchemeModal());

        const cancel = document.getElementById("btn-add-scheme-cancel");
        if (cancel) {
            const nc = cancel.cloneNode(true);
            cancel.parentNode.replaceChild(nc, cancel);
            nc.addEventListener("click", () => this._closeAddSchemeModal());
        }
        const overlay = document.getElementById("modal-add-scheme-overlay");
        if (overlay) {
            const no = overlay.cloneNode(true);
            overlay.parentNode.replaceChild(no, overlay);
            no.addEventListener("click", () => this._closeAddSchemeModal());
        }
        const submit = document.getElementById("btn-add-scheme-submit");
        if (submit) {
            const ns = submit.cloneNode(true);
            submit.parentNode.replaceChild(ns, submit);
            ns.addEventListener("click", () => this._createScheme());
        }
    },

    _openAddSchemeModal() {
        const modal = document.getElementById("modal-add-scheme");
        if (!modal) return;
        document.getElementById("add-scheme-name").value = "";
        document.getElementById("add-scheme-type").value = "family";
        document.getElementById("add-scheme-error").textContent = "";
        modal.style.display = "flex";
        setTimeout(() => document.getElementById("add-scheme-name")?.focus(), 100);
    },

    _closeAddSchemeModal() {
        const modal = document.getElementById("modal-add-scheme");
        if (modal) modal.style.display = "none";
    },

    async _createScheme() {
        const name = (document.getElementById("add-scheme-name")?.value || "").trim();
        const type = document.getElementById("add-scheme-type")?.value || "family";
        const errEl = document.getElementById("add-scheme-error");

        if (!name) { errEl.textContent = "Please enter a scheme name."; return; }

        const submitBtn = document.getElementById("btn-add-scheme-submit");
        if (submitBtn) App.setBtnLoading(submitBtn, true);
        const res = await API.createScheme(name, type);
        if (submitBtn) { App.setBtnLoading(submitBtn, false); submitBtn.textContent = "Create Scheme"; }

        if (res.error) { errEl.textContent = res.detail || "Failed to create scheme"; return; }

        this._closeAddSchemeModal();
        App.showToast(`"${name}" scheme created!`);

        // Reload schemes list and refresh the dropdown
        const schemesRes = await API.getSchemes();
        this.schemes = schemesRes.schemes || [];
        this._populateSchemeDropdown("admin-scheme-select", id => this._onAdminSchemeChange(id));

        // Auto-select the new scheme
        const newScheme = res.scheme;
        if (newScheme) {
            const sel = document.getElementById("admin-scheme-select");
            if (sel) sel.value = newScheme.id;
            await this._onAdminSchemeChange(newScheme.id);
        }
    },

    // ── Other-tab voter row ───────────────────────────────────────

    _buildOtherRow(m, famcode, scheme, query) {
        const def = this._def(scheme.id);
        const sf  = def.statusField;
        const isDelivered = m[sf] === "delivered";
        const isTa = I18n.currentLang === "ta";
        const dispName = isTa
            ? (m.name_ta || m.name_seg || m.name_en || m.name || "")
            : (m.name_seg || m.name_en || m.name || m.name_ta || "");
        const q = query || "";

        let html = `<div class="other-search-row ncc-other-row ${isDelivered ? "ncc-delivered" : ""}">`;
        html += `<div class="ncc-member-info">`;
        const phoneIconO = `<span style="font-size:0.7rem;">&#9742;</span>`;

        // Line 1: Name + data badge + age/gender + phone last4
        const hasData = !!(m.phone_last4 || m.party_support);
        const dataBadge = hasData ? '<span class="ncc-data-badge"><svg width="16" height="16" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" fill="#22c55e"/><path d="M6.5 11.5l3 3 6-6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : "";
        const ageParts = [m.age, m.gender ? m.gender[0] : ""].filter(Boolean).join(" · ");
        const phonePart = m.phone_last4 ? `<span class="ncc-name-phone">${phoneIconO} ******${this._esc(m.phone_last4)}</span>` : "";
        html += `<span class="ncc-name">${this._hl(dispName, q)}${dataBadge}${ageParts ? ` <span class="ncc-name-meta">${this._esc(ageParts)}</span>` : ""}${phonePart}</span>`;

        // Line 2: SL + EPIC + Section + Relation (all merged)
        const line2 = [];
        if (m.sl) line2.push(`${I18n.t("sl_no")} ${this._hl(m.sl, q)}`);
        if (m.voter_id) line2.push(`${I18n.t("id_label")} <span class="ncc-epic">${this._hl(m.voter_id, q)}</span>`);
        if (m.section) line2.push(this._esc(m.section));
        const relNameO = isTa ? (m.relation_name_ta || m.relation_name || "") : (m.relation_name || "");
        if (m.relation_type || relNameO) line2.push(this._esc([m.relation_type, relNameO].filter(Boolean).join(" ")));
        if (line2.length) html += `<span class="ncc-sl">${line2.join(" · ")}</span>`;

        // Line 3: Delivered by (only if delivered)
        if (isDelivered && m._delivered_by_name) {
            const atStr = this._fmtDeliveredAt(m._delivered_at);
            html += `<span class="ncc-by">by ${this._esc(m._delivered_by_name)}${atStr ? ` · ${atStr}` : ""}</span>`;
        }
        html += `</div>`;

        html += `<div style="display:flex;gap:4px;align-items:center;">`;
        html += `<svg class="scheme-edit-person" data-voter-id="${m.voter_id}" data-booth="${this._esc(m.booth || "")}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        html += `<button class="btn btn-secondary btn-sm scheme-other-start-family"
            data-famcode="${this._esc(famcode)}" title="${I18n.t("add_to_family")}" style="padding:4px 8px;white-space:nowrap;">${I18n.t("add_to_family")}</button>`;

        if (scheme.type === "individual") {
            html += `<button class="btn ${isDelivered ? "btn-success" : "btn-primary"} btn-sm scheme-other-individual-deliver"
                data-voter-id="${m.voter_id}" data-famcode="${this._esc(famcode)}"
                data-booth="${this._esc(m.booth || "")}">${isDelivered ? "✓ " + I18n.t("done_label") : I18n.t("deliver")}</button>`;
        } else {
            html += `<button class="btn ${isDelivered ? "btn-success" : "btn-primary"} btn-sm scheme-deliver-family"
                data-famcode="${this._esc(famcode)}">${isDelivered ? "✓" : I18n.t("deliver")}</button>`;
        }
        html += `</div></div>`;
        return html;
    },

    // ── Edit person modal ─────────────────────────────────────────

    _editPersonVoterId: null,
    _editPersonBooth: null,
    _editPersonMode: null,

    async _openEditPersonModal(voterId, booth, mode) {
        const state = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
        const user = App.getUser();
        const ward = mode === "admin" ? state.ward : user.ward;
        const memberBooth = booth || (mode === "booth" ? user.booth : state.booth);

        // Find voter data in current state
        let voter = null;
        const allFams = [...(state.familiesAll || []), ...(state.ungroupedAll || [])];
        for (const fam of allFams) {
            for (const m of fam.members) {
                if (m.voter_id === voterId) { voter = m; break; }
            }
            if (voter) break;
        }
        if (!voter) { App.showToast("Voter not found"); return; }

        this._editPersonVoterId = voterId;
        this._editPersonBooth = memberBooth;
        this._editPersonMode = mode;

        const modal = document.getElementById("modal-edit-person");
        const infoDiv = document.getElementById("edit-person-info");
        const phonesDiv = document.getElementById("edit-person-phones");
        const partySelect = document.getElementById("edit-person-party");
        const partyCustom = document.getElementById("edit-person-party-custom");
        const errorDiv = document.getElementById("edit-person-error");

        errorDiv.style.display = "none";
        errorDiv.textContent = "";

        // Populate read-only info
        const isTa = I18n.currentLang === "ta";
        const name = isTa
            ? (voter.name_ta || voter.name_seg || voter.name_en || voter.name || "")
            : (voter.name_seg || voter.name_en || voter.name || voter.name_ta || "");
        const relType = voter.relation_type || voter.relationship || "";
        const relName = isTa ? (voter.relation_name_ta || voter.relation_name || "") : (voter.relation_name || "");
        const gender = voter.gender || "";
        const infoLines = [
            `<b>${this._esc(name)}</b>`,
            `${I18n.t("voter_id")}: ${this._esc(voterId)}`,
            relType || relName ? `${this._esc(relType)} ${this._esc(relName)}` : "",
            gender ? `${this._esc(gender)}, ${I18n.t("age")}: ${voter.age || ""}` : "",
        ].filter(Boolean);
        infoDiv.innerHTML = infoLines.join("<br>");

        // Fetch decrypted phones
        phonesDiv.innerHTML = `<div style="font-size:0.75rem;color:var(--text-muted);">${I18n.t("loading")}</div>`;
        this._editPersonExistingPhones = [];
        this._editPersonNewPhones = [];
        try {
            const revealFn = mode === "booth" ? API.revealPhone : API.wardRevealPhone;
            const res = await revealFn.call(API, ward, memberBooth, voterId);
            if (res && !res.error && res.phones) {
                this._editPersonExistingPhones = res.phones.map(p => p.number).filter(Boolean);
            }
        } catch (e) {
            console.log("edit_person_reveal_error", e);
        }

        // Render phone display
        this._renderEditPersonPhones();

        // Party support
        const partyVal = voter.party_support || "";
        const knownParties = ["DMK", "AIADMK", "NTK", "TVK", "BJP", "Congress", "PMK", "DMDK", "VCK", "CPI", "MNM", "AMMK", "MDMK", "TMC(M)", "CPM", "Neutral"];
        if (knownParties.includes(partyVal)) {
            partySelect.value = partyVal;
            partyCustom.style.display = "none";
            partyCustom.value = "";
        } else if (partyVal) {
            partySelect.value = "Others";
            partyCustom.style.display = "block";
            partyCustom.value = partyVal;
        } else {
            partySelect.value = "";
            partyCustom.style.display = "none";
            partyCustom.value = "";
        }

        // Show modal
        modal.style.display = "flex";

        // Bind events (clone to remove old listeners)
        this._bindEditPersonEvents();
    },

    _renderEditPersonPhones() {
        const phonesDiv = document.getElementById("edit-person-phones");
        const existing = this._editPersonExistingPhones || [];
        const newPhones = this._editPersonNewPhones || [];
        let html = "";

        // Existing phones — masked, read-only
        existing.forEach(phone => {
            const masked = "******" + phone.slice(-4);
            html += `<div class="edit-person-phone-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
                <div class="select-field" style="flex:1;font-size:0.85rem;background:var(--bg);color:var(--text-primary);cursor:default;letter-spacing:1px;">${this._esc(masked)}</div>
            </div>`;
        });

        // New phones — editable inputs
        newPhones.forEach((phone, i) => {
            html += `<div class="edit-person-phone-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
                <input type="tel" class="select-field edit-person-new-phone" value="${this._esc(phone)}" maxlength="10" pattern="[0-9]{10}" placeholder="10 digit number" style="flex:1;font-size:0.85rem;" data-index="${i}" />
                <button class="btn btn-secondary btn-sm edit-person-phone-remove" data-index="${i}" style="padding:4px 8px;font-size:0.7rem;color:var(--danger);">x</button>
            </div>`;
        });

        if (!existing.length && !newPhones.length) {
            html = `<div style="font-size:0.75rem;color:var(--text-muted);">${I18n.t("no_phones")}</div>`;
        }

        phonesDiv.innerHTML = html;

        // Sync new phone input values back on change
        phonesDiv.querySelectorAll(".edit-person-new-phone").forEach(inp => {
            inp.addEventListener("input", () => {
                this._editPersonNewPhones[parseInt(inp.dataset.index)] = inp.value.trim();
            });
        });

        // Remove new phone
        phonesDiv.querySelectorAll(".edit-person-phone-remove").forEach(btn => {
            btn.addEventListener("click", () => {
                this._editPersonNewPhones.splice(parseInt(btn.dataset.index), 1);
                this._renderEditPersonPhones();
            });
        });
    },

    _getEditPersonAllPhones() {
        // Existing (full numbers, kept in memory) + new phones
        return [...(this._editPersonExistingPhones || []), ...(this._editPersonNewPhones || []).filter(Boolean)];
    },

    _bindEditPersonEvents() {
        const modal = document.getElementById("modal-edit-person");
        const overlay = document.getElementById("modal-edit-person-overlay");
        const cancelBtn = document.getElementById("btn-edit-person-cancel");
        const saveBtn = document.getElementById("btn-edit-person-save");
        const addPhoneBtn = document.getElementById("btn-add-phone");
        const partySelect = document.getElementById("edit-person-party");
        const partyCustom = document.getElementById("edit-person-party-custom");
        const errorDiv = document.getElementById("edit-person-error");

        const close = () => { modal.style.display = "none"; };

        // Clone to remove old listeners
        const newOverlay = overlay.cloneNode(true);
        overlay.parentNode.replaceChild(newOverlay, overlay);
        newOverlay.addEventListener("click", close);

        const newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
        newCancel.addEventListener("click", close);

        // Party "Others" toggle
        const savedPartyVal = partySelect.value;
        const newPartySelect = partySelect.cloneNode(true);
        partySelect.parentNode.replaceChild(newPartySelect, partySelect);
        newPartySelect.value = savedPartyVal;
        newPartySelect.addEventListener("change", () => {
            const custom = document.getElementById("edit-person-party-custom");
            if (newPartySelect.value === "Others") {
                custom.style.display = "block";
                custom.focus();
            } else {
                custom.style.display = "none";
                custom.value = "";
            }
        });

        // Add phone
        const newAddPhone = addPhoneBtn.cloneNode(true);
        addPhoneBtn.parentNode.replaceChild(newAddPhone, addPhoneBtn);
        newAddPhone.addEventListener("click", () => {
            const totalCount = (this._editPersonExistingPhones || []).length + (this._editPersonNewPhones || []).length;
            if (totalCount >= 4) {
                errorDiv.textContent = I18n.t("max_phones");
                errorDiv.style.display = "block";
                return;
            }
            errorDiv.style.display = "none";
            this._editPersonNewPhones.push("");
            this._renderEditPersonPhones();
            // Focus last input
            const inputs = document.querySelectorAll(".edit-person-new-phone");
            if (inputs.length) inputs[inputs.length - 1].focus();
        });

        // Save
        const newSave = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSave, saveBtn);
        newSave.addEventListener("click", async () => {
            errorDiv.style.display = "none";

            // Collect phones (existing full numbers + new inputs)
            const phones = this._getEditPersonAllPhones();
            if (phones.length > 4) {
                errorDiv.textContent = I18n.t("max_phones");
                errorDiv.style.display = "block";
                return;
            }
            for (const p of phones) {
                if (!/^\d{10}$/.test(p)) {
                    errorDiv.textContent = I18n.t("invalid_phone") + `: ${p}`;
                    errorDiv.style.display = "block";
                    return;
                }
            }

            // Collect party support
            const pSelect = document.getElementById("edit-person-party");
            const pCustom = document.getElementById("edit-person-party-custom");
            let partySupport = pSelect.value;
            if (partySupport === "Others") {
                partySupport = pCustom.value.trim();
                if (!partySupport) {
                    errorDiv.textContent = I18n.t("enter_party");
                    errorDiv.style.display = "block";
                    return;
                }
            }

            // Call API
            newSave.disabled = true;
            newSave.textContent = "...";
            const user = App.getUser();
            const ward = this._editPersonMode === "admin" ? this.adminMode.ward : user.ward;
            const booth = this._editPersonBooth;
            const voterId = this._editPersonVoterId;
            const mode = this._editPersonMode;

            const apiFn = mode === "booth" ? API.updatePerson : API.wardUpdatePerson;
            const res = await apiFn.call(API, ward, booth, voterId, phones, partySupport);

            newSave.disabled = false;
            newSave.textContent = I18n.t("save");

            if (res && !res.error) {
                // Update local state so party_support shows on re-render
                const state = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
                const allFams = [...(state.familiesAll || []), ...(state.ungroupedAll || [])];
                const newPhoneLast4 = phones.length > 0 ? phones[0].slice(-4) : "";
                for (const fam of allFams) {
                    for (const m of fam.members) {
                        if (m.voter_id === voterId) {
                            m.party_support = partySupport;
                            if (newPhoneLast4) m.phone_last4 = newPhoneLast4;
                            break;
                        }
                    }
                }
                App.showToast(I18n.t("person_updated"));
                modal.style.display = "none";
                // Re-render to update D badge — preserve scroll position
                const mc2 = document.getElementById("main-content");
                const savedScroll2 = mc2 ? mc2.scrollTop : 0;
                const applyFn = mode === "booth" ? () => this._applyBoothFilters()
                    : mode === "ward" ? () => this._applyWardFilters()
                    : () => this._applyAdminFilters();
                applyFn();
                if (mc2) mc2.scrollTop = savedScroll2;
            } else {
                errorDiv.textContent = (res && res.detail) || I18n.t("error");
                errorDiv.style.display = "block";
            }
        });
    },

    // ── Family builder modal ──────────────────────────────────────

    _openModal(initialMembers, editOpts, mode) {
        this._modalPending = (initialMembers || []).map(m => ({
            voter_id: m.voter_id,
            name:     I18n.currentLang === "ta" ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || ""),
            name_en:  m.name_en || m.name || "",
            name_ta:  m.name_ta || "",
            sl:       m.sl || "",
            booth:    m.booth || "",
            ward:     m.ward || "",
            section:  m.section || "",
            house:    m.house || "",
            is_head:  m.is_head || "No",
            age:      m.age || 0,
            gender:   m.gender || "",
            famcode:  m.famcode || "",
        }));
        this._modalEditFamcode = editOpts?.famcode || null;
        this._modalEditBooth   = editOpts?.booth   || null;
        this._modalMode        = mode;

        const modal = document.getElementById("modal-coupon-family-builder");
        modal.style.display = "flex";
        document.getElementById("coupon-builder-search-results").innerHTML = "";

        const title = modal.querySelector("h3");
        if (title) title.textContent = editOpts ? I18n.t("edit_family") : I18n.t("build_family");

        const clone = id => { const el = document.getElementById(id); if (!el) return null; const n = el.cloneNode(true); el.parentNode.replaceChild(n, el); return n; };
        const cancel  = clone("btn-coupon-builder-cancel");
        const overlay = clone("btn-coupon-builder-close-overlay");
        const submit  = clone("btn-coupon-builder-submit");
        const search  = clone("coupon-builder-search");
        const searchMode = clone("coupon-builder-search-mode");

        if (submit) submit.textContent = editOpts ? I18n.t("save_changes") : I18n.t("create_family");
        if (cancel)  cancel.addEventListener("click",  () => this._closeModal());
        if (overlay) overlay.addEventListener("click", () => this._closeModal());
        if (submit)  submit.addEventListener("click",  () => this._submitModal(mode));

        // Set initial dropdown value and placeholder
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

        if (search) {
            search.value = "";
            search.placeholder = I18n.t("search_voter_id_placeholder");
            let _bt;
            search.addEventListener("input", () => { clearTimeout(_bt); _bt = setTimeout(() => this._modalSearch(), 350); });
        }

        this._renderModalPending();
        setTimeout(() => document.getElementById("coupon-builder-search")?.focus(), 150);
    },

    _closeModal() {
        document.getElementById("modal-coupon-family-builder").style.display = "none";
        this._modalPending     = [];
        this._modalEditFamcode = null;
        this._modalEditBooth   = null;
    },

    _renderModalPending() {
        const list      = document.getElementById("coupon-builder-pending-list");
        const submitBtn = document.getElementById("btn-coupon-builder-submit");
        if (!list) return;

        const isDelete = this._modalEditFamcode && !this._modalPending.length;

        if (!this._modalPending.length) {
            list.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:4px 0;">${isDelete ? I18n.t("all_members_removed") : I18n.t("no_members_yet")}</div>`;
            if (submitBtn) {
                submitBtn.disabled = !isDelete;
                submitBtn.textContent = I18n.t("delete_family");
                submitBtn.className = submitBtn.className.replace("btn-primary", "btn-danger").replace("btn-danger btn-danger", "btn-danger");
            }
            return;
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = this._modalEditFamcode ? I18n.t("save_changes") : I18n.t("create_family");
            submitBtn.className = submitBtn.className.replace("btn-danger", "btn-primary").replace("btn-primary btn-primary", "btn-primary");
        }
        list.innerHTML = this._modalPending.map(v => {
            const isHead = v.is_head === "Yes";
            return `<div class="edit-member-row">
                <span class="ncc-sl">${this._esc(v.sl || "")}</span>
                <span class="ncc-name">${this._esc(v.name || v.voter_id)}</span>
                <button class="btn btn-sm scheme-modal-head-toggle ${isHead ? "scheme-modal-head-active" : ""}"
                    data-voter="${v.voter_id}" title="${I18n.t("head_of_family")}">👑</button>
                <button class="btn btn-danger btn-sm btn-scheme-modal-remove" data-voter="${v.voter_id}">✕</button>
            </div>`;
        }).join("");
        // Head of family toggle — only one allowed
        list.querySelectorAll(".scheme-modal-head-toggle").forEach(btn => {
            btn.addEventListener("click", () => {
                const vid = btn.dataset.voter;
                const current = this._modalPending.find(v => v.voter_id === vid);
                const wasHead = current && current.is_head === "Yes";
                this._modalPending.forEach(v => { v.is_head = "No"; });
                if (!wasHead && current) current.is_head = "Yes";
                this._renderModalPending();
            });
        });
        // Remove member
        list.querySelectorAll(".btn-scheme-modal-remove").forEach(btn => {
            btn.addEventListener("click", async () => {
                const ok = await Notice.confirmUndeliver("confirm_remove_member");
                if (!ok) return;
                this._modalPending = this._modalPending.filter(v => v.voter_id !== btn.dataset.voter);
                this._renderModalPending();
                this._modalSearch();
            });
        });
    },

    async _modalSearch() {
        const searchMode = document.getElementById("coupon-builder-search-mode")?.value || "voter_id";
        if (searchMode === "sl") {
            this._modalSearchBySl();
        } else {
            await this._modalSearchByVoterId();
        }
    },

    // Search by Voter ID — global API search (original behavior)
    async _modalSearchByVoterId() {
        const q = (document.getElementById("coupon-builder-search")?.value || "").trim();
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        if (!q || q.length < 10) {
            resultsEl.innerHTML = q.length > 0
                ? `<div class="empty-state"><p>Type ${10 - q.length} more character${10 - q.length !== 1 ? "s" : ""}…</p></div>`
                : "";
            return;
        }
        resultsEl.innerHTML = `<div style="padding:8px;color:var(--text-muted);font-size:0.8rem;">${I18n.t("searching")}</div>`;
        const pendingIds = new Set(this._modalPending.map(v => v.voter_id));
        const isTamil    = I18n.currentLang === "ta";
        const res        = await API.searchCouponVoters(q);
        if (res.error) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("search_failed")}</p></div>`; return; }
        const matches = (res.results || []).filter(m => !pendingIds.has(m.voter_id));
        if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("no_results")}</p></div>`; return; }
        const qLow = q.toLowerCase();
        this._renderModalSearchResults(matches, qLow);
    },

    // Search by SL / Name — local search, respects active booth/street filters
    _modalSearchBySl() {
        const q = (document.getElementById("coupon-builder-search")?.value || "").trim();
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        if (!q) { resultsEl.innerHTML = ""; return; }

        // Get loaded data from the current mode
        const mode  = this._modalMode;
        const state = mode === "booth" ? this.boothMode : mode === "ward" ? this.wardMode : this.adminMode;
        const allFams = [...(state.familiesAll || []), ...(state.ungroupedAll || [])];

        // Flatten all members from all families
        let allMembers = allFams.flatMap(f => (f.members || []).map(m => ({ ...m, booth: m.booth || f.booth || "", ward: m.ward || "" })));

        // Respect active filters (booth, street) from current state
        const activeBooth  = state.booth  || "";
        const activeStreet = state.street || "";
        if (activeBooth)  allMembers = allMembers.filter(m => m.booth === activeBooth);
        if (activeStreet) allMembers = allMembers.filter(m => m.section === activeStreet);

        // Filter by SL or name match
        const pendingIds = new Set(this._modalPending.map(v => v.voter_id));
        const qLow = q.toLowerCase();
        const isNumeric = /^\d+$/.test(q);
        const matches = allMembers
            .filter(m => {
                if (pendingIds.has(m.voter_id)) return false;
                if (isNumeric) {
                    // Exact whole SL match only (e.g. "24" matches SL "24", not "249" or "124")
                    return (m.sl || "") === q;
                }
                const name   = (m.name || "").toLowerCase();
                const nameEn = (m.name_en || "").toLowerCase();
                const nameTa = (m.name_ta || "").toLowerCase();
                return name.includes(qLow) || nameEn.includes(qLow) || nameTa.includes(qLow);
            })
            .slice(0, 15);

        if (!matches.length) { resultsEl.innerHTML = `<div class="empty-state"><p>${I18n.t("no_results")}</p></div>`; return; }
        this._renderModalSearchResults(matches, qLow);
    },

    // Shared renderer for modal search results
    _renderModalSearchResults(matches, qLow) {
        const resultsEl = document.getElementById("coupon-builder-search-results");
        if (!resultsEl) return;
        const isTamil = I18n.currentLang === "ta";
        resultsEl.innerHTML = matches.map(m => {
            const name = isTamil ? (m.name_ta || m.name_en || m.name || "") : (m.name_en || m.name || "");
            const wb   = [m.ward, m.booth].filter(Boolean).join(" · ");
            return `<div class="other-search-row">
                <div class="ncc-member-left">
                    <span class="ncc-name">${this._hl(name, qLow)}</span>
                    <span class="ncc-sl">${I18n.t("sl_no")} ${this._hl(m.sl || "-", qLow)} · ${I18n.t("id_label")} <span class="ncc-epic">${this._hl(m.voter_id || "", qLow)}</span>${wb ? ` · ${wb}` : ""}</span>
                </div>
                <button class="btn btn-primary btn-sm btn-scheme-modal-add"
                    data-voter='${JSON.stringify({ voter_id: m.voter_id, name, name_en: m.name_en || m.name || "", name_ta: m.name_ta || "", sl: m.sl || "", booth: m.booth || "", ward: m.ward || "", section: m.section || "", house: m.house || "", age: m.age || 0, gender: m.gender || "" })}'>${I18n.t("add_member")}</button>
            </div>`;
        }).join("");
        resultsEl.querySelectorAll(".btn-scheme-modal-add").forEach(btn => {
            btn.addEventListener("click", () => {
                try {
                    const v = JSON.parse(btn.dataset.voter);
                    if (!this._modalPending.find(p => p.voter_id === v.voter_id)) {
                        this._modalPending.push(v);
                        this._renderModalPending();
                        this._modalSearch();
                    }
                } catch {}
            });
        });
    },

    async _submitModal(mode) {
        const isDelete = this._modalEditFamcode && !this._modalPending.length;

        // Block create-with-no-members; allow delete-via-edit
        if (!this._modalEditFamcode && !this._modalPending.length) return;

        // Confirm deletion
        if (isDelete) {
            const ok = await Notice.confirmUndeliver("confirm_delete_family");
            if (!ok) return;
        }

        const user      = App.getUser();
        const submitBtn = document.getElementById("btn-coupon-builder-submit");
        if (submitBtn) App.setBtnLoading(submitBtn, true);

        // Use the correct ward for each mode
        const ward = mode === "admin" ? this.adminMode.ward : user.ward;

        const booth = this._modalEditBooth
            || (mode === "ward"
                ? (this._modalPending[0]?.booth || this.wardMode.booth || "")
                : mode === "admin"
                ? (this._modalPending[0]?.booth || this.adminMode.booth || "")
                : user.booth);

        if (!booth && !isDelete) {
            if (submitBtn) App.setBtnLoading(submitBtn, false);
            App.showToast(I18n.t("booth_required"));
            return;
        }

        const voterIds    = this._modalPending.map(v => v.voter_id);
        const membersData = this._modalPending.map(v => ({
            voter_id: v.voter_id,    name: v.name || "",
            name_en:  v.name_en || v.name || "",  name_ta: v.name_ta || "",
            sl:       v.sl || "",    booth: v.booth || booth,
            ward:     v.ward || ward,              section: v.section || "",
            house:    v.house || "", famcode: v.famcode || "",
            is_head:  v.is_head || "No",           age: v.age || 0,
            gender:   v.gender || "",
        }));

        const res = this._modalEditFamcode
            ? await API.updateCouponFamily(ward, booth || user.booth, this._modalEditFamcode, voterIds, membersData)
            : await API.createCouponFamily(ward, booth, voterIds, membersData);

        if (submitBtn) App.setBtnLoading(submitBtn, false);
        if (res.error) { App.showToast(res.detail || I18n.t("error")); return; }

        App.showToast(isDelete ? I18n.t("family_deleted") : this._modalEditFamcode ? I18n.t("family_updated") : I18n.t("family_created"));
        this._closeModal();

        // Preserve scroll position across data reload
        const mc = document.getElementById("main-content");
        const savedScroll = mc ? mc.scrollTop : 0;

        if (mode === "booth")      await this._loadBoothData();
        else if (mode === "ward")  await this._loadWardData();
        else                       await this._loadAdminData();

        if (mc) mc.scrollTop = savedScroll;
    },

    // ── Language refresh (no API call — re-renders from cached data) ──

    refreshLanguage() {
        const v = App.currentView;
        if (v === "view-booth-scheme") {
            if (this.boothMode.scheme) {
                if (this.boothMode.tab === "family") this._renderBoothFamilies();
                else this._renderBoothOther();
            }
        } else if (v === "view-ward-scheme") {
            if (this.wardMode.scheme) {
                if (this.wardMode.tab === "family") this._renderWardFamilies();
                else this._renderWardOther();
            }
        } else if (v === "view-admin-scheme") {
            if (this.adminMode.scheme) {
                if (this.adminMode.tab === "family") this._renderAdminFamilies();
                else this._renderAdminOther();
            }
        }
    },

    _esc(str) {
        const d = document.createElement("div");
        d.textContent = str || "";
        return d.innerHTML;
    },

    _hl(text, q) {
        if (!q || !text) return this._esc(text);
        const escaped  = this._esc(text);
        const escapedQ = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!escapedQ) return escaped;
        return escaped.replace(new RegExp(`(${escapedQ})`, "gi"), `<mark class="search-hl">$1</mark>`);
    },
};

// ── Delivery Queue — offline-first for all scheme deliveries ─────────────────
//
// Flow: user taps deliver → optimistic update → queued → API tried immediately
//       Network error  → stays in queue, retried every 30s for up to 6 hours
//       Server error   → reverted immediately, logged to Errors tab
//       6hr expiry     → reverted, logged to Errors tab
//
const DeliveryQueue = {
    KEY: "vc_delivery_queue",
    MAX_AGE: 6 * 60 * 60 * 1000, // 6 hours in ms

    load() {
        try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); }
        catch { return []; }
    },

    save(q) { localStorage.setItem(this.KEY, JSON.stringify(q)); },

    add(item) {
        const q = this.load();
        q.push(item);
        this.save(q);
        this._updateBanner();
    },

    remove(id) {
        this.save(this.load().filter(q => q.id !== id));
        this._updateBanner();
    },

    async drain() {
        if (!App.getUser()) return;
        const queue = this.load();
        if (!queue.length) { this._updateBanner(); return; }

        const now = Date.now();
        const remaining = [];
        const toRevert = [];
        const toLog = [];

        for (const item of queue) {
            // Expired after 6 hours — give up
            if (now - item.timestamp > this.MAX_AGE) {
                toRevert.push(item);
                toLog.push({ ...item, failReason: "Sync timed out after 6 hours" });
                continue;
            }

            const def = Scheme._def(item.schemeId);
            const isWard = item.mode !== "booth";
            const res = await (item.action === "deliver"
                ? def.deliver(item.ward, item.booth, item.voterIds, isWard)
                : def.undeliver(item.ward, item.booth, item.voterIds, isWard));

            if (!res || !res.error) {
                // Success — clear pending flag in any currently loaded state
                const idSet = new Set(item.voterIds);
                [Scheme.boothMode, Scheme.wardMode, Scheme.adminMode].forEach(state => {
                    if (!state.scheme || state.scheme.id !== item.schemeId) return;
                    [...state.familiesAll, ...state.ungroupedAll].forEach(fam =>
                        fam.members.forEach(m => { if (idSet.has(m.voter_id)) m._pending = false; })
                    );
                });
                continue;
            }

            if (res.detail === "Network error") {
                remaining.push(item); // still offline — keep for next retry
            } else {
                toRevert.push(item);  // server/auth error — no point retrying
                toLog.push({ ...item, failReason: res.detail });
            }
        }

        this.save(remaining);

        // Revert all failed items and re-render
        for (const item of toRevert) {
            Scheme._revertOptimistic(item);
            App.showToast("Delivery sync failed — changes reverted. Check Errors tab.");
        }

        // Log permanent failures to server (admin Errors tab)
        if (toLog.length) {
            API.post("/api/notice/sync-failures", {
                failures: toLog.map(i => ({
                    ward: i.ward, booth: i.booth, voter_ids: i.voterIds,
                    action: i.action, by_phone: i.myPhone, by_name: i.myName,
                    attempted_at: i.myTime, failed_at: new Date().toISOString(),
                    fail_reason: i.failReason, scheme_id: i.schemeId,
                })),
            });
        }

        this._updateBanner();
    },

    _updateBanner() {
        const count = this.load().length;
        const banner = document.getElementById("notice-sync-banner");
        if (!banner) return;
        if (count > 0) {
            banner.textContent = `⟳ ${count} delivery update${count !== 1 ? "s" : ""} pending sync`;
            banner.style.display = "block";
        } else {
            banner.style.display = "none";
        }
    },

    init() {
        window.addEventListener("online", () => this.drain());
        setInterval(() => this.drain(), 30000); // retry every 30 seconds
        this._updateBanner(); // restore banner if queue has items from previous session
    },

    startDrain() { this.drain(); }, // called after login is confirmed
};
