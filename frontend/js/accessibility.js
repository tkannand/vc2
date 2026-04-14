/* ============================================
   Accessibility - Font Size Toggle
   ============================================ */

const Accessibility = {
    STORAGE_KEY: "vc_font_size",
    levels: ["normal", "large", "xlarge"],
    classes: { large: "font-size-large", xlarge: "font-size-xlarge" },
    labels: { normal: "Normal", large: "Large", xlarge: "Extra Large" },
    badges: { normal: "1x", large: "1.2x", xlarge: "1.4x" },
    currentIndex: 0,

    init() {
        const saved = localStorage.getItem(this.STORAGE_KEY) || "normal";
        this.currentIndex = this.levels.indexOf(saved);
        if (this.currentIndex === -1) this.currentIndex = 0;

        this.updateBadge();

        const btn = document.getElementById("btn-font-size-toggle");
        if (btn) {
            btn.addEventListener("click", () => this.cycle());
        }
    },

    cycle() {
        this.currentIndex = (this.currentIndex + 1) % this.levels.length;
        const level = this.levels[this.currentIndex];

        document.documentElement.classList.remove(this.classes.large, this.classes.xlarge);
        if (this.classes[level]) {
            document.documentElement.classList.add(this.classes[level]);
        }

        localStorage.setItem(this.STORAGE_KEY, level);
        this.updateBadge();

        if (typeof App !== "undefined" && App.showToast) {
            App.showToast("Font size: " + this.labels[level], 1500);
        }
    },

    updateBadge() {
        const badge = document.querySelector(".font-size-badge");
        if (badge) {
            badge.textContent = this.badges[this.levels[this.currentIndex]];
        }
    }
};
