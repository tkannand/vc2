const API = {
    _skipExpiredHandler: false,

    async request(method, url, body = null, timeoutMs = 60000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const opts = {
            method,
            headers: { "Content-Type": "application/json", "X-Requested-With": "Connect" },
            credentials: "same-origin",
            signal: controller.signal,
        };
        if (body) opts.body = JSON.stringify(body);

        try {
            const res = await fetch(url, opts);
            clearTimeout(timer);
            if (res.status === 401) {
                if (!this._skipExpiredHandler && App.user) {
                    App.handleSessionExpired();
                }
                return { error: true, detail: "Not authenticated" };
            }
            if (res.status === 403) {
                const data = await res.json().catch(() => ({}));
                const detail = data.detail || "";
                if (detail === "app_access_disabled") {
                    App.handleSessionExpired();
                } else if (detail === "telecalling_disabled") {
                    App.clearUser();
                    App.showAuthFlow();
                    App.showToast(I18n.t("telecalling_disabled"));
                } else if (detail === "account_disabled") {
                    App.clearUser();
                    App.showAuthFlow();
                    App.showToast("Account disabled. Contact your administrator.");
                } else if (detail === "outside_allowed_hours") {
                    App.clearUser();
                    App.showAuthFlow();
                    App.showToast("Login not allowed at this time. Contact your administrator.");
                }
                return { error: true, detail };
            }
            if (res.status === 429) {
                App.showToast("Too many requests. Please wait.");
                return { error: true, detail: "Rate limited" };
            }
            let data;
            try {
                data = await res.json();
            } catch {
                // Non-JSON response (e.g. 500 "Internal Server Error" plain text)
                return { error: true, detail: res.status >= 500 ? "Server error" : "Request failed" };
            }
            if (res.status >= 400) {
                return { error: true, detail: data.detail || "Request failed" };
            }
            return data;
        } catch (e) {
            clearTimeout(timer);
            // fetch() threw or was aborted (timeout) — treat as network failure
            return { error: true, detail: "Network error" };
        }
    },

    get(url) { return this.request("GET", url); },
    post(url, body) { return this.request("POST", url, body); },
    del(url) { return this.request("DELETE", url); },

    // Auth - PIN based
    checkUser(phone) { return this.post("/api/auth/check-user", { phone }); },
    setupPin(phone, pin, pinConfirm, language) { return this.post("/api/auth/setup-pin", { phone, pin, pin_confirm: pinConfirm, language }); },
    loginPin(phone, pin, language) { return this.post("/api/auth/login-pin", { phone, pin, language }); },
    forgotPinRequestOTP(phone) { return this.post("/api/auth/forgot-pin/request-otp", { phone }); },
    forgotPinReset(phone, otp, newPin, newPinConfirm, language) {
        return this.post("/api/auth/forgot-pin/reset", { phone, otp, new_pin: newPin, new_pin_confirm: newPinConfirm, language });
    },
    selectRole(phone, role, language) { return this.post("/api/auth/select-role", { phone, role, language }); },
    logout() { return this.post("/api/auth/logout"); },
    async getMe() {
        this._skipExpiredHandler = true;
        const result = await this.get("/api/auth/me");
        this._skipExpiredHandler = false;
        return result;
    },
    getTranslations(lang) { return this.get(`/api/translations?lang=${lang}`); },

    // Booth
    getStreets(ward, booth) { return this.get(`/api/booth/streets?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getFamilies(ward, booth, street, tab) {
        let url = `/api/booth/families?ward=${enc(ward)}&booth=${enc(booth)}&tab=${enc(tab)}`;
        if (street) url += `&street=${enc(street)}`;
        return this.get(url);
    },
    revealPhone(ward, booth, voterId) {
        return this.post(`/api/booth/voter/${enc(voterId)}/reveal-phone?ward=${enc(ward)}&booth=${enc(booth)}`);
    },
    updateStatus(ward, booth, voterId, status, notes) {
        return this.post(`/api/booth/voter/${enc(voterId)}/status?ward=${enc(ward)}&booth=${enc(booth)}`, { status, notes });
    },
    getBoothStats(ward, booth) { return this.get(`/api/booth/stats?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getBoothPendingStatus(ward, booth) { return this.get(`/api/booth/pending-status?ward=${enc(ward)}&booth=${enc(booth)}`); },

    // Ward
    getWardBooths(ward) { return this.get(`/api/ward/booths?ward=${enc(ward)}`); },
    getWardStats(ward) { return this.get(`/api/ward/stats?ward=${enc(ward)}`); },
    getWardBoothStreets(ward, booth) { return this.get(`/api/ward/booth-streets?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getWardBoothFamilies(ward, booth, street, tab) {
        let url = `/api/ward/booth-families?ward=${enc(ward)}&booth=${enc(booth)}&tab=${enc(tab)}`;
        if (street) url += `&street=${enc(street)}`;
        return this.get(url);
    },
    wardRevealPhone(ward, booth, voterId) {
        return this.post(`/api/ward/booth-voter/${enc(voterId)}/reveal-phone?ward=${enc(ward)}&booth=${enc(booth)}`);
    },
    wardUpdateStatus(ward, booth, voterId, status, notes) {
        return this.post(`/api/ward/booth-voter/${enc(voterId)}/status?ward=${enc(ward)}&booth=${enc(booth)}`, { status, notes });
    },
    getWardPendingStatus(ward, booth) { return this.get(`/api/ward/pending-status?ward=${enc(ward)}&booth=${enc(booth)}`); },

    // Telecaller
    getTelecallerPendingStatus(ward) { return this.get(`/api/telecaller/pending-status?ward=${enc(ward)}`); },
    getTelecallerBooths(ward) { return this.get(`/api/telecaller/booths?ward=${enc(ward)}`); },
    getTelecallerStreets(ward, booth) {
        let url = `/api/telecaller/streets?ward=${enc(ward)}`;
        if (booth) url += `&booth=${enc(booth)}`;
        return this.get(url);
    },
    getTelecallerFamilies(ward, booth, street, tab, schemeIds) {
        let url = `/api/telecaller/families?ward=${enc(ward)}&tab=${enc(tab || "not_called")}`;
        if (booth) url += `&booth=${enc(booth)}`;
        if (street) url += `&street=${enc(street)}`;
        const ids = Array.isArray(schemeIds) ? schemeIds.join(",") : (schemeIds || "");
        if (ids) url += `&scheme_ids=${enc(ids)}`;
        return this.get(url);
    },
    telecallerRevealPhone(ward, booth, voterId) {
        return this.post(`/api/ward/booth-voter/${enc(voterId)}/reveal-phone?ward=${enc(ward)}&booth=${enc(booth)}`);
    },
    telecallerUpdateStatus(ward, booth, voterId, status, notes) {
        return this.post(`/api/ward/booth-voter/${enc(voterId)}/status?ward=${enc(ward)}&booth=${enc(booth)}`, { status, notes });
    },

    // Admin
    getAdminUniverse() { return this.get("/api/admin/universe"); },
    getAdminSummary(ward, booth) {
        let url = "/api/admin/summary";
        const p = [];
        if (ward)  p.push(`ward=${enc(ward)}`);
        if (booth) p.push(`booth=${enc(booth)}`);
        if (p.length) url += "?" + p.join("&");
        // Global summary (no filter) scans all booths — allow up to 60 s
        return this.request("GET", url, null, ward ? 30000 : 60000);
    },
    getAdminDrill(ward, booth) {
        let url = `/api/admin/drill?ward=${enc(ward)}`;
        if (booth) url += `&booth=${enc(booth)}`;
        return this.request("GET", url, null, 30000);
    },
    getAdminFamilyStats(ward, booth) {
        const p = [];
        if (ward)  p.push(`ward=${enc(ward)}`);
        if (booth) p.push(`booth=${enc(booth)}`);
        const qs = p.length ? "?" + p.join("&") : "";
        return this.get(`/api/admin/family-stats${qs}`);
    },
    getAdminDashboard() { return this.get("/api/admin/dashboard"); },
    getAdminWardDetail(ward) { return this.get(`/api/admin/ward-detail?ward=${enc(ward)}`); },
    getAdminUsers() { return this.get("/api/admin/users"); },
    addUser(data) { return this.post("/api/admin/users", data); },
    updateUser(phone, data) { return this.request("PUT", `/api/admin/users/${enc(phone)}`, data); },
    removeUser(phone) { return this.del(`/api/admin/users/${enc(phone)}`); },
    getUserLocations() { return this.get("/api/admin/user-locations"); },
    getUserActivityStats() { return this.get("/api/admin/user-activity-stats"); },
    updateUserSettings(phone, data) { return this.request("PATCH", `/api/admin/users/${enc(phone)}/settings`, data); },
    getWards() { return this.get("/api/admin/wards"); },
    getWardBoothsList(ward) { return this.get(`/api/admin/ward-booths?ward=${enc(ward)}`); },
    getActivityLogs(dateFrom, dateTo, phone, action, limit) {
        let url = `/api/admin/activity-logs?limit=${limit || 200}`;
        if (dateFrom) url += `&date_from=${dateFrom}`;
        if (dateTo) url += `&date_to=${dateTo}`;
        if (phone) url += `&phone=${enc(phone)}`;
        if (action) url += `&action=${enc(action)}`;
        return this.get(url);
    },

    // Schemes
    getSchemes() { return this.get("/api/schemes"); },
    createScheme(name, type) { return this.post("/api/schemes", { name, type }); },
    getAdminAllSchemes() { return this.get("/api/schemes/admin/all"); },
    updateScheme(id, name, type) { return this.request("PUT", `/api/schemes/${enc(id)}`, { name, type }); },
    deleteScheme(id) { return this.del(`/api/schemes/${enc(id)}`); },
    getSchemeFamilies(sid, ward, booth)                  { return this.get(`/api/schemes/${enc(sid)}/families?ward=${enc(ward)}&booth=${enc(booth)}`); },
    deliverScheme(sid, ward, booth, ids)                 { return this.post(`/api/schemes/${enc(sid)}/deliver?ward=${enc(ward)}&booth=${enc(booth)}`,         { voter_ids: ids }); },
    undeliverScheme(sid, ward, booth, ids)               { return this.post(`/api/schemes/${enc(sid)}/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`,       { voter_ids: ids }); },
    getSchemeWardFamilies(sid, ward)                     { return this.get(`/api/schemes/${enc(sid)}/ward/families?ward=${enc(ward)}`); },
    wardDeliverScheme(sid, ward, booth, ids)             { return this.post(`/api/schemes/${enc(sid)}/ward/deliver?ward=${enc(ward)}&booth=${enc(booth)}`,    { voter_ids: ids }); },
    wardUndeliverScheme(sid, ward, booth, ids)           { return this.post(`/api/schemes/${enc(sid)}/ward/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`,  { voter_ids: ids }); },

    // Notice
    getNoticeEnabled() { return this.get("/api/notice/enabled"); },
    getNoticeStreets(ward, booth) { return this.get(`/api/notice/streets?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getNoticeVoters(ward, booth, street) {
        let url = `/api/notice/voters?ward=${enc(ward)}&booth=${enc(booth)}`;
        if (street) url += `&street=${enc(street)}`;
        return this.get(url);
    },
    deliverNotice(ward, booth, voterIds) {
        return this.post(`/api/notice/deliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds });
    },
    undeliverNotice(ward, booth, voterIds) {
        return this.post(`/api/notice/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds });
    },
    getNoticeStats(ward, booth) { return this.get(`/api/notice/stats?ward=${enc(ward)}&booth=${enc(booth)}`); },

    // Notice Ward
    getNoticeWardAllVoters(ward) { return this.get(`/api/notice/ward/all-voters?ward=${enc(ward)}`); },
    getNoticeWardBooths(ward) { return this.get(`/api/notice/ward/booths?ward=${enc(ward)}`); },
    getNoticeWardBoothStreets(ward, booth) { return this.get(`/api/notice/ward/booth-streets?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getNoticeWardBoothVoters(ward, booth, street) {
        let url = `/api/notice/ward/booth-voters?ward=${enc(ward)}&booth=${enc(booth)}`;
        if (street) url += `&street=${enc(street)}`;
        return this.get(url);
    },
    wardDeliverNotice(ward, booth, voterIds) {
        return this.post(`/api/notice/ward/deliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds });
    },
    wardUndeliverNotice(ward, booth, voterIds) {
        return this.post(`/api/notice/ward/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds });
    },
    getNoticeWardStats(ward) { return this.get(`/api/notice/ward/stats?ward=${enc(ward)}`); },

    // Coupon
    getCouponEnabled() { return this.get("/api/coupon/enabled"); },
    toggleCouponFeature(enabled) { return this.post("/api/coupon/admin/toggle", { enabled }); },
    toggleCustomScheme(schemeId, enabled) { return this.post(`/api/schemes/${enc(schemeId)}/toggle`, { enabled }); },
    getCouponFamilies(ward, booth) { return this.get(`/api/coupon/families?ward=${enc(ward)}&booth=${enc(booth)}`); },
    searchCouponVoters(q, ward, booth) {
        let url = `/api/coupon/search?q=${enc(q)}`;
        if (ward)  url += `&ward=${enc(ward)}`;
        if (booth) url += `&booth=${enc(booth)}`;
        return this.get(url);
    },
    createCouponFamily(ward, booth, voterIds, membersData) { return this.request("POST", "/api/coupon/families", { ward, booth, voter_ids: voterIds, members_data: membersData || [] }, 60000); },
    updateCouponFamily(ward, booth, famcode, voterIds, membersData) { return this.request("PUT", `/api/coupon/families/${enc(famcode)}`, { ward, booth, voter_ids: voterIds, members_data: membersData || [] }, 60000); },
    deleteCouponFamily(ward, booth, famcode) { return this.del(`/api/coupon/families/${enc(famcode)}?ward=${enc(ward)}&booth=${enc(booth)}`); },
    deliverCoupon(ward, booth, voterIds) { return this.post(`/api/coupon/deliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds }); },
    undeliverCoupon(ward, booth, voterIds) { return this.post(`/api/coupon/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds }); },
    getCouponBoothStats(ward, booth) { return this.get(`/api/coupon/stats?ward=${enc(ward)}&booth=${enc(booth)}`); },
    getCouponWardFamilies(ward, booth) {
        let url = `/api/coupon/ward/families?ward=${enc(ward)}`;
        if (booth) url += `&booth=${enc(booth)}`;
        return this.get(url);
    },
    wardDeliverCoupon(ward, booth, voterIds) { return this.post(`/api/coupon/ward/deliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds }); },
    wardUndeliverCoupon(ward, booth, voterIds) { return this.post(`/api/coupon/ward/undeliver?ward=${enc(ward)}&booth=${enc(booth)}`, { voter_ids: voterIds }); },
    getCouponWardStats(ward) { return this.get(`/api/coupon/ward/stats?ward=${enc(ward)}`); },
    getCouponAuditLog(ward, booth, byPhone) {
        let url = "/api/coupon/admin/audit-log";
        const p = [];
        if (ward) p.push(`ward=${enc(ward)}`);
        if (booth) p.push(`booth=${enc(booth)}`);
        if (byPhone) p.push(`by_phone=${enc(byPhone)}`);
        if (p.length) url += "?" + p.join("&");
        return this.get(url);
    },
    undoCouponAction(logId, ward) { return this.post(`/api/coupon/admin/undo/${enc(logId)}?ward=${enc(ward)}`); },
    getCouponAdminStats(ward, booths) {
        let url = "/api/coupon/admin/stats";
        const p = [];
        if (ward) p.push(`ward=${enc(ward)}`);
        if (booths) p.push(`booths=${enc(booths)}`);
        if (p.length) url += "?" + p.join("&");
        return this.get(url);
    },

    // Notice Admin
    getNoticeAdminStats(ward, booths) {
        let url = "/api/notice/admin/stats";
        const params = [];
        if (ward) params.push(`ward=${enc(ward)}`);
        if (booths) params.push(`booths=${enc(booths)}`);
        if (params.length) url += "?" + params.join("&");
        return this.get(url);
    },
    toggleNoticeFeature(enabled) { return this.post("/api/notice/admin/toggle", { enabled }); },
    toggleAppAccess(enabled) { return this.post("/api/notice/admin/toggle-app-access", { enabled }); },
    toggleTelecalling(enabled) { return this.post("/api/notice/admin/toggle-telecalling", { enabled }); },
    getNoticeSettings() { return this.get("/api/notice/admin/settings"); },

    // Activity
    logActivity(action, screen, details, durationMs, voterId) {
        return this.post("/api/activity/log", { action, screen, details, duration_ms: durationMs, voter_id: voterId });
    },
    heartbeat(screen, durationMs, lat, lng) {
        const body = { screen, duration_ms: durationMs };
        if (lat != null && lng != null) { body.lat = lat; body.lng = lng; }
        return this.post("/api/activity/heartbeat", body);
    },
};

function enc(v) { return encodeURIComponent(v || ""); }
