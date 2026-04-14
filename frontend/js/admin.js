const Admin = {
    chartGeo:   null,
    chartTrend: null,
    chartAge:   null,

    // Drill-down state
    _drillWard:  "",   // currently drilled-into ward (empty = all wards)
    _drillBooth: "",   // currently drilled-into booth (empty = ward level)
    _drillItems: [],   // current geo chart data array
    _geoScheme:  "calling",  // "calling" | "notice" | "coupon"
    _summaryData: null,      // cached summary response
    _scopeLocked: false,     // true for ward/booth — can't navigate outside their scope

    // Filter cancellation counter — discard stale responses when filter changes rapidly
    _filterGen: 0,

    // ── Schedule helpers ───────────────────────────────────────────────────────
    _renderScheduleTimes(schedule) {
        const always = schedule?.always !== false;
        document.getElementById("user-schedule-always").checked = always;
        const timesDiv = document.getElementById("user-schedule-times");
        if (!timesDiv) return;
        timesDiv.style.display = always ? "none" : "flex";
        if (!always) {
            document.getElementById("user-schedule-start").value = schedule?.start || "09:00";
            document.getElementById("user-schedule-end").value   = schedule?.end   || "18:00";
        }
    },

    _readScheduleTimes() {
        return {
            always: false,
            start: document.getElementById("user-schedule-start")?.value || "09:00",
            end:   document.getElementById("user-schedule-end")?.value   || "18:00",
        };
    },

    _fmtLocationAge(isoTs) {
        if (!isoTs) return "";
        const diff = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
        if (diff < 60) return "just now";
        if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
        return `${Math.floor(diff/86400)}d ago`;
    },

    formatBoothLabel(boothName, boothNumber, maxLen, boothNameTamil) {
        const isTamil = I18n.currentLang === "ta";
        const name = (isTamil && boothNameTamil) ? boothNameTamil : (boothName || "");
        if (!boothNumber && !name) return "";
        if (!boothNumber) return name;
        if (!name) return boothNumber;
        const shortName = maxLen && name.length > maxLen ? name.substring(0, maxLen) + "..." : name;
        return `${boothNumber} - ${shortName}`;
    },

    async init() {
        document.getElementById("btn-add-user").addEventListener("click", () => this.openAddUser());
        document.getElementById("btn-cancel-user").addEventListener("click", () => this.closeAddUser());
        document.getElementById("btn-save-user").addEventListener("click", () => this.saveUser());
        document.getElementById("new-user-role").addEventListener("change", () => this.onRoleChange());
        document.getElementById("new-user-ward").addEventListener("change", () => this.onWardChange());
        document.querySelector("#modal-add-user .modal-overlay").addEventListener("click", () => this.closeAddUser());

        // Security settings collapse toggle (always collapsed when modal opens — wired once here)
        document.getElementById("btn-toggle-security").addEventListener("click", () => {
            const body = document.getElementById("user-security-body");
            const chevron = document.querySelector("#btn-toggle-security .collapse-chevron");
            const open = body.style.display !== "none";
            body.style.display = open ? "none" : "block";
            if (chevron) chevron.style.transform = open ? "" : "rotate(90deg)";
        });

        // User role filters
        document.querySelectorAll(".btn-role-filter").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".btn-role-filter").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                this._roleFilter = btn.dataset.role;
                this._applyUserFilters();
            });
        });

        // Activity filters
        document.querySelectorAll(".btn-activity-filter").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".btn-activity-filter").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                this._activityFilter = btn.dataset.activity;
                this._applyUserFilters();
            });
        });

        // Bulk action bar
        document.getElementById("chk-select-all")?.addEventListener("change", (e) => this._onSelectAllChange(e.target.checked));
        document.getElementById("btn-bulk-remove")?.addEventListener("click", () => this._bulkRemove());

        // Geo scheme tabs
        document.querySelectorAll("[data-geo-scheme]").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll("[data-geo-scheme]").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                this._geoScheme = btn.dataset.geoScheme;
                this._renderGeoChart(this._drillItems);
            });
        });

        // Top filter bar
        document.getElementById("admin-filter-ward")?.addEventListener("change", () => this._onFilterWardChange());
        document.getElementById("admin-filter-booth")?.addEventListener("change", () => this._onFilterBoothChange());
        document.getElementById("btn-dash-clear")?.addEventListener("click", () => this._clearFilters());

        // Users / Stats page tabs
        document.querySelectorAll(".user-page-tab").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".user-page-tab").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                const tab = btn.dataset.uptab;
                document.getElementById("admin-users-panel").style.display = tab === "users" ? "block" : "none";
                document.getElementById("admin-stats-panel").style.display = tab === "stats"  ? "block" : "none";
                if (tab === "stats") this._renderStatsPanel();
            });
        });
    },

    // ── Section-level loading helpers ─────────────────────────────────────────
    _setSectionLoading(sectionId, on) {
        const el = document.getElementById(sectionId);
        if (!el) return;
        const existing = el.querySelector(".section-loader");
        if (on && !existing) {
            const loader = document.createElement("div");
            loader.className = "section-loader";
            loader.innerHTML = '<div class="section-loader-spinner"></div>';
            el.appendChild(loader);
        } else if (!on && existing) {
            existing.remove();
        }
    },

    async loadDashboard(scope = {}) {
        const scopeWard  = scope.ward  || "";
        const scopeBooth = scope.booth || "";
        this._scopeLocked = !!(scopeWard);   // ward/booth users can't navigate outside scope

        // Hide/show filter bar — locked scopes don't need it
        const filterBar = document.getElementById("admin-dash-filter");
        if (filterBar) filterBar.style.display = this._scopeLocked ? "none" : "";

        // Phase 1: Universe stats (instant from Settings cache)
        this._setSectionLoading("admin-schemes-section", true);
        this._setGeoLoading(true);

        if (scopeWard) {
            // ── Ward/Booth user: SINGLE call, NO global data exposure ──────────
            // Do NOT call /universe — that returns global stats across all wards.
            // Only use the scoped universe_scope returned by the filtered summary.
            const [data, drillRes] = await Promise.all([
                API.getAdminSummary(),   // server enforces scope from JWT, no params needed
                scopeBooth
                    ? API.getAdminDrill(scopeWard, scopeBooth)
                    : API.getAdminDrill(scopeWard),
            ]);

            this._setSectionLoading("admin-schemes-section", false);
            this._setGeoLoading(false);
            if (data.error) return;

            this._summaryData = data;
            this._drillWard   = scopeWard;
            this._drillBooth  = scopeBooth;
            this._drillItems  = drillRes?.items || [];

            // Build scoped universe — enrich with street/booth counts from drill data
            const scopeU = data.universe_scope || {
                total_voters:    data.schemes?.calling?.total || 0,
                surveyed_voters: data.schemes?.calling?.total || 0,
            };
            // Fallback: derive street count from drill items if backend didn't include it
            if (scopeU.total_streets == null && drillRes?.items?.length) {
                scopeU.total_streets = drillRes.items.length;
            }
            this.renderUniverse(scopeU);
            this.renderSchemes(data.schemes || {});
            this._updateGeoSchemeTabs(drillRes?.custom_schemes || data.schemes?.custom || []);
            this._renderGeoChart(drillRes?.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();

            // Streets dropdown: use drill items if available, else try a dedicated fetch
            const streetItems = drillRes?.items || [];
            if (!drillRes?.error && streetItems.length === 0 && scopeBooth) {
                // Drill returned empty — retry once to get streets
                const retry = await API.getAdminDrill(scopeWard, scopeBooth);
                this._buildScopeFilterBar(scope, retry?.items || []);
            } else {
                this._buildScopeFilterBar(scope, streetItems);
            }

        } else {
            // ── Superadmin: global two-phase load ─────────────────────────────
            const uRes = await API.getAdminUniverse();
            if (!uRes.error) {
                this.renderUniverse(uRes.universe || {});
                const wardSel = document.getElementById("admin-filter-ward");
                if (wardSel && wardSel.options.length <= 1 && uRes.all_wards) {
                    uRes.all_wards.forEach((w) => {
                        const opt = document.createElement("option");
                        opt.value = w; opt.textContent = w;
                        wardSel.appendChild(opt);
                    });
                }
            }

            const data = await API.getAdminSummary();
            this._setSectionLoading("admin-schemes-section", false);
            this._setGeoLoading(false);
            if (data.error) {
                this._renderSchemesError();
                this._renderGeoError();
                return;
            }

            this._summaryData = data;
            this._drillWard   = "";
            this._drillBooth  = "";
            this._drillItems  = data.wards || [];

            this.renderSchemes(data.schemes || {});
            this._updateGeoSchemeTabs(data.schemes?.custom || []);
            this._renderGeoChart(data.wards || []);
            this._updateBreadcrumb();
        }
        // Trend + workers in Stats tab — rendered lazily when opened
    },

    // Show error card in scheme section with a retry button
    _renderSchemesError() {
        const el = document.getElementById("admin-scheme-cards");
        if (!el) return;
        el.innerHTML = `
            <div class="dash-error-state" style="grid-column:1/-1;">
                <span class="dash-error-icon">⚠️</span>
                <p class="dash-error-msg">Could not load scheme data.</p>
                <button class="btn btn-secondary btn-sm dash-retry-btn">Retry</button>
            </div>`;
        el.querySelector(".dash-retry-btn").addEventListener("click", () => this.loadDashboard());
    },

    // Show error overlay on geo chart with a retry button
    _renderGeoError() {
        const wrap = document.querySelector(".geo-chart-wrap");
        if (!wrap) return;
        const existing = wrap.querySelector(".geo-empty");
        if (existing) existing.remove();
        const msg = document.createElement("div");
        msg.className = "geo-empty";
        msg.innerHTML = `<span>⚠️</span><p>Could not load data</p><button class="btn btn-secondary btn-sm dash-retry-btn" style="margin-top:8px;">Retry</button>`;
        wrap.appendChild(msg);
        msg.querySelector(".dash-retry-btn").addEventListener("click", () => {
            msg.remove();
            this.loadDashboard();
        });
    },

    // ── Stats tab (in Users page) ─────────────────────────────────────────────
    async _renderStatsPanel() {
        const loading = document.getElementById("stats-panel-loading");
        const content = document.getElementById("stats-panel-content");

        loading.style.display = "block";
        content.style.display = "none";

        // Fetch summary (may be cached) and activity stats in parallel
        const [summaryData, activityRes] = await Promise.all([
            this._summaryData ? Promise.resolve(this._summaryData) : API.getAdminSummary(),
            API.getUserActivityStats(),
        ]);

        if (summaryData.error) { loading.style.display = "none"; return; }
        this._summaryData = summaryData;

        const userCount  = summaryData.user_count || {};
        const totalUsers = (userCount.booth || 0) + (userCount.ward || 0)
                         + (userCount.telecaller || 0) + (userCount.superadmin || 0);

        // Activity cards
        const activityEl = document.getElementById("stats-calling-cards");
        if (activityEl) {
            const activeNow = activityRes.error ? "—" : (activityRes.active_now      ?? "—");
            const loggedIn  = activityRes.error ? "—" : (activityRes.logged_in_today ?? "—");
            activityEl.innerHTML = `
                <div class="stat-card success">
                    <div class="stat-value">${activeNow}</div>
                    <div class="stat-label">Active Now</div>
                    <div class="stat-sub">last 30 min</div>
                </div>
                <div class="stat-card accent">
                    <div class="stat-value">${loggedIn}</div>
                    <div class="stat-label">Logged In Today</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${totalUsers}</div>
                    <div class="stat-label">Total Users</div>
                </div>`;
        }

        // Team breakdown cards
        const teamEl = document.getElementById("stats-team-cards");
        if (teamEl) {
            teamEl.innerHTML = `
                <div class="stat-card accent">
                    <div class="stat-value">${userCount.booth || 0}</div>
                    <div class="stat-label">Booth Workers</div>
                </div>
                <div class="stat-card purple">
                    <div class="stat-value">${userCount.telecaller || 0}</div>
                    <div class="stat-label">Telecallers</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${userCount.ward || 0}</div>
                    <div class="stat-label">Ward Supervisors</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${userCount.superadmin || 0}</div>
                    <div class="stat-label">Admins</div>
                </div>`;
        }

        loading.style.display = "none";
        content.style.display = "block";
    },

    // Reload scheme cards + flowchart for the current filter scope.
    // _filterGen counter ensures rapid filter changes discard stale responses.
    async _loadFilteredStats(ward, booth) {
        const myGen = ++this._filterGen;

        const data = await API.getAdminSummary(ward, booth);

        if (myGen !== this._filterGen) return; // a newer filter change started — discard
        if (data.error) return;

        // Update flowchart in-place
        if (ward || booth) {
            const scopeU = data.universe_scope;
            this.renderUniverse(scopeU || {
                total_voters:    data.schemes?.calling?.total || 0,
                surveyed_voters: data.schemes?.calling?.total || 0,
                total_families:  null,
            });
        }

        this.renderSchemes(data.schemes || {});
    },

    // ── Compute scheme cards from drill items (street-level data) ───────────
    _schemesFromDrillItems(items) {
        const customSchemes = this._summaryData?.schemes?.custom || [];
        const noticeEnabled = this._summaryData?.schemes?.notice?.enabled;
        const couponEnabled = this._summaryData?.schemes?.coupon?.enabled;

        let ct = 0, cc = 0, cda = 0, csk = 0;
        let nt = 0, nd = 0;
        let pt = 0, pd = 0;
        const csTotals = {};
        customSchemes.forEach(sc => { csTotals[sc.id] = { total: 0, done: 0, name: sc.name }; });

        for (const it of items) {
            ct  += it.total        || 0;
            cc  += it.called       || 0;
            cda += it.didnt_answer || 0;
            csk += it.skipped      || 0;
            nt  += it.notice_total     || 0;
            nd  += it.notice_delivered || 0;
            pt  += it.coupon_total     || 0;
            pd  += it.coupon_delivered || 0;
            for (const sc of customSchemes) {
                csTotals[sc.id].total += it[`scheme_${sc.id}_total`]     || 0;
                csTotals[sc.id].done  += it[`scheme_${sc.id}_delivered`] || 0;
            }
        }

        return {
            calling: {
                total: ct, done: cc, didnt_answer: cda, skipped: csk,
                not_called: Math.max(0, ct - cc - cda - csk),
                pct: ct > 0 ? Math.round(cc / ct * 1000) / 10 : 0,
            },
            notice: {
                total: nt, done: nd, pending: nt - nd,
                pct: nt > 0 ? Math.round(nd / nt * 1000) / 10 : 0,
                enabled: noticeEnabled,
            },
            coupon: {
                total: pt, done: pd, pending: pt - pd,
                pct: pt > 0 ? Math.round(pd / pt * 1000) / 10 : 0,
                enabled: couponEnabled,
            },
            custom: customSchemes.map(sc => ({
                id: sc.id, name: csTotals[sc.id].name,
                total: csTotals[sc.id].total,
                done: csTotals[sc.id].done,
                pending: csTotals[sc.id].total - csTotals[sc.id].done,
                pct: csTotals[sc.id].total > 0
                    ? Math.round(csTotals[sc.id].done / csTotals[sc.id].total * 1000) / 10 : 0,
            })),
        };
    },

    // ── Compute universe stats from drill items (street-level data) ─────────
    _universeFromDrillItems(items) {
        let totalVoters = 0, surveyed = 0, families = 0;
        let gm = 0, gf = 0, go = 0;
        let a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0;

        for (const it of items) {
            totalVoters += it.all_voters || 0;
            surveyed    += it.surveyed   || 0;
            families    += it.families   || 0;
            gm += it.gender_m  || 0;
            gf += it.gender_f  || 0;
            go += it.gender_o  || 0;
            a1 += it.age_18_25  || 0;
            a2 += it.age_26_35  || 0;
            a3 += it.age_36_45  || 0;
            a4 += it.age_46_60  || 0;
            a5 += it.age_61_plus || 0;
        }

        return {
            total_voters:    totalVoters,
            surveyed_voters: surveyed,
            total_families:  families > 0 ? families : null,
            total_streets:   items.length,
            gender: { M: gm, F: gf, O: go },
            age_distribution: [
                { bucket: "18-25", count: a1 },
                { bucket: "26-35", count: a2 },
                { bucket: "36-45", count: a3 },
                { bucket: "46-60", count: a4 },
                { bucket: "61+",   count: a5 },
            ],
        };
    },

    // ── Scope filter bar (ward/booth users) ──────────────────────────────────
    _escAttr(s) { return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;"); },

    _buildScopeFilterBar(scope, items) {
        const bar = document.getElementById("admin-dash-filter");
        if (!bar) return;

        if (scope.booth) {
            // Booth user: street filter only
            bar.innerHTML = `
                <select id="scope-street-sel" class="select-field select-sm">
                    <option value="">All Streets</option>
                    ${(items || []).map(s => {
                        const secLabel = (I18n.currentLang === "ta" && s.section_ta) ? s.section_ta : s.section;
                        return `<option value="${this._escAttr(s.section)}">${Booth.escHtml(secLabel)}</option>`;
                    }).join("")}
                </select>`;
            bar.style.display = "";
            document.getElementById("scope-street-sel").addEventListener("change", (e) => {
                const street = e.target.value;
                const filtered = street ? items.filter(s => s.section === street) : items;
                this._drillItems = filtered;
                this._renderGeoChart(filtered);
                // Update scheme cards + universe from drill data
                this.renderSchemes(this._schemesFromDrillItems(filtered));
                this.renderUniverse(this._universeFromDrillItems(filtered));
            });

        } else if (scope.ward) {
            // Ward supervisor: booth dropdown + street dropdown (appears after booth selected)
            bar.innerHTML = `
                <select id="scope-booth-sel" class="select-field select-sm">
                    <option value="">All Booths</option>
                    ${(items || []).map(b => {
                        const label = b.booth_number ? `#${b.booth_number} ${Booth.escHtml(b.booth_name || '')}`.trim() : Booth.escHtml(b.booth_name || b.booth);
                        return `<option value="${this._escAttr(b.booth)}">${label}</option>`;
                    }).join("")}
                </select>
                <select id="scope-street-sel" class="select-field select-sm" style="display:none">
                    <option value="">All Streets</option>
                </select>`;
            bar.style.display = "";
            this._scopeBoothItems = items; // cache for reset
            document.getElementById("scope-booth-sel").addEventListener("change", () =>
                this._onScopeBoothChange(scope.ward));
        }
    },

    async _onScopeBoothChange(ward) {
        const booth    = document.getElementById("scope-booth-sel")?.value || "";
        const streetSel = document.getElementById("scope-street-sel");

        if (!booth) {
            // Reset: back to all-booths view for this ward
            if (streetSel) { streetSel.style.display = "none"; streetSel.innerHTML = '<option value="">All Streets</option>'; }
            this._drillBooth  = "";
            this._drillItems  = this._scopeBoothItems || [];
            this._renderGeoChart(this._drillItems);
            this._updateGeoTitle();
            this._updateBreadcrumb();
            await this._loadFilteredStats(ward, "");
            return;
        }

        // Drill to street level for selected booth
        App.showViewLoading("view-admin-home");
        const [drillRes] = await Promise.all([
            API.getAdminDrill(ward, booth),
            this._loadFilteredStats(ward, booth),
        ]);
        App.hideViewLoading("view-admin-home");

        if (!drillRes?.error) {
            this._drillBooth  = booth;
            this._drillItems  = drillRes.items || [];
            this._renderGeoChart(drillRes.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();

            // Populate street dropdown
            if (streetSel) {
                streetSel.innerHTML = `<option value="">All Streets</option>` +
                    (drillRes.items || []).map(s => {
                        const secLabel = (I18n.currentLang === "ta" && s.section_ta) ? s.section_ta : s.section;
                        return `<option value="${this._escAttr(s.section)}">${Booth.escHtml(secLabel)}</option>`;
                    }).join("");
                streetSel.style.display = "inline-block";
                streetSel.value = "";
                streetSel.onchange = (e) => {
                    const st = e.target.value;
                    const filtered = st ? this._drillItems.filter(s => s.section === st) : this._drillItems;
                    this._renderGeoChart(filtered);
                    // Update scheme cards + universe from drill data
                    this.renderSchemes(this._schemesFromDrillItems(filtered));
                    this.renderUniverse(this._universeFromDrillItems(filtered));
                };
            }
        }
    },

    // ── Top filter bar (superadmin only) ─────────────────────────────────────
    async _onFilterWardChange() {
        const ward = document.getElementById("admin-filter-ward").value;
        const boothSel = document.getElementById("admin-filter-booth");
        const clearBtn = document.getElementById("btn-dash-clear");

        // Reset booth dropdown
        boothSel.innerHTML = '<option value="">All Booths</option>';
        boothSel.style.display = "none";
        if (clearBtn) clearBtn.style.display = ward ? "inline-flex" : "none";

        if (!ward) {
            ++this._filterGen;  // discard any in-flight filtered requests
            App.hideViewLoading("view-admin-home");
            this._drillWard  = "";
            this._drillBooth = "";
            if (this._summaryData?.wards?.length > 0) {
                // Global data already in memory — restore instantly
                this._renderGeoChart(this._summaryData.wards);
                this.renderSchemes(this._summaryData.schemes || {});
                this.renderUniverse(this._summaryData.universe || {});
                this._updateGeoTitle();
                this._updateBreadcrumb();
            } else {
                // Global data not loaded yet — fetch it now
                await this.loadDashboard();
            }
            return;
        }

        // Load booths for this ward
        const res = await API.getWardBoothsList(ward);
        (res.booths || []).forEach((b) => {
            const booth  = typeof b === "object" ? b.booth : b;
            const bn     = typeof b === "object" ? (b.booth_number || "") : "";
            const bname  = typeof b === "object" ? (b.booth_name || "") : "";
            const opt    = document.createElement("option");
            opt.value    = booth;
            opt.textContent = bn ? `#${bn} ${bname}`.trim() : (bname || booth);
            boothSel.appendChild(opt);
        });
        boothSel.style.display = "inline-block";

        // Full-page loading while data fetches
        App.showViewLoading("view-admin-home");
        const [drillRes] = await Promise.all([
            API.getAdminDrill(ward),
            this._loadFilteredStats(ward, ""),
        ]);
        App.hideViewLoading("view-admin-home");
        if (!drillRes.error) {
            this._drillWard  = ward;
            this._drillBooth = "";
            this._updateGeoSchemeTabs(drillRes.custom_schemes || []);
            this._renderGeoChart(drillRes.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();
        }
    },

    async _onFilterBoothChange() {
        const ward  = document.getElementById("admin-filter-ward").value;
        const booth = document.getElementById("admin-filter-booth").value;
        if (!ward) return;

        if (!booth) {
            App.showViewLoading("view-admin-home");
            const [res] = await Promise.all([
                API.getAdminDrill(ward),
                this._loadFilteredStats(ward, ""),
            ]);
            App.hideViewLoading("view-admin-home");
            if (!res.error) {
                this._drillBooth = "";
                this._updateGeoSchemeTabs(res.custom_schemes || []);
                this._renderGeoChart(res.items || []);
                this._updateGeoTitle();
                this._updateBreadcrumb();
            }
            return;
        }

        // Drill to street level
        App.showViewLoading("view-admin-home");
        const [res] = await Promise.all([
            API.getAdminDrill(ward, booth),
            this._loadFilteredStats(ward, booth),
        ]);
        App.hideViewLoading("view-admin-home");
        if (!res.error) {
            this._drillWard  = ward;
            this._drillBooth = booth;
            this._updateGeoSchemeTabs(res.custom_schemes || []);
            this._renderGeoChart(res.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();
        }
    },

    _clearFilters() {
        ++this._filterGen;  // discard any in-flight filtered requests
        const wardSel  = document.getElementById("admin-filter-ward");
        const boothSel = document.getElementById("admin-filter-booth");
        const clearBtn = document.getElementById("btn-dash-clear");
        if (wardSel)  wardSel.value = "";
        if (boothSel) { boothSel.innerHTML = '<option value="">All Booths</option>'; boothSel.style.display = "none"; }
        if (clearBtn) clearBtn.style.display = "none";
        this._drillWard  = "";
        this._drillBooth = "";
        if (this._summaryData?.wards?.length > 0) {
            this.renderSchemes(this._summaryData.schemes || {});
            this.renderUniverse(this._summaryData.universe || {});
            this._renderGeoChart(this._summaryData.wards);
            this._updateGeoTitle();
            this._updateBreadcrumb();
        } else {
            this.loadDashboard();
        }
    },

    // ── Chart-only loading overlay ────────────────────────────────────────────
    _setGeoLoading(on) {
        const wrap = document.querySelector(".geo-chart-wrap");
        if (!wrap) return;
        const existing = wrap.querySelector(".geo-chart-loader");
        if (on && !existing) {
            const loader = document.createElement("div");
            loader.className = "geo-chart-loader";
            loader.innerHTML = '<div class="geo-loader-spinner"></div>';
            wrap.appendChild(loader);
        } else if (!on && existing) {
            existing.remove();
        }
    },

    // ── Universe section — voter flow chart ──────────────────────────────────
    renderUniverse(u) {
        const cards = document.getElementById("admin-universe-cards");
        if (!cards) return;

        const fmt = (n) => {
            if (n == null) return "—";
            return Number(n).toLocaleString("en-IN");
        };
        const pc = (a, b) => b > 0 ? Math.round(a * 100 / b) + "%" : "—";

        const total    = u.total_voters    || 0;
        const surveyed = u.surveyed_voters || 0;
        const notSurv  = total - surveyed;
        const families = u.total_families  || 0;

        // Use precise stored values (available after rebuild); fall back to derivation
        const survInFam    = u.surveyed_in_family  ?? Math.max(0, surveyed - Math.max(0, (u.ungrouped_voters||0) - notSurv));
        const survUngr     = u.surveyed_ungrouped  ?? (surveyed - survInFam);
        const notSurvInFam = u.not_surv_in_family  ?? 0;
        const notSurvUngr  = u.not_surv_ungrouped  ?? (notSurv - notSurvInFam);

        // When filter is active, family data isn't available — show simplified tree
        const hasFamilyData = u.total_families != null;

        // Family counts per branch — fall back to total_families for surveyed branch
        const survFamCount    = u.surveyed_families   ?? u.total_families ?? null;
        const notSurvFamCount = u.not_surv_families   ?? null;

        const mkLeafPair = (inFam, ungr, parent, famCount) => `
          <div class="vf-quad-group">
            <div class="vf-branch">
              <div class="vf-stem"></div>
              <div class="vf-node node-green">
                <div class="vf-node-pct">${pc(inFam, parent)}</div>
                ${famCount != null ? `
                <div class="vf-node-val">${fmt(famCount)}</div>
                <div class="vf-node-lbl-sm">${I18n.t("families")}</div>
                <div class="vf-node-divider"></div>
                <div class="vf-node-val vf-node-val-fam">${fmt(inFam)}</div>
                <div class="vf-node-lbl-sm">${I18n.t("total_voters")}</div>` : `
                <div class="vf-node-val">${fmt(inFam)}</div>
                <div class="vf-node-lbl-sm">${I18n.t("total_voters")}</div>`}
                <div class="vf-node-lbl">${I18n.t("in_a_family")}</div>
              </div>
            </div>
            <div class="vf-branch">
              <div class="vf-stem"></div>
              <div class="vf-node node-orange">
                <div class="vf-node-pct">${pc(ungr, parent)}</div>
                <div class="vf-node-val">${fmt(ungr)}</div>
                <div class="vf-node-lbl">${I18n.t("no_family_tag")}</div>
              </div>
            </div>
          </div>`;

        const metaItems = [
            u.total_wards  != null ? `${u.total_wards} ${I18n.t("wards")}`   : null,
            u.total_booths != null ? `${u.total_booths} ${I18n.t("booths")}` : null,
            u.total_streets != null ? `${u.total_streets} ${I18n.t("streets")}` : null,
            families       != null && families > 0 ? `${fmt(families)} ${I18n.t("families")}` : null,
        ].filter(Boolean);

        cards.className = "vf-wrap";
        cards.innerHTML = `
          <div class="vf-root">
            <div class="vf-root-top">
              <span class="vf-root-val">${fmt(total)}</span>
              <span class="vf-root-lbl">${I18n.t("total_voters")}</span>
            </div>
            ${metaItems.length ? `<div class="vf-root-meta">${metaItems.map(m => `<span>${m}</span>`).join("")}</div>` : ""}
          </div>
          <div class="vf-level vf-l1">
            <div class="vf-branch">
              <div class="vf-stem"></div>
              <div class="vf-node node-blue">
                <div class="vf-node-pct">${pc(surveyed, total)}</div>
                <div class="vf-node-val">${fmt(surveyed)}</div>
                <div class="vf-node-lbl">${I18n.t("surveyed")}</div>
              </div>
            </div>
            <div class="vf-branch">
              <div class="vf-stem"></div>
              <div class="vf-node node-gray">
                <div class="vf-node-pct">${pc(notSurv, total)}</div>
                <div class="vf-node-val">${fmt(notSurv)}</div>
                <div class="vf-node-lbl">${I18n.t("not_surveyed")}</div>
              </div>
            </div>
          </div>
          ${hasFamilyData ? `
          <div class="vf-level vf-l2-full">
            ${mkLeafPair(survInFam,    survUngr,    surveyed, survFamCount)}
            ${mkLeafPair(notSurvInFam, notSurvUngr, notSurv,  notSurvFamCount)}
          </div>` : ""}
        `;

        // Gender bar
        const g = u.gender || {};
        const gTotal = (g.M || 0) + (g.F || 0) + (g.O || 0);
        const gBar = document.getElementById("admin-gender-bar");
        if (gBar && gTotal > 0) {
            const mPct = Math.round((g.M || 0) * 100 / gTotal);
            const fPct = Math.round((g.F || 0) * 100 / gTotal);
            const oPct = 100 - mPct - fPct;
            gBar.innerHTML = `
                <div class="gender-label">${I18n.t("gender_split")}</div>
                <div class="gender-bar">
                    <div class="gender-seg male"   style="width:${mPct}%">M ${mPct}%</div>
                    <div class="gender-seg female"  style="width:${fPct}%">F ${fPct}%</div>
                    ${oPct > 0 ? `<div class="gender-seg other" style="width:${oPct}%">O ${oPct}%</div>` : ""}
                </div>
                <div class="gender-counts">
                    <span>Male: ${fmt(g.M)}</span>
                    <span>Female: ${fmt(g.F)}</span>
                    ${(g.O || 0) > 0 ? `<span>Other: ${fmt(g.O)}</span>` : ""}
                </div>
            `;
        }

        this._renderAgeChart(u.age_distribution || []);
    },

    _renderAgeChart(ageDist) {
        const ctx = document.getElementById("chart-age-dist");
        if (!ctx) return;
        if (this.chartAge) this.chartAge.destroy();
        if (!ageDist.length) return;

        // Compute total for percentage tooltips
        const total = ageDist.reduce((s, a) => s + (a.count || 0), 0);

        this.chartAge = new Chart(ctx, {
            type: "bar",
            data: {
                labels: ageDist.map((a) => a.bucket),
                datasets: [{
                    label: "Voters",
                    data: ageDist.map((a) => a.count),
                    backgroundColor: [
                        "#6366f1", "#818cf8", "#a5b4fc", "#c7d2fe", "#e0e7ff",
                    ],
                    borderRadius: 5,
                    borderSkipped: false,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (item) => {
                                const v = item.raw;
                                const pct = total > 0 ? Math.round(v * 100 / total) : 0;
                                const fmt = Number(v).toLocaleString("en-IN");
                                return `${fmt} voters (${pct}%)`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { family: "DM Sans", size: 10 }, color: "var(--text-secondary)" },
                    },
                    y: {
                        grid: { color: "rgba(0,0,0,0.04)" },
                        ticks: {
                            font: { family: "DM Sans", size: 9 },
                            color: "var(--text-secondary)",
                            callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v,
                        },
                    },
                },
            },
        });
    },

    // ── Scheme progress cards ─────────────────────────────────────────────────
    renderSchemes(schemes) {
        const c = schemes.calling || {};
        const n = schemes.notice  || {};
        const p = schemes.coupon  || {};
        const custom = schemes.custom || [];

        const fmt = (v) => Number(v || 0).toLocaleString("en-IN");

        const makeCard = (icon, label, done, total, pct, pending, color, enabled) => {
            if (!enabled && enabled !== undefined) return `
                <div class="scheme-card scheme-disabled">
                    <div class="scheme-icon">${icon}</div>
                    <div class="scheme-label">${label}</div>
                    <div class="scheme-status">Disabled</div>
                </div>`;
            return `
                <div class="scheme-card">
                    <div class="scheme-icon">${icon}</div>
                    <div class="scheme-label">${label}</div>
                    <div class="scheme-pct" style="color:${color}">${pct}%</div>
                    <div class="scheme-row">
                        <span class="scheme-done">${fmt(done)} done</span>
                        <span class="scheme-pending">${fmt(pending)} left</span>
                    </div>
                    <div class="scheme-total">of ${fmt(total)}</div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width:${pct}%;background:${color}"></div>
                    </div>
                </div>`;
        };

        const el = document.getElementById("admin-scheme-cards");
        if (!el) return;
        const customCards = custom.map(sc =>
            makeCard("📦", Booth.escHtml(sc.name), sc.done, sc.total, sc.pct, sc.pending, "#8b5cf6", true)
        ).join("");
        el.innerHTML =
            makeCard("📞", "Telecalling", c.done, c.total, c.pct, c.not_called, "#22c55e", true) +
            makeCard("📋", "Notice Dist.", n.done, n.total, n.pct, n.pending,    "#3b82f6", n.enabled) +
            makeCard("🎫", "Coupon Dist.", p.done, p.total, p.pct, p.pending,    "#f59e0b", p.enabled) +
            customCards;
    },

    // ── Geographic drill-down chart ───────────────────────────────────────────
    _updateGeoSchemeTabs(customSchemes) {
        const tabBar = document.getElementById("admin-geo-tabs");
        if (!tabBar) return;
        // Remove previously added custom tabs
        tabBar.querySelectorAll(".scheme-tab[data-custom]").forEach(el => el.remove());
        (customSchemes || []).forEach(sc => {
            const btn = document.createElement("button");
            btn.className = "scheme-tab";
            btn.dataset.geoScheme = sc.id;
            btn.dataset.custom = "1";
            btn.textContent = Booth.escHtml(sc.name);
            btn.addEventListener("click", () => {
                tabBar.querySelectorAll(".scheme-tab").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this._geoScheme = sc.id;
                this._renderGeoChart(this._drillItems);
            });
            tabBar.appendChild(btn);
        });
    },

    _geoLabel(item) {
        if (this._drillBooth) return (I18n.currentLang === "ta" && item.section_ta) ? item.section_ta : item.section;   // street level
        if (this._drillWard)  return item.booth_number ? `#${item.booth_number}` : item.booth;
        return item.ward;
    },

    _renderGeoChart(items) {
        this._drillItems = items;
        const ctx = document.getElementById("chart-geo");
        const wrap = ctx?.closest(".geo-chart-wrap");
        if (!ctx) return;
        if (this.chartGeo) { this.chartGeo.destroy(); this.chartGeo = null; }

        // Remove any previous empty/error overlay
        wrap?.querySelectorAll(".geo-empty").forEach((el) => el.remove());

        if (!items.length) {
            const msg = document.createElement("div");
            msg.className = "geo-empty";
            msg.innerHTML = "<span>No data available</span>";
            wrap?.appendChild(msg);
            return;
        }

        const s = this._geoScheme;
        const labels = items.map((it) => this._geoLabel(it));

        let datasets;
        if (s === "notice") {
            datasets = [
                { label: "Delivered", data: items.map((it) => it.notice_delivered || 0), backgroundColor: "#3b82f6", borderRadius: 4 },
                { label: "Pending",   data: items.map((it) => (it.notice_total || 0) - (it.notice_delivered || 0)), backgroundColor: "#e2e8f0", borderRadius: 4 },
            ];
        } else if (s === "coupon") {
            datasets = [
                { label: "Delivered", data: items.map((it) => it.coupon_delivered || 0), backgroundColor: "#f59e0b", borderRadius: 4 },
                { label: "Pending",   data: items.map((it) => (it.coupon_total || 0) - (it.coupon_delivered || 0)), backgroundColor: "#e2e8f0", borderRadius: 4 },
            ];
        } else if (s.startsWith("cs_")) {
            datasets = [
                { label: "Delivered", data: items.map((it) => it[`scheme_${s}_delivered`] || 0), backgroundColor: "#8b5cf6", borderRadius: 4 },
                { label: "Pending",   data: items.map((it) => (it[`scheme_${s}_total`] || 0) - (it[`scheme_${s}_delivered`] || 0)), backgroundColor: "#e2e8f0", borderRadius: 4 },
            ];
        } else {
            datasets = [
                { label: "Called",       data: items.map((it) => it.called        || 0), backgroundColor: "#22c55e", borderRadius: 4 },
                { label: "Not Called",   data: items.map((it) => it.not_called    || 0), backgroundColor: "#94a3b8", borderRadius: 4 },
                { label: "No Answer",    data: items.map((it) => it.didnt_answer  || 0), backgroundColor: "#ef4444", borderRadius: 4 },
                { label: "Skipped",      data: items.map((it) => it.skipped       || 0), backgroundColor: "#f59e0b", borderRadius: 4 },
            ];
        }

        const canDrillDown = !this._drillBooth; // can't drill further than booth level
        this.chartGeo = new Chart(ctx, {
            type: "bar",
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: canDrillDown ? (evt, els) => {
                    if (!els.length) return;
                    const idx = els[0].index;
                    this._onGeoBarClick(items[idx]);
                } : undefined,
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { font: { family: "DM Sans", size: 10 }, maxRotation: 30 } },
                    y: { stacked: true, grid: { color: "rgba(0,0,0,0.05)" }, ticks: { font: { family: "DM Sans", size: 9 }, callback: (v) => v >= 1000 ? (v/1000).toFixed(0)+"K" : v } },
                },
                plugins: {
                    legend: { position: "bottom", labels: { font: { family: "DM Sans", size: 10 }, padding: 8, usePointStyle: true, pointStyleWidth: 6 } },
                    tooltip: { callbacks: { title: (items) => items[0]?.label || "" } },
                    datalabels: {
                        display: (ctx) => {
                            // Show label only on the top (last stacked) dataset and only if value > 0
                            const ds = ctx.chart.data.datasets;
                            const isLast = ctx.datasetIndex === ds.length - 1;
                            const total = ds.reduce((s, d) => s + (d.data[ctx.dataIndex] || 0), 0);
                            return isLast && total > 0;
                        },
                        anchor: "end",
                        align: "end",
                        offset: 2,
                        font: { family: "DM Sans", size: 9, weight: "600" },
                        color: "var(--text-secondary)",
                        formatter: (_, ctx) => {
                            const total = ctx.chart.data.datasets.reduce((s, d) => s + (d.data[ctx.dataIndex] || 0), 0);
                            return Number(total).toLocaleString("en-IN");
                        },
                    },
                },
            },
        });

        const hint = document.getElementById("admin-geo-hint");
        if (hint) hint.style.display = canDrillDown ? "block" : "none";
    },

    async _onGeoBarClick(item) {
        if (this._drillBooth) return; // already at street level

        if (this._drillWard) {
            // Drill: booth → street
            const booth = item.booth;
            this._setGeoLoading(true);
            const [res] = await Promise.all([
                API.getAdminDrill(this._drillWard, booth),
                this._loadFilteredStats(this._drillWard, booth),
            ]);
            this._setGeoLoading(false);
            if (res.error) return;
            this._drillBooth = booth;
            const boothSel = document.getElementById("admin-filter-booth");
            if (boothSel) boothSel.value = booth;
            this._updateGeoSchemeTabs(res.custom_schemes || []);
            this._renderGeoChart(res.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();
        } else {
            // Drill: ward → booth
            const ward = item.ward;
            this._setGeoLoading(true);
            const [res] = await Promise.all([
                API.getAdminDrill(ward),
                this._loadFilteredStats(ward, ""),
            ]);
            this._setGeoLoading(false);
            if (res.error) return;
            this._drillWard = ward;
            const wardSel = document.getElementById("admin-filter-ward");
            if (wardSel) wardSel.value = ward;
            this._loadBoothOptions(ward);
            this._updateGeoSchemeTabs(res.custom_schemes || []);
            this._renderGeoChart(res.items || []);
            this._updateGeoTitle();
            this._updateBreadcrumb();
        }
    },

    // Populate the booth dropdown for a given ward (used when bar is clicked)
    async _loadBoothOptions(ward) {
        const boothSel = document.getElementById("admin-filter-booth");
        const clearBtn = document.getElementById("btn-dash-clear");
        if (!boothSel) return;
        boothSel.innerHTML = '<option value="">All Booths</option>';
        const res = await API.getWardBoothsList(ward);
        (res.booths || []).forEach((b) => {
            const booth = typeof b === "object" ? b.booth : b;
            const bn    = typeof b === "object" ? (b.booth_number || "") : "";
            const bname = typeof b === "object" ? (b.booth_name || "") : "";
            const opt   = document.createElement("option");
            opt.value   = booth;
            opt.textContent = bn ? `#${bn} ${bname}`.trim() : (bname || booth);
            boothSel.appendChild(opt);
        });
        boothSel.style.display = "inline-block";
        if (clearBtn) clearBtn.style.display = "inline-flex";
        if (this._drillBooth) boothSel.value = this._drillBooth;
    },

    _updateGeoTitle() {
        const el = document.getElementById("admin-geo-title");
        if (!el) return;
        if (this._drillBooth) el.textContent = "Street Performance";
        else if (this._drillWard) el.textContent = `${this._drillWard} — Booth Performance`;
        else el.textContent = "Ward Performance";
    },

    _updateBreadcrumb() {
        const el = document.getElementById("admin-geo-breadcrumb");
        if (!el) return;
        const parts = [];
        parts.push(this._scopeLocked
            ? `<span class="bc-crumb">${I18n.t("dashboard")}</span>`
            : `<span class="bc-crumb bc-link" data-bc="root">All Wards</span>`);
        if (this._drillWard) {
            if (this._drillBooth) {
                const wardCrumbClass = this._scopeLocked ? "bc-crumb" : "bc-crumb bc-link";
                parts.push(`<span class="bc-sep">›</span><span class="${wardCrumbClass}" data-bc="ward">${Booth.escHtml(this._drillWard)}</span>`);
                parts.push(`<span class="bc-sep">›</span><span class="bc-crumb">${Booth.escHtml(this._drillBooth)}</span>`);
            } else {
                parts.push(`<span class="bc-sep">›</span><span class="bc-crumb">${Booth.escHtml(this._drillWard)}</span>`);
            }
        }
        el.innerHTML = parts.join("");

        el.querySelectorAll(".bc-link").forEach((link) => {
            link.addEventListener("click", () => this._breadcrumbNav(link.dataset.bc));
        });
    },

    _breadcrumbNav(level) {
        if (level === "root") {
            this._clearFilters();
        } else if (level === "ward") {
            this._drillBooth = "";
            // Reset both superadmin and scope-locked booth dropdowns
            const boothSel = document.getElementById("admin-filter-booth");
            if (boothSel) boothSel.value = "";
            const scopeBoothSel = document.getElementById("scope-booth-sel");
            if (scopeBoothSel) scopeBoothSel.value = "";
            const scopeStreetSel = document.getElementById("scope-street-sel");
            if (scopeStreetSel) { scopeStreetSel.style.display = "none"; scopeStreetSel.value = ""; }
            this._setGeoLoading(true);
            Promise.all([
                API.getAdminDrill(this._drillWard),
                this._loadFilteredStats(this._drillWard, ""),
            ]).then(([res]) => {
                this._setGeoLoading(false);
                if (!res.error) {
                    this._renderGeoChart(res.items || []);
                    this._updateGeoTitle();
                    this._updateBreadcrumb();
                }
            });
        }
    },

    _USERS_PAGE: 20,
    _usersShown: 0,
    _usersFiltered: [],
    _activityFilter: "",
    _roleFilter: "",

    async loadUsers() {
        App.showViewLoading("view-admin-users");
        const [usersData] = await Promise.all([
            API.getAdminUsers(),
            this.loadActivity(),   // load location table in parallel
        ]);
        App.hideViewLoading("view-admin-users");
        if (usersData.error) return;

        this.allUsers = usersData.users || [];
        this._applyUserFilters();
    },

    _applyUserFilters() {
        const role = this._roleFilter;
        const activity = this._activityFilter;
        let filtered = this.allUsers || [];

        if (role) {
            filtered = filtered.filter((u) => u.role === role);
        }

        if (activity === "active") {
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            filtered = filtered.filter((u) => u.last_login_at && new Date(u.last_login_at).getTime() >= sevenDaysAgo);
        } else if (activity === "inactive") {
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            filtered = filtered.filter((u) => u.last_login_at && new Date(u.last_login_at).getTime() < sevenDaysAgo);
        } else if (activity === "never") {
            filtered = filtered.filter((u) => (!u.login_count || u.login_count === 0) && !u.has_pin);
        }

        this.renderUserList(filtered);
    },

    renderUserList(filteredUsers) {
        this._usersFiltered = filteredUsers;
        this._usersShown = 0;
        document.getElementById("user-list").innerHTML = "";
        // Reset bulk selection
        const selectAll = document.getElementById("chk-select-all");
        if (selectAll) selectAll.checked = false;
        this._updateBulkBar();
        // Show bulk action bar if there are any non-superadmin users
        const hasSelectable = this._usersFiltered.some(u => u.role !== "superadmin");
        const bulkBar = document.getElementById("bulk-action-bar");
        if (bulkBar) bulkBar.style.display = hasSelectable ? "flex" : "none";
        this._showMoreUsers();
    },

    _showMoreUsers() {
        const list = document.getElementById("user-list");
        const roleLabels = { superadmin: I18n.t("superadmin"), ward: I18n.t("ward_supervisor"), booth: I18n.t("booth_worker"), telecaller: I18n.t("telecaller") };
        const users = this._usersFiltered;
        const start = this._usersShown;
        const end = Math.min(start + this._USERS_PAGE, users.length);
        const slice = users.slice(start, end);

        // Remove old load-more button
        list.querySelector(".btn-load-more-users")?.remove();

        const frag = document.createDocumentFragment();
        const temp = document.createElement("div");
        temp.innerHTML = slice.map((u) => {
            const boothLabel = u.booth ? this.formatBoothLabel(u.booth_name, u.booth_number, 30, u.booth_name_tamil) : "";
            const disabledBadge = u.active === false ? `<span class="sec-badge sec-badge-disabled">Disabled</span>` : "";
            const locationBadge = (u.last_lat && u.last_lng)
                ? `<a class="sec-badge sec-badge-location" href="https://www.google.com/maps?q=${u.last_lat},${u.last_lng}" target="_blank" rel="noopener">${this._fmtLocationAge(u.last_location_at)}</a>`
                : (u.geo_tracking ? `<span class="sec-badge sec-badge-geo-pending" title="Geo tracking enabled, no fix yet">--</span>` : "");

            // Login info line — has_pin means user set up PIN (i.e. logged in at least once)
            const loginCount = u.login_count || 0;
            let loginLine = "";
            if (loginCount > 0) {
                const lastAge = this._fmtLocationAge(u.last_login_at);
                loginLine = `<div class="user-row-login"><span class="login-count">${loginCount} login${loginCount !== 1 ? "s" : ""}</span><span>Last: ${lastAge}</span></div>`;
            } else if (!u.has_pin) {
                loginLine = `<div class="user-row-login"><span class="login-never">Never logged in</span></div>`;
            }

            // Checkbox for non-superadmin
            const checkbox = u.role !== "superadmin"
                ? `<div class="user-row-check"><input type="checkbox" class="chk-user" data-phone="${u.phone}"></div>`
                : "";

            return `
            <div class="user-row">
                ${checkbox}
                <div class="user-row-info">
                    <div class="user-row-name">${Booth.escHtml(u.name)}</div>
                    <div class="user-row-meta">
                        <span class="role-badge ${u.role}">${roleLabels[u.role] || u.role}</span>
                        ${u.ward ? ` | ${u.ward}` : ""}${boothLabel ? ` | ${boothLabel}` : ""}
                        | ...${u.phone.slice(-4)}
                    </div>
                    ${loginLine}
                    <div class="user-row-badges">${disabledBadge}${locationBadge}</div>
                </div>
                ${u.role !== "superadmin" ? `
                <div class="user-row-actions">
                    <button class="btn-edit btn btn-secondary btn-sm" data-phone="${u.phone}">${I18n.t("edit")}</button>
                    <button class="btn-remove btn btn-danger btn-sm" data-phone="${u.phone}" data-role="${u.role}">${I18n.t("remove")}</button>
                </div>` : ""}
            </div>`;
        }).join("");

        // Bind edit/remove on the new rows
        temp.querySelectorAll(".btn-edit").forEach((btn) => {
            btn.addEventListener("click", () => {
                const user = (this.allUsers || []).find(u => u.phone === btn.dataset.phone);
                if (user) this.openEditUser(user);
            });
        });
        temp.querySelectorAll(".btn-remove").forEach((btn) => {
            btn.addEventListener("click", async () => {
                if (!confirm(I18n.t("confirm_remove_user"))) return;
                App.setBtnLoading(btn, true);
                const result = await API.removeUser(btn.dataset.phone);
                App.setBtnLoading(btn, false);
                if (result.success) {
                    App.showToast(I18n.t("user_removed"));
                    this.loadUsers();
                }
            });
        });
        // Bind checkbox changes
        temp.querySelectorAll(".chk-user").forEach((chk) => {
            chk.addEventListener("change", () => this._updateBulkBar());
        });

        while (temp.firstChild) frag.appendChild(temp.firstChild);
        list.appendChild(frag);
        this._usersShown = end;

        // "Load More" button
        if (end < users.length) {
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary btn-load-more-users";
            btn.style.cssText = "width:100%;margin-top:8px;padding:10px;font-size:0.85rem;";
            btn.textContent = `Load More (${users.length - end} remaining)`;
            btn.addEventListener("click", () => this._showMoreUsers());
            list.appendChild(btn);
        }
    },

    // ── Bulk selection helpers ────────────────────────────────────────────────
    _getSelectedPhones() {
        return Array.from(document.querySelectorAll(".chk-user:checked")).map(c => c.dataset.phone);
    },

    _updateBulkBar() {
        const selected = this._getSelectedPhones();
        const countEl = document.getElementById("bulk-selected-count");
        const removeBtn = document.getElementById("btn-bulk-remove");
        if (countEl) countEl.textContent = selected.length > 0 ? `${selected.length} selected` : "";
        if (removeBtn) removeBtn.style.display = selected.length > 0 ? "inline-flex" : "none";
    },

    _onSelectAllChange(checked) {
        document.querySelectorAll(".chk-user").forEach((chk) => { chk.checked = checked; });
        this._updateBulkBar();
    },

    async _bulkRemove() {
        const phones = this._getSelectedPhones();
        if (!phones.length) return;
        if (!confirm(`Remove ${phones.length} user${phones.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;

        const btn = document.getElementById("btn-bulk-remove");
        if (btn) App.setBtnLoading(btn, true);
        const result = await API.bulkRemoveUsers(phones);
        if (btn) App.setBtnLoading(btn, false);

        if (result.success) {
            const msg = `Removed ${result.removed} user${result.removed !== 1 ? "s" : ""}` +
                (result.skipped > 0 ? ` (${result.skipped} skipped)` : "");
            App.showToast(msg);
            this.loadUsers();
        } else {
            App.showToast(result.detail || "Bulk remove failed");
        }
    },

    _editingPhone: null,

    async openAddUser() {
        this._editingPhone = null;
        document.getElementById("modal-add-user").style.display = "flex";
        document.getElementById("new-user-phone").value = "";
        document.getElementById("new-user-phone").disabled = false;
        document.getElementById("new-user-name").value = "";
        document.getElementById("new-user-role").value = "booth";
        document.getElementById("add-user-error").textContent = "";
        const modalTitle = document.querySelector("#modal-add-user h3");
        if (modalTitle) { modalTitle.setAttribute("data-i18n", "add_user"); modalTitle.textContent = I18n.t("add_user"); }
        document.getElementById("btn-save-user").textContent = I18n.t("save");

        const data = await API.getWards();
        const wardSel = document.getElementById("new-user-ward");
        wardSel.innerHTML = `<option value="">${I18n.t("select_ward")}</option>`;
        (data.wards || []).forEach((w) => {
            const opt = document.createElement("option");
            opt.value = w; opt.textContent = w; wardSel.appendChild(opt);
        });
        this.onRoleChange();
    },

    async openEditUser(user) {
        this._editingPhone = user.phone;
        document.getElementById("modal-add-user").style.display = "flex";
        document.getElementById("add-user-error").textContent = "";
        const modalTitle = document.querySelector("#modal-add-user h3");
        if (modalTitle) modalTitle.textContent = I18n.t("edit_user") || "Edit User";
        document.getElementById("btn-save-user").textContent = I18n.t("save") || "Save";

        // Phone read-only in edit mode
        const phoneEl = document.getElementById("new-user-phone");
        phoneEl.value = user.phone;
        phoneEl.disabled = true;

        document.getElementById("new-user-name").value = user.name || "";
        document.getElementById("new-user-role").value = user.role || "booth";

        // Load wards then set current values
        const data = await API.getWards();
        const wardSel = document.getElementById("new-user-ward");
        wardSel.innerHTML = `<option value="">${I18n.t("select_ward")}</option>`;
        (data.wards || []).forEach((w) => {
            const opt = document.createElement("option");
            opt.value = w; opt.textContent = w; wardSel.appendChild(opt);
        });
        this.onRoleChange();
        if (user.ward) {
            wardSel.value = user.ward;
            await this.onWardChange();
            if (user.booth) document.getElementById("new-user-booth").value = user.booth;
        }

        // ── Security settings section ────────────────────────────────────────
        const secSection = document.getElementById("user-security-section");
        if (secSection) {
            const isAdmin = user.role === "superadmin";
            secSection.style.display = isAdmin ? "none" : "block";
            // Always start collapsed
            const secBody = document.getElementById("user-security-body");
            const chevron = document.querySelector("#btn-toggle-security .collapse-chevron");
            if (secBody) secBody.style.display = "none";
            if (chevron) chevron.style.transform = "";

            if (!isAdmin) {
                // Active toggle
                document.getElementById("user-active-toggle").checked = user.active !== false;

                // Geo tracking
                document.getElementById("user-geo-toggle").checked = !!user.geo_tracking;

                // Schedule
                let schedule = {always: true};
                if (user.schedule) {
                    try { schedule = JSON.parse(user.schedule); } catch(e) { /* ignore */ }
                }
                this._renderScheduleTimes(schedule);
                // Hook up always-toggle
                const alwaysToggle = document.getElementById("user-schedule-always");
                const newAlways = alwaysToggle.cloneNode(true);
                alwaysToggle.parentNode.replaceChild(newAlways, alwaysToggle);
                newAlways.checked = schedule.always !== false;
                newAlways.addEventListener("change", () => {
                    const timesDiv = document.getElementById("user-schedule-times");
                    if (timesDiv) timesDiv.style.display = newAlways.checked ? "none" : "flex";
                });

            }
        }
    },

    // Internal: collect and save security settings; returns false on validation error
    async _saveSecuritySettings() {
        const phone = this._editingPhone;
        if (!phone) return true;

        const active = document.getElementById("user-active-toggle").checked;
        const geo_tracking = document.getElementById("user-geo-toggle").checked;
        const always = document.getElementById("user-schedule-always").checked;
        const schedule = always ? JSON.stringify({always: true}) : JSON.stringify(this._readScheduleTimes());

        const result = await API.updateUserSettings(phone, {active, geo_tracking, schedule});
        if (result.error) {
            document.getElementById("add-user-error").textContent = result.detail || "Failed to save settings";
            return false;
        }
        return true;
    },

    closeAddUser() {
        document.getElementById("modal-add-user").style.display = "none";
    },

    onRoleChange() {
        const role = document.getElementById("new-user-role").value;
        document.getElementById("new-user-ward-group").style.display = role === "superadmin" ? "none" : "block";
        document.getElementById("new-user-booth-group").style.display = role === "booth" ? "block" : "none";
    },

    /* Note: telecaller validation - ward required, no booth - is handled server-side */

    async onWardChange() {
        const ward = document.getElementById("new-user-ward").value;
        const boothSel = document.getElementById("new-user-booth");
        boothSel.innerHTML = `<option value="">${I18n.t("select_booth")}</option>`;
        if (!ward) return;

        const data = await API.getWardBoothsList(ward);
        (data.booths || []).forEach((b) => {
            const opt = document.createElement("option");
            const booth = typeof b === "object" ? b.booth : b;
            const bn = typeof b === "object" ? b.booth_number : "";
            const bname = typeof b === "object" ? b.booth_name : "";
            const bnameTa = typeof b === "object" ? (b.booth_name_tamil || "") : "";
            opt.value = booth;
            opt.textContent = bn ? `Booth #${bn}` : (bname || booth);
            boothSel.appendChild(opt);
        });
    },

    async saveUser() {
        const phone = document.getElementById("new-user-phone").value.trim();
        const name = document.getElementById("new-user-name").value.trim();
        const role = document.getElementById("new-user-role").value;
        const ward = document.getElementById("new-user-ward").value;
        const booth = document.getElementById("new-user-booth").value;

        if (!phone || phone.length !== 10 || !/^\d{10}$/.test(phone)) {
            document.getElementById("add-user-error").textContent = "Enter valid 10-digit phone";
            return;
        }
        if (!name) {
            document.getElementById("add-user-error").textContent = "Name is required";
            return;
        }
        if (role !== "superadmin" && !ward) {
            document.getElementById("add-user-error").textContent = "Select a ward";
            return;
        }
        if (role === "booth" && !booth) {
            document.getElementById("add-user-error").textContent = "Select a booth";
            return;
        }

        const btn = document.getElementById("btn-save-user");
        App.setBtnLoading(btn, true);

        // Safety: never allow editing a user who has a superadmin role anywhere
        if (this._editingPhone) {
            const hasSuperadmin = (this.allUsers || [])
                .filter(u => u.phone === this._editingPhone)
                .some(u => u.role === "superadmin");
            if (hasSuperadmin) {
                document.getElementById("add-user-error").textContent = "Cannot edit a superadmin account";
                App.setBtnLoading(btn, false);
                return;
            }
        }

        const payload = { phone, name, role, ward: ward || "", booth: booth || "" };
        const result = this._editingPhone
            ? await API.updateUser(this._editingPhone, payload)
            : await API.addUser(payload);

        if (result.error) {
            App.setBtnLoading(btn, false);
            document.getElementById("add-user-error").textContent = result.detail;
            return;
        }

        // In edit mode, also save security settings if the section is visible
        if (this._editingPhone) {
            const secSection = document.getElementById("user-security-section");
            if (secSection && secSection.style.display !== "none") {
                const ok = await this._saveSecuritySettings();
                if (!ok) { App.setBtnLoading(btn, false); return; }
            }
        }

        App.setBtnLoading(btn, false);
        App.showToast(this._editingPhone ? (I18n.t("user_updated") || "User updated") : I18n.t("user_added"));
        this._editingPhone = null;
        this.closeAddUser();
        this.loadUsers();
    },

    _LOC_PAGE: 20,
    _locUsers: [],
    _locShown: 0,

    async loadActivity() {
        const container = document.getElementById("activity-location-table");
        if (!container) return;
        container.innerHTML = `<div class="loading-spinner-sm"></div>`;

        const res = await API.getUserLocations();
        if (res.error) { container.innerHTML = `<p class="empty-state">${res.detail}</p>`; return; }

        this._locUsers = res.users || [];
        const users = this._locUsers;
        const roleLabels = { superadmin: "Admin", ward: "Ward", booth: "Booth", telecaller: "Telecaller" };

        const withLoc = users.filter(u => u.last_lat && u.last_lng);
        const pending = users.filter(u => u.geo_tracking && (!u.last_lat || !u.last_lng));
        const noTrack = users.filter(u => !u.geo_tracking);

        const summaryEl = document.getElementById("activity-location-summary");
        if (summaryEl) {
            summaryEl.innerHTML = `
                <span class="loc-chip chip-located">${withLoc.length} located</span>
                <span class="loc-chip chip-pending">${pending.length} pending</span>
                <span class="loc-chip chip-off">${noTrack.length} tracking off</span>`;
        }

        if (!users.length) { container.innerHTML = `<p class="empty-state">No users found.</p>`; return; }

        // Render table header + first page
        const firstSlice = users.slice(0, this._LOC_PAGE);
        container.innerHTML = `<table class="data-table">
            <thead><tr>
                <th>Name</th><th>Phone</th><th>Role</th><th>Ward</th><th>Last Location</th>
            </tr></thead>
            <tbody>${this._locRows(firstSlice)}</tbody>
        </table>`;
        this._locShown = firstSlice.length;

        if (this._locShown < users.length) {
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary btn-load-more-loc";
            btn.style.cssText = "width:100%;margin-top:8px;padding:10px;font-size:0.85rem;";
            btn.textContent = `Load More (${users.length - this._locShown} remaining)`;
            btn.addEventListener("click", () => this._showMoreLoc());
            container.appendChild(btn);
        }
    },

    _locRows(slice) {
        const roleLabels = { superadmin: "Admin", ward: "Ward", booth: "Booth", telecaller: "Telecaller" };
        return slice.map(u => {
            const age = this._fmtLocationAge(u.last_location_at);
            const locCell = (u.last_lat && u.last_lng)
                ? `<a class="loc-map-link" href="https://www.google.com/maps?q=${u.last_lat},${u.last_lng}" target="_blank" rel="noopener">📍 ${age}</a>`
                : (u.geo_tracking
                    ? `<span class="loc-no-fix">No fix yet</span>`
                    : `<span class="loc-off">Off</span>`);
            return `<tr>
                <td>${Booth.escHtml(u.name || "—")}</td>
                <td>...${u.phone.slice(-4)}</td>
                <td><span class="role-badge ${u.role}">${roleLabels[u.role] || u.role}</span></td>
                <td>${Booth.escHtml(u.ward || "—")}</td>
                <td>${locCell}</td>
            </tr>`;
        }).join("");
    },

    _showMoreLoc() {
        const container = document.getElementById("activity-location-table");
        if (!container) return;
        const tbody = container.querySelector("tbody");
        if (!tbody) return;
        const start = this._locShown;
        const end = Math.min(start + this._LOC_PAGE, this._locUsers.length);
        tbody.insertAdjacentHTML("beforeend", this._locRows(this._locUsers.slice(start, end)));
        this._locShown = end;

        container.querySelector(".btn-load-more-loc")?.remove();
        if (end < this._locUsers.length) {
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary btn-load-more-loc";
            btn.style.cssText = "width:100%;margin-top:8px;padding:10px;font-size:0.85rem;";
            btn.textContent = `Load More (${this._locUsers.length - end} remaining)`;
            btn.addEventListener("click", () => this._showMoreLoc());
            container.appendChild(btn);
        }
    },

    async loadSyncFailures() {
        const container = document.getElementById("sync-failures-list");
        container.innerHTML = `<div class="loading-spinner-sm"></div>`;
        const res = await API.get("/api/admin/notice/sync-failures");
        if (res.error) { container.innerHTML = `<p class="empty-state">${res.detail}</p>`; return; }
        const failures = res.failures || [];
        if (!failures.length) {
            container.innerHTML = `<div class="empty-state"><p>No sync failures recorded.</p></div>`;
            return;
        }
        container.innerHTML = failures.map(f => {
            const time = f.failed_at ? new Date(f.failed_at).toLocaleString() : "-";
            const attempted = f.attempted_at ? new Date(f.attempted_at).toLocaleString() : "-";
            const voterCount = (f.voter_ids || []).length;
            return `<div class="sync-failure-row">
                <div class="sync-failure-header">
                    <span class="sync-failure-action ${f.action}">${f.action === "deliver" ? "✓ Deliver" : "✗ Undeliver"}</span>
                    <span class="sync-failure-time">${time}</span>
                </div>
                <div class="sync-failure-meta">
                    <span>${f.ward} · ${f.booth}</span>
                    <span>${voterCount} voter${voterCount !== 1 ? "s" : ""}</span>
                    <span>${f.by_name || f.by_phone || "-"}</span>
                </div>
                <div class="sync-failure-reason">${this.escHtml(f.fail_reason || "")}</div>
            </div>`;
        }).join("");
    },
};
