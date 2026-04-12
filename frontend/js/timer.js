const Timer = {
    deadlineMs: new Date("2026-04-21T17:00:00+05:30").getTime(),
    intervalId: null,

    start() {
        this.update();
        this.intervalId = setInterval(() => this.update(), 1000);
    },

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    },

    update() {
        const el = document.getElementById("countdown-timer");
        if (!el) return;

        const now = Date.now();
        const diff = this.deadlineMs - now;

        if (diff <= 0) {
            el.classList.add("expired");
            el.innerHTML = `<span class="cd-val">${I18n.t("deadline_passed")}</span>`;
            return;
        }

        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);

        el.innerHTML = `
            <div class="cd-unit"><span class="cd-val">${d}</span><span class="cd-label">${I18n.t("days")}</span></div>
            <span class="cd-sep">:</span>
            <div class="cd-unit"><span class="cd-val">${String(h).padStart(2,"0")}</span><span class="cd-label">${I18n.t("hours")}</span></div>
            <span class="cd-sep">:</span>
            <div class="cd-unit"><span class="cd-val">${String(m).padStart(2,"0")}</span><span class="cd-label">${I18n.t("minutes")}</span></div>
            <span class="cd-sep">:</span>
            <div class="cd-unit"><span class="cd-val">${String(s).padStart(2,"0")}</span><span class="cd-label">${I18n.t("seconds")}</span></div>
        `;
    },
};
