const Auth = {
    selectedLang: "en",
    phone: "",
    forgotPinOtp: "",

    init() {
        // Language selection
        document.querySelectorAll(".language-buttons .btn-lang").forEach((btn) => {
            btn.addEventListener("click", () => {
                this.selectedLang = btn.dataset.lang;
                I18n.setLang(this.selectedLang);
                App.showView("view-login");
            });
        });

        // Phone input
        const phoneInput = document.getElementById("input-phone");
        phoneInput.addEventListener("input", (e) => {
            e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
        });
        phoneInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this.checkUser();
        });

        // Continue button (was "Send OTP")
        document.getElementById("btn-continue").addEventListener("click", () => this.checkUser());

        // PIN login
        this.bindPinBoxes(".pin-box:not(.setup-pin):not(.setup-pin-confirm):not(.reset-pin):not(.reset-pin-confirm)", () => this.loginPin());
        document.getElementById("btn-login-pin").addEventListener("click", () => this.loginPin());
        document.getElementById("btn-forgot-pin").addEventListener("click", () => this.forgotPin());

        // PIN setup
        this.bindPinBoxes(".setup-pin", null, ".setup-pin-confirm");
        this.bindPinBoxes(".setup-pin-confirm", () => this.setupPin());
        document.getElementById("btn-setup-pin").addEventListener("click", () => this.setupPin());

        // OTP boxes (for forgot PIN)
        const otpBoxes = document.querySelectorAll(".otp-box");
        otpBoxes.forEach((box, i) => {
            box.addEventListener("input", (e) => {
                const val = e.target.value.replace(/\D/g, "");
                e.target.value = val.slice(0, 1);
                if (val && i < otpBoxes.length - 1) {
                    otpBoxes[i + 1].focus();
                }
                if (i === otpBoxes.length - 1 && val) {
                    this.verifyForgotOTP();
                }
            });
            box.addEventListener("keydown", (e) => {
                if (e.key === "Backspace" && !e.target.value && i > 0) {
                    otpBoxes[i - 1].focus();
                }
            });
            box.addEventListener("paste", (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 6);
                for (let j = 0; j < text.length && j < otpBoxes.length; j++) {
                    otpBoxes[j].value = text[j];
                }
                if (text.length === 6) this.verifyForgotOTP();
            });
        });
        document.getElementById("btn-verify-otp").addEventListener("click", () => this.verifyForgotOTP());
        document.getElementById("btn-resend-otp").addEventListener("click", () => this.forgotPin());

        // Reset PIN
        this.bindPinBoxes(".reset-pin", null, ".reset-pin-confirm");
        this.bindPinBoxes(".reset-pin-confirm", () => this.resetPin());
        document.getElementById("btn-reset-pin").addEventListener("click", () => this.resetPin());

        // Logout
        document.getElementById("btn-logout").addEventListener("click", () => this.logout());

        // Language toggle
        document.getElementById("btn-lang-toggle").addEventListener("click", async () => {
            const newLang = I18n.currentLang === "en" ? "ta" : "en";
            await I18n.setLang(newLang);
            App.updateLangButton();
            if (App.user) {
                App.reloadCurrentView();
            }
        });
    },

    bindPinBoxes(selector, onComplete, nextGroupSelector) {
        const boxes = document.querySelectorAll(selector);
        boxes.forEach((box, i) => {
            box.addEventListener("input", (e) => {
                const val = e.target.value.replace(/\D/g, "");
                e.target.value = val.slice(0, 1);
                if (val && i < boxes.length - 1) {
                    boxes[i + 1].focus();
                } else if (val && i === boxes.length - 1) {
                    if (nextGroupSelector) {
                        const nextGroup = document.querySelectorAll(nextGroupSelector);
                        if (nextGroup.length > 0) nextGroup[0].focus();
                    } else if (onComplete) {
                        onComplete();
                    }
                }
            });
            box.addEventListener("keydown", (e) => {
                if (e.key === "Backspace" && !e.target.value && i > 0) {
                    boxes[i - 1].focus();
                }
            });
            box.addEventListener("paste", (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 4);
                for (let j = 0; j < text.length && j < boxes.length; j++) {
                    boxes[j].value = text[j];
                }
                if (text.length === 4 && onComplete && !nextGroupSelector) onComplete();
            });
        });
    },

    getPinValue(selector) {
        return Array.from(document.querySelectorAll(selector)).map((b) => b.value).join("");
    },

    clearPinBoxes(selector) {
        document.querySelectorAll(selector).forEach((b) => (b.value = ""));
    },

    hideAllSteps() {
        document.getElementById("login-step-phone").style.display = "none";
        document.getElementById("login-step-pin").style.display = "none";
        document.getElementById("login-step-setup-pin").style.display = "none";
        document.getElementById("login-step-otp").style.display = "none";
        document.getElementById("login-step-reset-pin").style.display = "none";
        document.getElementById("login-step-role").style.display = "none";
    },

    showStep(stepId) {
        this.hideAllSteps();
        document.getElementById(stepId).style.display = "block";
    },

    // Step 1: Check if user is registered and has PIN
    async checkUser() {
        const phone = document.getElementById("input-phone").value.trim();
        if (phone.length !== 10) {
            this.showError("phone", I18n.t("enter_phone"));
            return;
        }

        this.phone = phone;
        const btn = document.getElementById("btn-continue");
        App.setBtnLoading(btn, true);

        const result = await API.checkUser(phone);
        App.setBtnLoading(btn, false);

        if (result.error) {
            this.showError("phone", result.detail || "Network error");
            return;
        }

        if (!result.registered) {
            this.showError("phone", I18n.t("user_not_found"));
            return;
        }

        if (result.has_pin) {
            // Returning user - enter PIN
            this.showStep("login-step-pin");
            this.clearPinBoxes(".pin-box:not(.setup-pin):not(.setup-pin-confirm):not(.reset-pin):not(.reset-pin-confirm)");
            document.querySelector("#login-step-pin .pin-box").focus();
        } else {
            // First time - setup PIN
            this.showStep("login-step-setup-pin");
            this.clearPinBoxes(".setup-pin");
            this.clearPinBoxes(".setup-pin-confirm");
            document.querySelector(".setup-pin").focus();
        }
    },

    // Step 2a: Login with PIN
    async loginPin() {
        const pin = this.getPinValue("#login-step-pin .pin-box");
        if (pin.length !== 4) {
            this.showError("pin", I18n.t("enter_pin"));
            return;
        }

        const btn = document.getElementById("btn-login-pin");
        App.setBtnLoading(btn, true);

        const result = await API.loginPin(this.phone, pin, this.selectedLang);
        App.setBtnLoading(btn, false);

        if (result.error || !result.success) {
            if (result.message === "pin_locked") {
                this.showError("pin", I18n.t("pin_locked"));
            } else if (result.message === "app_access_disabled") {
                this.showError("pin", I18n.t("app_access_disabled_login"));
            } else if (result.message === "account_disabled") {
                this.showError("pin", "Account disabled. Contact your administrator.");
            } else if (result.message === "outside_allowed_hours") {
                this.showError("pin", "Login not allowed at this time. Contact your administrator.");
            } else if (result.message === "invalid_pin") {
                const remaining = result.attempts_remaining;
                const msg = remaining !== undefined
                    ? `${I18n.t("invalid_pin")} (${remaining} ${I18n.t("attempts_left")})`
                    : I18n.t("invalid_pin");
                this.showError("pin", msg);
            } else {
                this.showError("pin", result.detail || result.message || I18n.t("invalid_pin"));
            }
            this.clearPinBoxes("#login-step-pin .pin-box");
            document.querySelector("#login-step-pin .pin-box").focus();
            return;
        }

        this.handleLoginSuccess(result);
    },

    // Step 2b: Setup PIN (first time)
    async setupPin() {
        const pin = this.getPinValue(".setup-pin");
        const pinConfirm = this.getPinValue(".setup-pin-confirm");

        if (pin.length !== 4) {
            this.showError("setup-pin", I18n.t("enter_pin"));
            return;
        }
        if (pinConfirm.length !== 4) {
            this.showError("setup-pin", I18n.t("confirm_pin_required"));
            return;
        }
        if (pin !== pinConfirm) {
            this.showError("setup-pin", I18n.t("pins_dont_match"));
            this.clearPinBoxes(".setup-pin-confirm");
            document.querySelector(".setup-pin-confirm").focus();
            return;
        }

        const btn = document.getElementById("btn-setup-pin");
        App.setBtnLoading(btn, true);

        const result = await API.setupPin(this.phone, pin, pinConfirm, this.selectedLang);
        App.setBtnLoading(btn, false);

        if (result.error || !result.success) {
            const msg = result.message === "account_disabled"
                ? "Account disabled. Contact your administrator."
                : result.message === "outside_allowed_hours"
                ? "Login not allowed at this time. Contact your administrator."
                : (result.detail || result.message || "Failed to set PIN");
            this.showError("setup-pin", msg);
            return;
        }

        this.handleLoginSuccess(result);
    },

    // Forgot PIN - send OTP
    async forgotPin() {
        this.showError("pin", "");
        const btn = document.getElementById("btn-forgot-pin");
        if (btn) App.setBtnLoading(btn, true);

        const result = await API.forgotPinRequestOTP(this.phone);
        if (btn) App.setBtnLoading(btn, false);

        if (result.error || !result.success) {
            this.showError("pin", result.detail || result.message || "Failed to send OTP");
            return;
        }

        this.showStep("login-step-otp");
        document.querySelectorAll(".otp-box").forEach((b) => (b.value = ""));
        document.querySelector(".otp-box").focus();
        this.startResendTimer();
    },

    // Verify OTP (stores it, then shows reset PIN screen)
    verifyForgotOTP() {
        const otpBoxes = document.querySelectorAll(".otp-box");
        const otp = Array.from(otpBoxes).map((b) => b.value).join("");
        if (otp.length !== 6) {
            this.showError("otp", I18n.t("enter_otp"));
            return;
        }

        // Store OTP and move to reset PIN screen
        this.forgotPinOtp = otp;
        this.showStep("login-step-reset-pin");
        this.clearPinBoxes(".reset-pin");
        this.clearPinBoxes(".reset-pin-confirm");
        document.querySelector(".reset-pin").focus();
    },

    // Reset PIN (after OTP verified)
    async resetPin() {
        const newPin = this.getPinValue(".reset-pin");
        const newPinConfirm = this.getPinValue(".reset-pin-confirm");

        if (newPin.length !== 4) {
            this.showError("reset-pin", I18n.t("enter_pin"));
            return;
        }
        if (newPinConfirm.length !== 4) {
            this.showError("reset-pin", I18n.t("confirm_pin_required"));
            return;
        }
        if (newPin !== newPinConfirm) {
            this.showError("reset-pin", I18n.t("pins_dont_match"));
            this.clearPinBoxes(".reset-pin-confirm");
            document.querySelector(".reset-pin-confirm").focus();
            return;
        }

        const btn = document.getElementById("btn-reset-pin");
        App.setBtnLoading(btn, true);

        const result = await API.forgotPinReset(this.phone, this.forgotPinOtp, newPin, newPinConfirm, this.selectedLang);
        App.setBtnLoading(btn, false);

        if (result.error || !result.success) {
            if (result.message && (result.message.includes("OTP") || result.message.includes("expired"))) {
                // OTP was invalid - go back to OTP step
                this.showStep("login-step-otp");
                document.querySelectorAll(".otp-box").forEach((b) => (b.value = ""));
                this.showError("otp", result.message || I18n.t("invalid_otp"));
                return;
            }
            this.showError("reset-pin", result.detail || result.message || "Failed to reset PIN");
            return;
        }

        this.handleLoginSuccess(result);
    },

    handleLoginSuccess(result) {
        // Multi-role: show role picker
        if (result.multi_role && result.roles) {
            this.showRolePicker(result.roles);
            return;
        }

        App.setUser(result.user);
        I18n.setLang(result.user.language || this.selectedLang);
        App.initForRole(result.user.role);
    },

    showRolePicker(roles) {
        this.showStep("login-step-role");

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

        const container = document.getElementById("role-buttons");
        container.innerHTML = roles.map((r) => {
            const detail = r.ward ? (r.booth ? `${r.ward} / ${r.booth}` : r.ward) : "";
            const escWard = (r.ward || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            const escBooth = (r.booth || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            return `
                <button class="role-select-btn" data-role="${r.role}" data-ward="${escWard}" data-booth="${escBooth}">
                    <div class="role-icon ${r.role}">${roleIcons[r.role] || ""}</div>
                    <div class="role-text">
                        <div class="role-label">${roleLabels[r.role] || r.role}</div>
                        ${detail ? `<div class="role-detail">${detail}</div>` : ""}
                    </div>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
            `;
        }).join("");

        container.querySelectorAll(".role-select-btn").forEach((btn) => {
            btn.addEventListener("click", () => this.selectRole(btn.dataset.role, btn.dataset.ward, btn.dataset.booth));
        });
    },

    async selectRole(role, ward, booth) {
        const btns = document.querySelectorAll(".role-select-btn");
        btns.forEach((b) => (b.disabled = true));

        const result = await API.selectRole(this.phone, role, this.selectedLang, ward, booth);

        if (result.error || !result.success) {
            const msg = result.message === "app_access_disabled"
                ? I18n.t("app_access_disabled_login")
                : result.message === "telecalling_disabled"
                ? I18n.t("telecalling_disabled")
                : result.message === "account_disabled"
                ? "Account disabled. Contact your administrator."
                : result.message === "outside_allowed_hours"
                ? "Login not allowed at this time. Contact your administrator."
                : (result.detail || result.message || "Failed to select role");
            this.showError("role", msg);
            btns.forEach((b) => (b.disabled = false));
            return;
        }

        this.handleLoginSuccess(result);
    },

    async logout() {
        await API.logout();
        App.clearUser();
        this.resetForm();
        App.showAuthFlow();
    },

    resetForm() {
        document.getElementById("input-phone").value = "";
        this.clearPinBoxes(".pin-box");
        document.querySelectorAll(".otp-box").forEach((b) => (b.value = ""));
        this.showStep("login-step-phone");
        this.showError("phone", "");
        this.showError("pin", "");
        this.showError("setup-pin", "");
        this.showError("otp", "");
        this.showError("reset-pin", "");
        this.showError("role", "");
        this.forgotPinOtp = "";
    },

    showError(step, msg) {
        const el = document.getElementById(`login-error-${step}`);
        if (el) el.textContent = msg || "";
    },

    startResendTimer() {
        const btn = document.getElementById("btn-resend-otp");
        btn.disabled = true;
        let sec = 60;
        const iv = setInterval(() => {
            sec--;
            btn.textContent = `${I18n.t("resend_otp")} (${sec}s)`;
            if (sec <= 0) {
                clearInterval(iv);
                btn.disabled = false;
                btn.textContent = I18n.t("resend_otp");
            }
        }, 1000);
    },
};
