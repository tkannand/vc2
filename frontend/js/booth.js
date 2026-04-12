const Booth = {
    families: [],
    currentFamilyIndex: 0,
    currentTab: "not_called",
    currentStreet: "",
    calledVoterIds: new Set(),

    async init() {
        this.calledVoterIds.clear();
        this.bindTabs("view-booth-voters");
        this.bindStreetFilter();
        this.bindFamilyNav();
        App.showViewLoading("view-booth-home");
        await Promise.all([this.loadStreets(), this.loadStats()]);
        App.hideViewLoading("view-booth-home");
    },

    hasPendingInCurrentFamily() {
        if (this.families.length === 0) return false;
        const fam = this.families[this.currentFamilyIndex];
        if (!fam) return false;
        return (fam.members || []).some((m) =>
            this.calledVoterIds.has(m.voter_id) || m.status === "in_progress"
        );
    },

    async checkPendingStatus() {
        const user = App.getUser();
        if (!user) return false;
        const data = await API.getBoothPendingStatus(user.ward, user.booth);
        if (!data.has_pending) return false;

        const pending = data.pending[0];
        App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");

        // Switch to not_called tab and load families to find the pending voter
        this.currentTab = "not_called";
        this.currentStreet = "";
        await this.loadAllFamiliesForPending(pending.famcode);
        return true;
    },

    async loadAllFamiliesForPending(famcode) {
        const user = App.getUser();
        // Load all families (not filtered by tab) to find the pending one
        const data = await API.get(`/api/booth/families?ward=${encodeURIComponent(user.ward)}&booth=${encodeURIComponent(user.booth)}&tab=not_called`);
        if (data.error) return;

        this.families = data.families || [];
        // Find the family with the pending voter
        const idx = this.families.findIndex((f) => f.famcode === famcode);
        if (idx >= 0) {
            this.currentFamilyIndex = idx;
        } else {
            this.currentFamilyIndex = 0;
        }

        // Mark pending voters in calledVoterIds
        for (const fam of this.families) {
            for (const m of fam.members || []) {
                if (m.status === "in_progress") {
                    this.calledVoterIds.add(m.voter_id);
                }
            }
        }

        App.showView("view-booth-voters");
        this.renderFamily();
    },

    bindTabs(viewId) {
        const container = document.getElementById(viewId);
        if (!container) return;
        container.querySelectorAll(".tab").forEach((tab) => {
            tab.addEventListener("click", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");
                    return;
                }
                container.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
                tab.classList.add("active");
                this.currentTab = tab.dataset.tab;
                this.currentFamilyIndex = 0;
                App.showViewLoading("view-booth-voters");
                await this.loadFamilies();
                App.hideViewLoading("view-booth-voters");
            });
        });
    },

    bindStreetFilter() {
        const sel = document.getElementById("booth-street-filter");
        if (sel) {
            sel.addEventListener("change", async () => {
                if (this.hasPendingInCurrentFamily()) {
                    App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");
                    sel.value = this.currentStreet;
                    return;
                }
                this.currentStreet = sel.value;
                this.currentFamilyIndex = 0;
                App.showViewLoading("view-booth-voters");
                await this.loadFamilies();
                App.hideViewLoading("view-booth-voters");
            });
        }
    },

    bindFamilyNav() {
        const prev = document.getElementById("btn-prev-family");
        const next = document.getElementById("btn-next-family");
        if (prev) prev.addEventListener("click", () => this.prevFamily());
        if (next) next.addEventListener("click", () => this.nextFamily());
    },

    async loadStreets() {
        const user = App.getUser();
        const data = await API.getStreets(user.ward, user.booth);
        if (data.error) return;

        const sel = document.getElementById("booth-street-filter");
        sel.innerHTML = `<option value="">${I18n.t("all_streets")}</option>`;
        (data.streets || []).forEach((s) => {
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = s;
            sel.appendChild(opt);
        });
    },

    async loadFamilies() {
        App.showViewLoading("view-booth-voters");
        const user = App.getUser();
        const data = await API.getFamilies(user.ward, user.booth, this.currentStreet, this.currentTab);
        App.hideViewLoading("view-booth-voters");
        if (data.error) return;

        this.families = data.families || [];

        // Track any in_progress voters from server
        for (const fam of this.families) {
            for (const m of fam.members || []) {
                if (m.status === "in_progress") {
                    this.calledVoterIds.add(m.voter_id);
                }
            }
        }

        this.renderFamily();
    },

    renderFamily() {
        const area = document.getElementById("family-card-area");
        const nav = document.getElementById("family-nav");
        const empty = document.getElementById("booth-empty-state");

        if (this.families.length === 0) {
            area.innerHTML = "";
            nav.style.display = "none";
            empty.style.display = "block";
            return;
        }

        empty.style.display = "none";
        nav.style.display = "flex";

        if (this.currentFamilyIndex >= this.families.length) {
            this.currentFamilyIndex = this.families.length - 1;
        }

        const fam = this.families[this.currentFamilyIndex];
        document.getElementById("family-counter").textContent =
            `${this.currentFamilyIndex + 1} ${I18n.t("of")} ${this.families.length}`;

        document.getElementById("btn-prev-family").disabled = this.currentFamilyIndex === 0;
        document.getElementById("btn-next-family").disabled = this.currentFamilyIndex >= this.families.length - 1;

        area.innerHTML = this.buildFamilyCard(fam, "booth");
        this.bindMemberActions(area, "booth");
    },

    buildFamilyCard(fam, mode) {
        const members = fam.members || [];
        const membersHtml = members.map((m) => this.buildMemberRow(m, mode)).join("");
        const boothName = I18n.currentLang === "ta" && fam.booth_name_tamil ? fam.booth_name_tamil : (fam.booth_name || "");
        const boothLabel = fam.booth_number ? `${fam.booth_number}. ${boothName}` : boothName;

        let noticeTag = "";
        if (mode === "telecaller" && Telecaller.selectedSchemeIds.length > 0 && fam.scheme_total > 0) {
            const tags = Telecaller.selectedSchemeIds.map(sid => {
                const schemeName = (Telecaller.allSchemes.find(s => s.id === sid) || {}).name || "";
                const delivered = (fam.scheme_deliveries || {})[sid] || 0;
                const total = fam.scheme_total;
                if (delivered === total) {
                    return `<span class="notice-tag notice-tag-full">${schemeName} ✓</span>`;
                } else if (delivered > 0) {
                    return `<span class="notice-tag notice-tag-partial">${schemeName} ${delivered}/${total}</span>`;
                } else {
                    return `<span class="notice-tag notice-tag-none">No ${schemeName}</span>`;
                }
            }).join("");
            noticeTag = tags;
        }

        return `
            <div class="family-card">
                <div class="family-header">
                    <div>
                        <div class="family-head-name">${this.escHtml(I18n.t("house"))}: ${this.escHtml(fam.house || "-")}</div>
                        <div class="family-meta">
                            <span>${this.escHtml(fam.section || "")}</span>
                            ${boothLabel ? `<span>${this.escHtml(boothLabel)}</span>` : ""}
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                        ${noticeTag}
                        <span class="family-member-count">${members.length} ${I18n.t("members")}</span>
                    </div>
                </div>
                <div class="family-members">${membersHtml}</div>
            </div>
        `;
    },

    buildMemberRow(m, mode) {
        const isHead = m.is_head === "Yes";
        const headBadge = isHead ? `<span class="member-head-badge">👑</span>` : "";
        const statusBadge = m.status && m.status !== "not_called"
            ? `<span class="status-badge ${m.status}">${I18n.t(m.status)}</span>` : "";

        const phoneSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
        let phoneSection;
        if (!m.has_phone) {
            phoneSection = `<div class="member-phone-row"><span class="no-phone-label">${I18n.t("no_phone")}</span></div>`;
        } else {
            const labels = m.phone_labels || ["Phone 1"];
            const btns = labels.map((lbl) => {
                const isWa = lbl === "WhatsApp";
                return `<button class="btn-call ${isWa ? "btn-call-wa" : ""}" data-voter="${m.voter_id}" data-mode="${mode}" data-call-label="${lbl}">
                    ${phoneSvg} ${lbl}
                </button>`;
            }).join("");
            const dupTag = m.has_duplicate_phone ? `<span class="phone-dup-tag">Duplicate</span>` : "";
            phoneSection = `<div class="member-phone-row" data-voter="${m.voter_id}">${btns}${dupTag}</div>`;
        }

        const showActions = this.currentTab === "not_called" || m.status === "not_called" || m.status === "in_progress";
        const showRetry = (m.status === "didnt_answer" || m.status === "skipped");

        let actionsHtml = "";
        if (showActions) {
            actionsHtml = `
                <div class="member-status-row" data-voter="${m.voter_id}">
                    <button class="btn-status" data-status="called" data-voter="${m.voter_id}">${I18n.t("called")}</button>
                    <button class="btn-status" data-status="didnt_answer" data-voter="${m.voter_id}">${I18n.t("didnt_answer")}</button>
                    <button class="btn-status" data-status="skipped" data-voter="${m.voter_id}">${I18n.t("skipped")}</button>
                </div>
                <div class="member-notes-row" data-voter="${m.voter_id}">
                    <textarea class="notes-input" data-voter="${m.voter_id}" placeholder="${I18n.t("notes_optional")}">${m.notes || ""}</textarea>
                    <button class="btn btn-primary btn-full btn-sm btn-submit-status mt-8" data-voter="${m.voter_id}" data-mode="${mode}">${I18n.t("submit")}</button>
                </div>
            `;
        } else if (showRetry) {
            actionsHtml = `
                <button class="btn btn-secondary btn-sm btn-retry mt-8" data-voter="${m.voter_id}" data-mode="${mode}">${I18n.t("retry")}</button>
            `;
        }

        const dispName = I18n.currentLang === "ta" && m.name_ta ? m.name_ta : m.name;
        const relName = I18n.currentLang === "ta" && m.relation_name_ta ? m.relation_name_ta : (m.relation_name || "-");

        return `
            <div class="member-row" data-voter="${m.voter_id}"
                data-name-en="${this.escHtml(m.name || "")}"
                data-name-ta="${this.escHtml(m.name_ta || "")}"
                data-rel-en="${this.escHtml(m.relation_name || "")}"
                data-rel-ta="${this.escHtml(m.relation_name_ta || "")}">
                <div class="member-top">
                    <div>
                        <span class="member-name">${this.escHtml(dispName)}</span>${headBadge}
                    </div>
                    ${statusBadge}
                </div>
                <div class="member-details">
                    <span class="member-detail"><span class="label">${I18n.t("age")}:</span> ${m.age}</span>
                    <span class="member-detail"><span class="label">${I18n.t("gender")}:</span> ${m.gender === "Male" ? I18n.t("male") : I18n.t("female")}</span>
                    <span class="member-detail"><span class="label">${I18n.t("relationship")}:</span> ${this.escHtml(m.relationship || "-")}</span>
                    <span class="member-detail member-rel-name"><span class="label">${I18n.t("relation_name")}:</span> ${this.escHtml(relName)}</span>
                </div>
                ${phoneSection}
                ${actionsHtml}
            </div>
        `;
    },

    refreshCardLanguage() {
        const isTamil = I18n.currentLang === "ta";
        document.querySelectorAll(".member-row[data-name-en]").forEach((row) => {
            const nameEl = row.querySelector(".member-name");
            if (nameEl) {
                const ta = row.dataset.nameTa;
                const en = row.dataset.nameEn;
                nameEl.textContent = (isTamil && ta) ? ta : en;
            }
            const relEl = row.querySelector(".member-rel-name");
            if (relEl) {
                const label = I18n.t("relation_name");
                const ta = row.dataset.relTa;
                const en = row.dataset.relEn;
                const name = (isTamil && ta) ? ta : (en || "-");
                relEl.innerHTML = `<span class="label">${label}:</span> ${name}`;
            }
        });
    },

    bindMemberActions(container, mode) {
        // Call buttons
        container.querySelectorAll(".btn-call").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const voterId = btn.dataset.voter;
                const callType = btn.dataset.callType || "phone";
                const user = App.getUser();
                App.setBtnLoading(btn, true);
                let data;
                if (mode === "telecaller") {
                    const booth = Telecaller.families[Telecaller.familyIndex]?.booth;
                    data = await API.telecallerRevealPhone(user.ward, booth, voterId);
                } else if (mode === "ward") {
                    data = await API.wardRevealPhone(user.ward, Ward.drillBooth, voterId);
                } else {
                    data = await API.revealPhone(user.ward, user.booth, voterId);
                }
                App.setBtnLoading(btn, false);
                const phones = data.phones || [];
                if (phones.length === 0) return;
                this.calledVoterIds.add(voterId);
                // Find the number matching the tapped label
                const callLabel = btn.dataset.callLabel || "";
                const match = phones.find((p) => p.label === callLabel) || phones[0];
                if (match && match.number) {
                    const isWa = match.label === "WhatsApp";
                    const a = document.createElement("a");
                    a.href = isWa ? `https://wa.me/${match.number}` : `tel:${match.number}`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
            });
        });

        // Status buttons
        container.querySelectorAll(".btn-status").forEach((btn) => {
            btn.addEventListener("click", () => {
                const voterId = btn.dataset.voter;
                const status = btn.dataset.status;
                const row = btn.closest(".member-status-row");
                row.querySelectorAll(".btn-status").forEach((b) => {
                    b.className = "btn-status";
                });
                btn.classList.add(`selected-${status}`);
                btn.dataset.selectedStatus = status;

                const notesRow = container.querySelector(`.member-notes-row[data-voter="${voterId}"]`);
                if (notesRow) notesRow.classList.add("visible");
            });
        });

        // Submit buttons
        container.querySelectorAll(".btn-submit-status").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const voterId = btn.dataset.voter;
                const statusRow = container.querySelector(`.member-status-row[data-voter="${voterId}"]`);
                const selected = statusRow.querySelector(".btn-status[class*='selected-']");
                if (!selected) {
                    App.showToast(I18n.t("mark_status"));
                    return;
                }
                const status = selected.dataset.status;
                const notes = container.querySelector(`.notes-input[data-voter="${voterId}"]`)?.value || "";

                App.setBtnLoading(btn, true);
                const user = App.getUser();
                let result;
                if (mode === "telecaller") {
                    const booth = Telecaller.families[Telecaller.familyIndex]?.booth;
                    result = await API.telecallerUpdateStatus(user.ward, booth, voterId, status, notes);
                } else if (mode === "ward") {
                    result = await API.wardUpdateStatus(user.ward, Ward.drillBooth, voterId, status, notes);
                } else {
                    result = await API.updateStatus(user.ward, user.booth, voterId, status, notes);
                }
                App.setBtnLoading(btn, false);

                if (result.success) {
                    // Remove from pending set
                    this.calledVoterIds.delete(voterId);
                    App.showToast(I18n.t("status_updated"));
                    if (mode === "telecaller") {
                        await Telecaller.loadFamilies();
                    } else if (mode === "ward") {
                        await Ward.loadDrillFamilies();
                    } else {
                        await this.loadFamilies();
                    }
                }
            });
        });

        // Retry buttons
        container.querySelectorAll(".btn-retry").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const voterId = btn.dataset.voter;
                App.setBtnLoading(btn, true);
                const user = App.getUser();
                let result;
                if (mode === "telecaller") {
                    const booth = Telecaller.families[Telecaller.familyIndex]?.booth;
                    result = await API.telecallerUpdateStatus(user.ward, booth, voterId, "not_called", "");
                } else if (mode === "ward") {
                    result = await API.wardUpdateStatus(user.ward, Ward.drillBooth, voterId, "not_called", "");
                } else {
                    result = await API.updateStatus(user.ward, user.booth, voterId, "not_called", "");
                }
                App.setBtnLoading(btn, false);
                if (result.success) {
                    App.showToast(I18n.t("status_updated"));
                    if (mode === "telecaller") {
                        await Telecaller.loadFamilies();
                    } else if (mode === "ward") {
                        await Ward.loadDrillFamilies();
                    } else {
                        await this.loadFamilies();
                    }
                }
            });
        });
    },

    nextFamily() {
        if (this.hasPendingInCurrentFamily()) {
            App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");
            return;
        }
        if (this.currentFamilyIndex < this.families.length - 1) {
            this.currentFamilyIndex++;
            this.renderFamily();
        }
    },

    prevFamily() {
        if (this.hasPendingInCurrentFamily()) {
            App.showToast(I18n.t("pending_status_required") || "Please update call status before continuing");
            return;
        }
        if (this.currentFamilyIndex > 0) {
            this.currentFamilyIndex--;
            this.renderFamily();
        }
    },

    async loadStats() {
        App.showViewLoading("view-booth-home");
        const user = App.getUser();
        const data = await API.getBoothStats(user.ward, user.booth);
        App.hideViewLoading("view-booth-home");
        if (data.error) return;

        const cards = document.getElementById("booth-stats-cards");
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

        const streetList = document.getElementById("booth-street-stats");
        streetList.innerHTML = (data.sections || []).map((s) => `
            <div class="street-stat-row">
                <div class="stat-row-top">
                    <span class="stat-row-name">${this.escHtml(s.section)}</span>
                    <span class="stat-row-pct">${s.pct}%</span>
                </div>
                <div class="progress-bar-container"><div class="progress-bar" style="width:${s.pct}%"></div></div>
                <div class="stat-row-nums">
                    <span>${I18n.t("called")}: ${s.called}</span>
                    <span>${I18n.t("pending")}: ${s.not_called}</span>
                    <span>${I18n.t("total")}: ${s.total}</span>
                </div>
            </div>
        `).join("");
    },

    escHtml(str) {
        const div = document.createElement("div");
        div.textContent = str || "";
        return div.innerHTML;
    },
};
