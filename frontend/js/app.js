const App = {
    user: null,
    currentView: "",
    viewEnterTime: 0,
    _geoWatchId: null,
    _lastLat: null,
    _lastLng: null,
    _heartbeatInterval: null,

    // ── Geo-tracking ───────────────────────────────────────────────────────────
    startGeoTracking() {
        if (!navigator.geolocation) return;
        this._geoWatchId = navigator.geolocation.watchPosition(
            (pos) => { this._lastLat = pos.coords.latitude; this._lastLng = pos.coords.longitude; },
            () => { /* denied or unavailable — silent */ },
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
        );
    },

    stopGeoTracking() {
        if (this._geoWatchId != null) { navigator.geolocation.clearWatch(this._geoWatchId); this._geoWatchId = null; }
        this._lastLat = null; this._lastLng = null;
    },

    startHeartbeat() {
        this.stopHeartbeat();
        // Every 5 minutes: send heartbeat (with GPS if available)
        this._heartbeatInterval = setInterval(() => {
            if (!this.user) return;
            API.heartbeat(this.currentView || "background", 300000, this._lastLat, this._lastLng);
        }, 5 * 60 * 1000);
    },

    stopHeartbeat() {
        if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
    },

    async start() {
        console.log("[App] start");
        const savedLang = I18n.getSavedLang();
        console.log("[App] i18n init...");
        await I18n.init(savedLang || "en");
        console.log("[App] i18n done");

        Auth.init();
        Accessibility.init();
        console.log("[App] NoticeQueue init...");
        NoticeQueue.init();
        DeliveryQueue.init();
        console.log("[App] NoticeQueue done");

        // Check existing session
        console.log("[App] getMe...");
        const me = await API.getMe();
        console.log("[App] getMe done", me?.authenticated);
        if (me.authenticated && me.user) {
            this.setUser(me.user);
            if (me.user.language) I18n.setLang(me.user.language);
            console.log("[App] initForRole", me.user.role);
            this.initForRole(me.user.role);
            console.log("[App] initForRole done");
        } else {
            console.log("[App] showAuthFlow");
            this.showAuthFlow();
        }

        this.hideLoading();
        console.log("[App] hideLoading done");
    },

    showAuthFlow() {
        this.hideAppChrome();
        document.getElementById("bottom-nav").innerHTML = "";
        const savedLang = I18n.getSavedLang();
        if (savedLang) {
            this.showView("view-login");
        } else {
            this.showView("view-language");
        }
    },

    hideAppChrome() {
        document.getElementById("app-header").style.display = "none";
        document.getElementById("user-bar").style.display = "none";
        document.getElementById("bottom-nav").style.display = "none";
        // Remove top padding when no header
        document.getElementById("main-content").style.paddingTop = "0";
        document.getElementById("main-content").style.paddingBottom = "0";
    },

    showAppChrome() {
        document.getElementById("app-header").style.display = "flex";
        document.getElementById("user-bar").style.display = "flex";
        document.getElementById("bottom-nav").style.display = "flex";
        document.getElementById("main-content").style.paddingTop = "";
        document.getElementById("main-content").style.paddingBottom = "";
        document.body.classList.remove("single-page-role");
        const fl = document.getElementById("btn-float-logout");
        if (fl) fl.style.display = "none";
        // Logout button lives in header — always show when chrome is visible
        const btnLogout = document.getElementById("btn-logout");
        if (btnLogout) btnLogout.style.display = "flex";
    },

    async initForRole(role) {
        this.showAppChrome();
        Timer.start();
        this.updateUserBar();
        this.startHeartbeat();
        // Start geo-tracking if enabled for this user
        if (this.user?.geo_tracking) this.startGeoTracking();

        // Check enabled features
        const [schemesRes] = await Promise.all([
            API.getSchemes(),
            Notice.checkEnabled(),
            Coupon.checkEnabled(),
        ]);
        NoticeQueue.startDrain();
        DeliveryQueue.startDrain();

        const schemes = schemesRes.schemes || [];

        // If no schemes enabled, booth/ward workers can't use the app
        if ((role === "booth" || role === "ward") && schemes.length === 0) {
            this.clearUser();
            this.showAuthFlow();
            this.showToast("No features enabled. Contact your administrator.");
            return;
        }

        try {
            if (role === "booth") {
                this.setupBoothNav();
                this.showView("view-admin-home");
                await Admin.init();
                await Admin.loadDashboard({ ward: this.user.ward, booth: this.user.booth });
            } else if (role === "ward") {
                this.setupWardNav();
                this.showView("view-admin-home");
                await Admin.init();
                await Admin.loadDashboard({ ward: this.user.ward });
            } else if (role === "telecaller") {
                this.setupTelecallerNav();
                this.showView("view-telecaller");
                await Telecaller.init();
            } else if (role === "superadmin") {
                this.setupAdminNav();
                this.showView("view-admin-home");
                await Admin.init();
                await Admin.loadDashboard();
            }
        } catch (e) {
            console.error("initForRole error:", e);
        }
    },

    updateUserBar() {
        if (!this.user) return;
        document.getElementById("user-name").textContent = this.user.name || this.user.phone;
        const badge = document.getElementById("user-role-badge");
        const roleLabels = { superadmin: I18n.t("superadmin"), ward: I18n.t("ward_supervisor"), booth: I18n.t("booth_worker"), telecaller: I18n.t("telecaller") };
        badge.textContent = roleLabels[this.user.role] || this.user.role;
        badge.className = `role-badge ${this.user.role}`;

        // Show/hide switch ward button
        const btnSwitch = document.getElementById("btn-switch-ward");
        if (btnSwitch) {
            let roles = [];
            try { roles = JSON.parse(localStorage.getItem("vc_user_roles") || "[]"); } catch(e) {}
            if (roles.length > 1) {
                badge.style.display = "none";
                btnSwitch.style.display = "inline-flex";
                // Set label based on language
                const switchLabel = btnSwitch.querySelector(".switch-label");
                if (switchLabel) switchLabel.textContent = I18n.currentLang === "ta" ? "\u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BC1" : "Switch";
                // Bind click only once
                if (!btnSwitch._switchBound) {
                    btnSwitch.addEventListener("click", () => this.showSwitchModal());
                    btnSwitch._switchBound = true;
                }
            } else {
                badge.style.display = "";
                btnSwitch.style.display = "none";
            }
        }

        this.updateLangButton();
        this.updateScopeLabels();
    },

    updateScopeLabels() {
        if (!this.user) return;
        const isTamil = I18n.currentLang === "ta";
        const boothName = (isTamil && this.user.booth_name_tamil) ? this.user.booth_name_tamil : (this.user.booth_name || "");
        const boothNum = this.user.booth_number || "";
        const boothLabel = boothNum ? `#${boothNum} ${boothName}`.trim() : boothName;
        const ward = this.user.ward || "";
        const role = this.user.role || "";
        const roleLabels = { ward: I18n.t("ward_supervisor"), booth: I18n.t("booth_worker") };

        const buildScopeBox = (el, showBooth) => {
            if (!el || !ward) return;
            el.innerHTML = `
                <div class="scope-role">${roleLabels[role] || role}</div>
                <div class="scope-ward">${ward}</div>
                ${showBooth && boothLabel ? `<div class="scope-booth">${boothLabel}</div>` : ""}
            `;
            el.style.display = "flex";
        };

        const boothScope = document.getElementById("booth-scope-label");
        buildScopeBox(boothScope, true);

        const wardScope = document.getElementById("ward-scope-label");
        buildScopeBox(wardScope, false);

        // Admin dashboard scope
        const adminScope = document.getElementById("admin-scope-label");
        if (adminScope) {
            if (role === "superadmin") {
                adminScope.style.display = "none";
            } else {
                buildScopeBox(adminScope, role === "booth");
            }
        }
    },

    updateLangButton() {
        const btn = document.getElementById("btn-lang-toggle");
        if (!btn) return;
        btn.textContent = I18n.currentLang === "en" ? "\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD" : "English";

        // Settings icon — only for superadmin
        const settingsBtn = document.getElementById("btn-header-settings");
        if (settingsBtn) {
            const role = this.user?.role;
            settingsBtn.style.display = role === "superadmin" ? "flex" : "none";
            const newBtn = settingsBtn.cloneNode(true);
            settingsBtn.parentNode.replaceChild(newBtn, settingsBtn);
            newBtn.style.display = role === "superadmin" ? "flex" : "none";
            if (role === "superadmin") {
                newBtn.addEventListener("click", async () => {
                    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
                    this.showView("view-admin-settings");
                    await Notice.loadSettings();
                });
            }
        }
    },

    setupBoothNav() {
        const nav = document.getElementById("bottom-nav");
        nav.innerHTML = `
            <button class="nav-item active" data-view="view-admin-home" data-action="load-booth-dashboard">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                <span>${I18n.t("dashboard")}</span>
            </button>
            <button class="nav-item" data-view="view-booth-scheme" data-action="load-booth-scheme">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <span>Schemes</span>
            </button>
        `;
        this.bindNav();
    },

    setupTelecallerNav() {
        document.getElementById("bottom-nav").style.display = "none";
        document.getElementById("btn-float-logout").style.display = "none";
        document.body.classList.add("single-page-role");
    },

    setupWardNav() {
        const nav = document.getElementById("bottom-nav");
        nav.innerHTML = `
            <button class="nav-item active" data-view="view-admin-home" data-action="load-ward-dashboard">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                <span>${I18n.t("dashboard")}</span>
            </button>
            <button class="nav-item" data-view="view-ward-scheme" data-action="load-ward-scheme">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <span>Schemes</span>
            </button>
        `;
        this.bindNav();
    },

    setupAdminNav() {
        const nav = document.getElementById("bottom-nav");
        nav.innerHTML = `
            <button class="nav-item active" data-view="view-admin-home">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                <span>${I18n.t("dashboard")}</span>
            </button>
            <button class="nav-item" data-view="view-admin-users">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <span>${I18n.t("users")}</span>
            </button>
            <button class="nav-item" data-view="view-admin-scheme" data-action="load-admin-scheme">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <span>${I18n.t("schemes")}</span>
            </button>
            <button class="nav-item" data-view="view-admin-sync-failures" data-action="load-admin-sync-failures">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <span>Errors</span>
            </button>
        `;
        this.bindNav();
    },

    bindNav() {
        document.querySelectorAll(".nav-item").forEach((item) => {
            item.addEventListener("click", async () => {
                document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
                item.classList.add("active");

                const view = item.dataset.view;
                const action = item.dataset.action;

                this.showView(view);

                if (action === "refresh-stats") {
                    App.showViewLoading(view);
                    await Booth.loadStats();
                    await Booth.loadFamilies();
                    App.hideViewLoading(view);
                } else if (action === "load-ward-stats") {
                    await Ward.loadStatsPage();
                } else if (view === "view-ward-home") {
                    await Ward.loadHome();
                } else if (action === "load-ward-dashboard") {
                    await Admin.loadDashboard({ ward: App.user?.ward || "" });
                } else if (action === "load-booth-dashboard") {
                    await Admin.loadDashboard({ ward: App.user?.ward || "", booth: App.user?.booth || "" });
                } else if (view === "view-admin-home") {
                    await Admin.loadDashboard();
                } else if (view === "view-admin-users") {
                    await Admin.loadUsers();
                } else if (view === "view-booth-voters") {
                    await Booth.loadFamilies();
                } else if (action === "load-booth-scheme") {
                    await Scheme.initBooth();
                } else if (action === "load-ward-scheme") {
                    await Scheme.initWard();
                } else if (action === "load-admin-scheme") {
                    await Scheme.initAdmin();
                } else if (action === "load-admin-sync-failures") {
                    await Admin.loadSyncFailures();
                }
            });
        });
    },

    showView(viewId) {
        // Log time on previous view (only if logged in)
        if (this.user && this.currentView && this.viewEnterTime) {
            const dur = Date.now() - this.viewEnterTime;
            API.logActivity("view_exit", this.currentView, "", dur);
        }

        document.querySelectorAll(".view").forEach((v) => (v.style.display = "none"));
        const target = document.getElementById(viewId);
        if (target) {
            target.style.display = "block";
            this.currentView = viewId;
            this.viewEnterTime = Date.now();
        }

        // Scroll to top
        document.getElementById("main-content").scrollTop = 0;
    },

    hideLoading() {
        const loading = document.getElementById("loading-screen");
        const app = document.getElementById("app");
        loading.classList.add("fade-out");
        app.style.display = "flex";
        setTimeout(() => { loading.style.display = "none"; }, 400);
    },

    setUser(user) {
        this.user = user;
        localStorage.setItem("vc_user", JSON.stringify(user));
    },

    getUser() {
        if (this.user) return this.user;
        const saved = localStorage.getItem("vc_user");
        if (saved) {
            try {
                this.user = JSON.parse(saved);
                return this.user;
            } catch (e) { /* ignore */ }
        }
        return null;
    },

    clearUser() {
        this.user = null;
        localStorage.removeItem("vc_user");
        localStorage.removeItem("vc_user_roles");
        const bl = document.getElementById("btn-logout");
        if (bl) bl.style.display = "none";
        Timer.stop();
        this.stopHeartbeat();
        this.stopGeoTracking();
    },

    handleSessionExpired() {
        this.clearUser();
        this.showAuthFlow();
        this.showToast(I18n.t("session_expired"));
    },

    // ---- Loading indicator helpers ----

    reloadCurrentView() {
        const v = this.currentView;

        // Scheme views — re-render from cached data, no API call
        try {
            if (v === "view-booth-scheme" || v === "view-ward-scheme") {
                Scheme.refreshLanguage();
                return;
            }
        } catch(e) {}

        // Booth home — refresh street filters + stats labels from cache
        try {
            if (v === "view-booth-home") {
                Booth.refreshLanguage();
                return;
            }
        } catch(e) {}

        // Telecaller / Booth calling — re-render card in-place
        try {
            if (Telecaller.families && Telecaller.families.length > 0) {
                Telecaller.renderFamily();
                return;
            }
        } catch(e) {}
        try {
            if (Booth.families && Booth.families.length > 0) {
                Booth.refreshCardLanguage();
                Booth.refreshLanguage();
                Booth.renderFamily();
                return;
            }
        } catch(e) {}

        // Dashboard / stats — need data reload
        try { if (v === "view-ward-home") { Ward.loadHome(); return; } } catch(e) {}
        try { if (v === "view-admin-home") { Admin.loadDashboard(); return; } } catch(e) {}

        // Fallback nav click (stats pages etc.)
        const activeNav = document.querySelector(".nav-item.active");
        if (activeNav) activeNav.click();
    },

    showViewLoading(viewId) {
        const view = document.getElementById(viewId);
        if (!view) return;
        const container = view.querySelector(".view-content") || view;
        if (container.querySelector(".view-loading-overlay")) return;
        const overlay = document.createElement("div");
        overlay.className = "view-loading-overlay";
        overlay.innerHTML = '<div class="vl-spinner"></div>';
        container.appendChild(overlay);
    },

    hideViewLoading(viewId) {
        const view = document.getElementById(viewId);
        if (!view) return;
        const container = view.querySelector(".view-content") || view;
        const overlay = container.querySelector(".view-loading-overlay");
        if (overlay) overlay.remove();
    },

    setBtnLoading(btn, isLoading) {
        if (!btn) return;
        if (isLoading) {
            if (!btn.dataset.origHtml) {
                btn.dataset.origHtml = btn.innerHTML;
            }
            btn.disabled = true;
            btn.classList.add("btn-loading");
            btn.innerHTML = `<span class="btn-text">${btn.dataset.origHtml}</span><span class="btn-spinner"></span>`;
        } else {
            btn.classList.remove("btn-loading");
            btn.disabled = false;
            if (btn.dataset.origHtml) {
                btn.innerHTML = btn.dataset.origHtml;
                delete btn.dataset.origHtml;
            }
        }
    },

    showSwitchModal() {
        let roles = [];
        try { roles = JSON.parse(localStorage.getItem("vc_user_roles") || "[]"); } catch(e) {}
        if (roles.length < 2) return;

        const roleLabels = {
            superadmin: I18n.t("superadmin"),
            ward: I18n.t("ward_supervisor"),
            booth: I18n.t("booth_worker"),
            telecaller: I18n.t("telecaller"),
        };
        const roleIcons = {
            superadmin: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
            ward: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
            booth: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
            telecaller: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        };

        const currentWard = this.user?.ward || "";
        const currentBooth = this.user?.booth || "";
        const currentRole = this.user?.role || "";

        const container = document.getElementById("switch-ward-roles");
        container.innerHTML = roles.map((r) => {
            const detail = r.ward ? (r.booth ? `${r.ward} / ${r.booth}` : r.ward) : "";
            const escWard = (r.ward || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            const escBooth = (r.booth || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            const isCurrent = r.role === currentRole && (r.ward || "") === currentWard && (r.booth || "") === currentBooth;
            return `
                <button class="role-select-btn ${isCurrent ? "switch-current" : ""}" data-role="${r.role}" data-ward="${escWard}" data-booth="${escBooth}" ${isCurrent ? "disabled" : ""}>
                    <div class="role-icon ${r.role}">${roleIcons[r.role] || ""}</div>
                    <div class="role-text">
                        <div class="role-label">${roleLabels[r.role] || r.role}</div>
                        ${detail ? `<div class="role-detail">${detail}</div>` : ""}
                    </div>
                    ${isCurrent ? '<span class="switch-current-label">Current</span>' : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
                </button>
            `;
        }).join("");

        // Event delegation for role card clicks
        container.onclick = (e) => {
            const btn = e.target.closest(".role-select-btn:not([disabled])");
            if (btn) this.switchToRole(btn.dataset.role, btn.dataset.ward, btn.dataset.booth);
        };

        const modal = document.getElementById("switch-ward-modal");
        modal.style.display = "flex";

        // Close on overlay click (not on content clicks)
        modal.onclick = (e) => {
            if (e.target === modal || e.target.id === "switch-ward-overlay") {
                modal.style.display = "none";
            }
        };
    },

    async switchToRole(role, ward, booth) {
        const modal = document.getElementById("switch-ward-modal");
        const modalContent = modal.querySelector(".modal-content");
        const origHTML = modalContent.innerHTML;

        // Show loading state inside modal
        const loadingMsg = I18n.currentLang === "ta" ? "\u0BAA\u0BCD\u0BB0\u0BCA\u0BAA\u0BC8\u0BB2\u0BCD \u0B8F\u0BB1\u0BCD\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1..." : "Loading profile...";
        modalContent.innerHTML = '<div class="switch-loading"><div class="loading-spinner"></div><p>' + loadingMsg + '</p></div>';

        const phone = this.user?.phone || Auth.phone;
        const lang = I18n.currentLang || "en";
        const result = await API.selectRole(phone, role, lang, ward, booth);

        if (result.error || !result.success) {
            modalContent.innerHTML = origHTML;
            this.showToast(result.detail || result.message || "Failed to switch ward");
            return;
        }

        // Close modal and restore its DOM structure for next use
        modal.style.display = "none";
        modalContent.innerHTML = '<h3>Switch Ward</h3><div id="switch-ward-roles" class="role-select-buttons"></div>';

        this.setUser(result.user);
        if (result.user.language) I18n.setLang(result.user.language);
        this.initForRole(result.user.role);
    },

    showToast(msg, duration = 3000) {
        const toast = document.getElementById("toast");
        toast.textContent = msg;
        toast.style.display = "block";
        setTimeout(() => { toast.style.display = "none"; }, duration);
    },

};

// PWA Service Worker registration
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.error("SW registration failed:", e));
}

// Start app
document.addEventListener("DOMContentLoaded", () => App.start());

