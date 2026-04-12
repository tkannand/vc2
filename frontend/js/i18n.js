const I18n = {
    currentLang: "en",
    translations: {},

    async init(lang) {
        this.currentLang = lang || "en";
        try {
            this.translations = await API.getTranslations(this.currentLang);
        } catch (e) {
            console.error("Failed to load translations:", e);
        }
        this.applyAll();
    },

    t(key) {
        return this.translations[key] || key;
    },

    applyAll() {
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            const key = el.getAttribute("data-i18n");
            const text = this.t(key);
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                el.placeholder = text;
            } else if (el.tagName === "OPTION") {
                el.textContent = text;
            } else {
                el.textContent = text;
            }
        });
    },

    setLang(lang) {
        this.currentLang = lang;
        localStorage.setItem("vc_lang", lang);
        return this.init(lang);
    },

    getSavedLang() {
        return localStorage.getItem("vc_lang") || "";
    },
};
