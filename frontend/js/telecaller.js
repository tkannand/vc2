const Telecaller = {
    currentBooth: "",
    currentStreet: "",
    currentTab: "not_called",
    partyFilter: "",
    families: [],
    familiesAll: [],
    familyIndex: 0,
    allBooths: [],
    allSchemes: [],
    selectedSchemeIds: [],
    deliveredOnlyFilter: true,

    async init() {
        this.families = [];
        this.familiesAll = [];
        this.familyIndex = 0;
        this.currentBooth = "";
        this.currentStreet = "";
        this.currentTab = "not_called";
        this.partyFilter = "";
        this.allSchemes = [];
        this.selectedSchemeIds = [];
        this.deliveredOnlyFilter = true;

        this.bindBoothFilter();
        this.bindStreetFilter();
        this.bindTabs();
        this.bindFamilyNav();
        this.bindPartyFilter();

        App.showViewLoading("view-telecaller");
        await this.loadBooths();
        if (this.allBooths.length > 0) {
            this.currentBooth = this.allBooths[0].booth;
            document.getElementById("tc-booth-filter").value = this.currentBooth;
        }
        await Promise.all([this.loadStreets(), this.loadSchemes()]);
        await this.loadFamilies();
        App.hideViewLoading("view-telecaller");

        await this.checkPendingStatus();
    },

    hasPendingInCurrentFamily() {
        if (this.families.length === 0) return false;
        const fam = this.families[this.familyIndex];
        if (!fam) return false;
        return (fam.members || []).some((m) =>
            Booth.calledVoterIds.has(m.voter_id) || m.status === "in_progress"
        );
    },

    async checkPendingStatus() {
        const user = App.getUser();
        if (!user) return false;

        const data = await API.getTelecallerPendingStatus(user.ward);
        if (!data.has_pending) return false;

        const pending = data.pending[0];
        App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");

        this.currentBooth = pending.booth;
        document.getElementById("tc-booth-filter").value = this.currentBooth;
        this.currentTab = "not_called";
        this.setActiveTab("not_called");
        await this.loadStreets();
        await this.loadFamilies();

        const idx = this.families.findIndex((f) =>
            f.famcode === pending.famcode && f.booth === this.currentBooth
        );
        if (idx >= 0) {
            this.familyIndex = idx;
            this.renderFamily();
        }

        for (const fam of this.families) {
            for (const m of fam.members || []) {
                if (m.status === "in_progress") {
                    Booth.calledVoterIds.add(m.voter_id);
                }
            }
        }
        return true;
    },

    async loadBooths() {
        const user = App.getUser();
        const data = await API.getTelecallerBooths(user.ward);
        if (data.error) return;

        this.allBooths = data.booths || [];
        const sel = document.getElementById("tc-booth-filter");
        sel.innerHTML = `<option value="">${I18n.t("all_booths")}</option>`;
        this.allBooths.forEach((b) => {
            const opt = document.createElement("option");
            opt.value = b.booth;
            opt.textContent = Ward.formatBoothLabel(b.booth_name, b.booth_number, 28, b.booth_name_tamil) || b.booth;
            sel.appendChild(opt);
        });
    },

    async loadStreets() {
        const user = App.getUser();
        const data = await API.getTelecallerStreets(user.ward, this.currentBooth);
        if (data.error) return;

        const sel = document.getElementById("tc-street-filter");
        sel.innerHTML = `<option value="">${I18n.t("all_streets")}</option>`;
        (data.streets || []).forEach((s) => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = s;
            sel.appendChild(opt);
        });
    },

    async loadSchemes() {
        const data = await API.getSchemes();
        this.allSchemes = data.schemes || [];
        const bar = document.getElementById("tc-scheme-bar");
        const pillsEl = document.getElementById("tc-scheme-pills");
        const delivBtn = document.getElementById("btn-tc-delivered-filter");
        if (!bar || !pillsEl || this.allSchemes.length === 0) return;

        // All schemes selected by default
        this.selectedSchemeIds = this.allSchemes.map(s => s.id);

        // Render pills
        pillsEl.innerHTML = this.allSchemes.map(s =>
            `<button class="tc-pill active" data-scheme-id="${s.id}">${s.name}</button>`
        ).join("");

        bar.style.display = "block";

        // Pill click: toggle scheme selection
        pillsEl.querySelectorAll(".tc-pill").forEach(pill => {
            pill.addEventListener("click", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required"));
                    return;
                }
                const sid = pill.dataset.schemeId;
                const idx = this.selectedSchemeIds.indexOf(sid);
                if (idx >= 0) {
                    this.selectedSchemeIds.splice(idx, 1);
                    pill.classList.remove("active");
                } else {
                    this.selectedSchemeIds.push(sid);
                    pill.classList.add("active");
                }
                this.familyIndex = 0;
                await this.loadFamilies();
            });
        });

        // Delivered-only toggle
        if (delivBtn) {
            delivBtn.addEventListener("click", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required"));
                    return;
                }
                this.deliveredOnlyFilter = !this.deliveredOnlyFilter;
                delivBtn.classList.toggle("btn-primary", this.deliveredOnlyFilter);
                delivBtn.classList.toggle("btn-secondary", !this.deliveredOnlyFilter);
                this.applySchemeFilter();
            });
        }
    },

    async loadFamilies() {
        App.showViewLoading("view-telecaller");
        const user = App.getUser();
        const data = await API.getTelecallerFamilies(
            user.ward, this.currentBooth, this.currentStreet,
            this.currentTab, this.selectedSchemeIds, this.partyFilter
        );
        App.hideViewLoading("view-telecaller");
        if (data.error) return;

        this.familiesAll = data.families || [];
        this.familyIndex = 0;

        for (const fam of this.familiesAll) {
            for (const m of fam.members || []) {
                if (m.status === "in_progress") {
                    Booth.calledVoterIds.add(m.voter_id);
                }
            }
        }

        this.applySchemeFilter();
    },

    applySchemeFilter() {
        const active = this.selectedSchemeIds;
        if (!this.deliveredOnlyFilter || active.length === 0) {
            this.families = this.familiesAll;
        } else {
            this.families = this.familiesAll.filter(f => {
                const d = f.scheme_deliveries || {};
                return active.some(sid => (d[sid] || 0) > 0);
            });
        }
        this.familyIndex = 0;
        this.renderFamily();
    },

    renderFamily() {
        const area = document.getElementById("tc-family-card-area");
        const nav = document.getElementById("tc-family-nav");
        const empty = document.getElementById("tc-empty-state");

        if (this.families.length === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            empty.style.display = "block";
            return;
        }

        empty.style.display = "none";
        nav.style.display = "flex";

        if (this.familyIndex >= this.families.length) {
            this.familyIndex = this.families.length - 1;
        }

        const fam = this.families[this.familyIndex];
        document.getElementById("tc-family-counter").textContent =
            `${this.familyIndex + 1} ${I18n.t("of")} ${this.families.length}`;

        document.getElementById("btn-tc-prev-family").disabled = this.familyIndex === 0;
        document.getElementById("btn-tc-next-family").disabled = this.familyIndex >= this.families.length - 1;

        area.innerHTML = Booth.buildFamilyCard(fam, "telecaller");
        Booth.bindMemberActions(area, "telecaller");
    },

    setActiveTab(tab) {
        const container = document.getElementById("view-telecaller");
        container.querySelectorAll(".tab").forEach((t) => {
            t.classList.toggle("active", t.dataset.tab === tab);
        });
    },

    bindTabs() {
        const container = document.getElementById("view-telecaller");
        container.querySelectorAll(".tab").forEach((tab) => {
            tab.addEventListener("click", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");
                    return;
                }
                container.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
                tab.classList.add("active");
                this.currentTab = tab.dataset.tab;
                this.familyIndex = 0;
                await this.loadFamilies();
            });
        });
    },

    bindBoothFilter() {
        const sel = document.getElementById("tc-booth-filter");
        if (sel) {
            sel.addEventListener("change", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required"));
                    sel.value = this.currentBooth;
                    return;
                }
                this.currentBooth = sel.value;
                this.currentStreet = "";
                this.familyIndex = 0;
                document.getElementById("tc-street-filter").value = "";
                await this.loadStreets();
                await this.loadFamilies();
            });
        }
    },

    bindStreetFilter() {
        const sel = document.getElementById("tc-street-filter");
        if (sel) {
            sel.addEventListener("change", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required"));
                    sel.value = this.currentStreet;
                    return;
                }
                this.currentStreet = sel.value;
                this.familyIndex = 0;
                await this.loadFamilies();
            });
        }
    },

    bindFamilyNav() {
        document.getElementById("btn-tc-prev-family").addEventListener("click", () => {
            if (this.hasPendingInCurrentFamily()) {
                App.showToast(I18n.t("pending_status_required"));
                return;
            }
            if (this.familyIndex > 0) {
                this.familyIndex--;
                this.renderFamily();
            }
        });
        document.getElementById("btn-tc-next-family").addEventListener("click", () => {
            if (this.hasPendingInCurrentFamily()) {
                App.showToast(I18n.t("pending_status_required"));
                return;
            }
            if (this.familyIndex < this.families.length - 1) {
                this.familyIndex++;
                this.renderFamily();
            }
        });
    },

    bindPartyFilter() {
        document.querySelectorAll(".tc-party-pill").forEach((pill) => {
            pill.addEventListener("click", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required"));
                    return;
                }
                document.querySelectorAll(".tc-party-pill").forEach((p) => p.classList.remove("active"));
                pill.classList.add("active");
                this.partyFilter = pill.dataset.party;
                this.familyIndex = 0;
                await this.loadFamilies();
            });
        });
    },
};
