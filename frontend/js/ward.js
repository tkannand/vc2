const Ward = {
    drillBooth: "",
    drillTab: "not_called",
    drillStreet: "",
    drillFamilies: [],
    drillFamilyIndex: 0,
    _cachedHomeData: null,

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
        App.showViewLoading("view-ward-home");
        await this.loadHome();
        App.hideViewLoading("view-ward-home");
        document.getElementById("btn-ward-back").addEventListener("click", () => this.exitDrill());
        this.bindDrillTabs();
        this.bindDrillStreetFilter();
        this.bindDrillFamilyNav();
        this.bindHomeBoothFilter();
    },

    bindHomeBoothFilter() {
        const sel = document.getElementById("ward-home-booth-filter");
        if (sel) {
            sel.addEventListener("change", () => {
                this.renderStatsForBooth(sel.value);
            });
        }
    },

    hasPendingInCurrentDrillFamily() {
        if (this.drillFamilies.length === 0) return false;
        const fam = this.drillFamilies[this.drillFamilyIndex];
        if (!fam) return false;
        return (fam.members || []).some((m) =>
            Booth.calledVoterIds.has(m.voter_id) || m.status === "in_progress"
        );
    },

    async checkPendingStatus() {
        return false;
    },

    renderStatCards(targetId, data) {
        const cards = document.getElementById(targetId);
        cards.innerHTML = `
            <div class="stat-card accent">
                <div class="stat-value">${data.total}</div>
                <div class="stat-label">${I18n.t("total_voters")}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-value">${data.called}</div>
                <div class="stat-label">${I18n.t("called")}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-value">${data.not_called}</div>
                <div class="stat-label">${I18n.t("not_called")}</div>
            </div>
            <div class="stat-card danger">
                <div class="stat-value">${data.didnt_answer + data.skipped}</div>
                <div class="stat-label">${I18n.t("didnt_answer_skipped")}</div>
            </div>
            <div class="stat-card wide">
                <div class="stat-label">${I18n.t("completion")} - ${data.completion_pct}%</div>
                <div class="progress-bar-container"><div class="progress-bar" style="width:${data.completion_pct}%"></div></div>
            </div>
        `;
    },

    async loadHome() {
        App.showViewLoading("view-ward-home");
        const user = App.getUser();
        const data = await API.getWardStats(user.ward);
        App.hideViewLoading("view-ward-home");
        if (data.error) return;

        this._cachedHomeData = data;
        this.renderStatCards("ward-stats-cards", data);

        // Populate booth filter dropdown
        const sel = document.getElementById("ward-home-booth-filter");
        if (sel) {
            sel.innerHTML = `<option value="">${I18n.t("all_booths") || "All Booths"}</option>`;
            (data.booths || []).forEach((b) => {
                const opt = document.createElement("option");
                opt.value = b.booth;
                const label = this.formatBoothLabel(b.booth_name, b.booth_number, 30, b.booth_name_tamil);
                opt.textContent = label || b.booth;
                sel.appendChild(opt);
            });
        }

        // Booth buttons grid
        const grid = document.getElementById("ward-booth-buttons");
        grid.innerHTML = (data.booths || []).map((b) => `
            <button class="booth-btn" data-booth="${Booth.escHtml(b.booth)}" data-booth-number="${Booth.escHtml(b.booth_number || "")}" data-booth-name="${Booth.escHtml(b.booth_name || "")}" data-booth-name-tamil="${Booth.escHtml(b.booth_name_tamil || "")}">
                ${b.booth_number ? `<span class="booth-btn-num">#${Booth.escHtml(b.booth_number)}</span>` : ""}
                <span class="booth-btn-name">${Booth.escHtml(I18n.currentLang === "ta" && b.booth_name_tamil ? b.booth_name_tamil : (b.booth_name || b.booth))}</span>
                <span class="booth-btn-pct">${b.completion_pct}%</span>
                <div class="booth-btn-bar"><div class="booth-btn-bar-fill" style="width:${b.completion_pct}%"></div></div>
            </button>
        `).join("");

        grid.querySelectorAll(".booth-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                this.enterDrill(btn.dataset.booth, btn.dataset.boothNumber, btn.dataset.boothName, btn.dataset.boothNameTamil);
            });
        });
    },

    renderStatsForBooth(boothId) {
        if (!this._cachedHomeData) return;
        if (!boothId) {
            // Show overall ward stats
            this.renderStatCards("ward-stats-cards", this._cachedHomeData);
            return;
        }
        const booth = (this._cachedHomeData.booths || []).find((b) => b.booth === boothId);
        if (!booth) return;
        this.renderStatCards("ward-stats-cards", {
            total: booth.total,
            called: booth.called,
            not_called: booth.not_called,
            didnt_answer: booth.didnt_answer || 0,
            skipped: booth.skipped || 0,
            completion_pct: booth.completion_pct,
        });
    },

    async loadStatsPage() {
        App.showViewLoading("view-ward-stats");
        const user = App.getUser();
        const data = await API.getWardStats(user.ward);
        App.hideViewLoading("view-ward-stats");
        if (data.error) return;

        this.renderStatCards("ward-stats-cards-detail", data);

        // Booth performance list with progress bars
        const boothList = document.getElementById("ward-booth-stats");
        boothList.innerHTML = (data.booths || []).map((b) => `
            <div class="booth-stat-row" data-booth="${Booth.escHtml(b.booth)}" data-booth-number="${Booth.escHtml(b.booth_number || "")}" data-booth-name="${Booth.escHtml(b.booth_name || "")}" data-booth-name-tamil="${Booth.escHtml(b.booth_name_tamil || "")}">
                <div class="stat-row-top">
                    <span class="stat-row-name">${b.booth_number ? `<small class="booth-num-tag">#${Booth.escHtml(b.booth_number)}</small> ` : ""}${Booth.escHtml(I18n.currentLang === "ta" && b.booth_name_tamil ? b.booth_name_tamil : (b.booth_name || b.booth))}</span>
                    <span class="stat-row-pct">${b.completion_pct}%</span>
                </div>
                <div class="progress-bar-container"><div class="progress-bar" style="width:${b.completion_pct}%"></div></div>
                <div class="stat-row-nums">
                    <span>${I18n.t("called")}: ${b.called}</span>
                    <span>${I18n.t("pending")}: ${b.not_called}</span>
                    <span>${I18n.t("total")}: ${b.total}</span>
                </div>
            </div>
        `).join("");

        // Click booth to drill down
        boothList.querySelectorAll(".booth-stat-row").forEach((row) => {
            row.addEventListener("click", () => {
                this.enterDrill(row.dataset.booth, row.dataset.boothNumber, row.dataset.boothName, row.dataset.boothNameTamil);
            });
        });

        // Leaderboard
        const lb = document.getElementById("ward-leaderboard");
        lb.innerHTML = (data.workers || []).map((w, i) => `
            <div class="leader-row">
                <span class="leader-rank ${i < 3 ? "top" : ""}">${i + 1}</span>
                <div class="leader-info">
                    <div class="leader-name">${Booth.escHtml(w.name)}</div>
                    <div class="leader-stats">${I18n.t("called")}: ${w.called} | ${I18n.t("total")}: ${w.total}</div>
                </div>
                <span class="leader-count">${w.called}</span>
            </div>
        `).join("") || `<p class="text-center" style="color:var(--text-muted);padding:16px;">${I18n.t("no_activity")}</p>`;
    },

    async enterDrill(booth, boothNumber, boothName, boothNameTamil) {
        this.drillBooth = booth;
        this.drillTab = "not_called";
        this.drillStreet = "";
        this.drillFamilyIndex = 0;

        document.getElementById("ward-drill-title").textContent = this.formatBoothLabel(boothName, boothNumber, 40, boothNameTamil);
        App.showView("view-ward-booth");

        // Reset tabs
        const container = document.getElementById("view-ward-booth");
        container.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        container.querySelector('.tab[data-tab="not_called"]').classList.add("active");

        App.showViewLoading("view-ward-booth");
        await this.loadDrillStreets();
        await this.loadDrillFamilies();
        App.hideViewLoading("view-ward-booth");
    },

    async exitDrill() {
        this.drillBooth = "";
        App.showView("view-ward-home");
        // Re-activate the Home nav button
        document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
        const homeNav = document.querySelector('.nav-item[data-view="view-ward-home"]');
        if (homeNav) homeNav.classList.add("active");
        await this.loadHome();
    },

    async loadDrillStreets() {
        const user = App.getUser();
        const data = await API.getWardBoothStreets(user.ward, this.drillBooth);
        if (data.error) return;

        const sel = document.getElementById("ward-street-filter");
        sel.innerHTML = `<option value="">${I18n.t("all_streets")}</option>`;
        (data.streets || []).forEach((s) => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = s;
            sel.appendChild(opt);
        });
    },

    async loadDrillFamilies() {
        App.showViewLoading("view-ward-booth");
        const user = App.getUser();
        const data = await API.getWardBoothFamilies(user.ward, this.drillBooth, this.drillStreet, this.drillTab);
        App.hideViewLoading("view-ward-booth");
        if (data.error) return;

        this.drillFamilies = data.families || [];

        // Track any in_progress voters from server
        for (const fam of this.drillFamilies) {
            for (const m of fam.members || []) {
                if (m.status === "in_progress") {
                    Booth.calledVoterIds.add(m.voter_id);
                }
            }
        }

        this.renderDrillFamily();
    },

    renderDrillFamily() {
        const area = document.getElementById("ward-family-card-area");
        const nav = document.getElementById("ward-family-nav");
        const empty = document.getElementById("ward-empty-state");

        if (this.drillFamilies.length === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            empty.style.display = "block";
            return;
        }

        empty.style.display = "none";
        nav.style.display = "flex";

        if (this.drillFamilyIndex >= this.drillFamilies.length) {
            this.drillFamilyIndex = this.drillFamilies.length - 1;
        }

        const fam = this.drillFamilies[this.drillFamilyIndex];
        document.getElementById("ward-family-counter").textContent =
            `${this.drillFamilyIndex + 1} ${I18n.t("of")} ${this.drillFamilies.length}`;

        document.getElementById("btn-ward-prev-family").disabled = this.drillFamilyIndex === 0;
        document.getElementById("btn-ward-next-family").disabled = this.drillFamilyIndex >= this.drillFamilies.length - 1;

        area.innerHTML = Booth.buildFamilyCard(fam, "ward");
        Booth.bindMemberActions(area, "ward");
    },

    bindDrillTabs() {
        const container = document.getElementById("view-ward-booth");
        container.querySelectorAll(".tab").forEach((tab) => {
            tab.addEventListener("click", async () => {
                container.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
                tab.classList.add("active");
                this.drillTab = tab.dataset.tab;
                this.drillFamilyIndex = 0;
                await this.loadDrillFamilies();
            });
        });
    },

    bindDrillStreetFilter() {
        const sel = document.getElementById("ward-street-filter");
        if (sel) {
            sel.addEventListener("change", async () => {
                this.drillStreet = sel.value;
                this.drillFamilyIndex = 0;
                await this.loadDrillFamilies();
            });
        }
    },

    bindDrillFamilyNav() {
        document.getElementById("btn-ward-prev-family").addEventListener("click", () => {
            if (this.drillFamilyIndex > 0) { this.drillFamilyIndex--; this.renderDrillFamily(); }
        });
        document.getElementById("btn-ward-next-family").addEventListener("click", () => {
            if (this.drillFamilyIndex < this.drillFamilies.length - 1) { this.drillFamilyIndex++; this.renderDrillFamily(); }
        });
    },
};
