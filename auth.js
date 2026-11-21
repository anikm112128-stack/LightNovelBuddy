
/* Authentication and novel selection helpers.
   Load after script.js. Existing API calls should use lnbRequest() or add
   Authorization in the existing request() helper as shown in INTEGRATION.md.
*/
(() => {
    const API = window.LNB_API || "https://lightnovelbuddy.onrender.com";
    const TOKEN_KEY = "lnb_access_token";
    const NOVEL_KEY = "lnb_selected_novel";

    const token = () => sessionStorage.getItem(TOKEN_KEY);
    const selectedNovel = () => Number(localStorage.getItem(NOVEL_KEY) || 1);

    window.lnbAuth = {
        token,
        selectedNovel,
        async request(path, options = {}) {
            const headers = new Headers(options.headers || {});
            if (token()) headers.set("Authorization", `Bearer ${token()}`);
            if (options.body && !headers.has("Content-Type")) {
                headers.set("Content-Type", "application/json");
            }

            const response = await fetch(API + path, { ...options, headers });
            const body = response.status === 204
                ? null
                : await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(body?.detail || `Request failed (${response.status})`);
            }
            return body;
        },

        async register(email, password) {
            return this.request("/api/auth/register", {
                method: "POST",
                body: JSON.stringify({ email, password })
            });
        },

        async login(email, password) {
            const form = new URLSearchParams({
                username: email,
                password
            });

            const response = await fetch(API + "/api/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: form
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.detail || "Login failed.");
            }

            sessionStorage.setItem(TOKEN_KEY, body.access_token);
            await this.loadNovels();
            return body;
        },

        logout() {
            sessionStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(NOVEL_KEY);
            location.reload();
        },

        async loadNovels() {
            const novels = await this.request("/api/novels");
            const picker = document.getElementById("novelPicker");

            if (!novels.length) {
                const created = await this.request("/api/novels", {
                    method: "POST",
                    body: JSON.stringify({ title: "My Novel" })
                });
                localStorage.setItem(NOVEL_KEY, created.id);
            } else if (!novels.some(n => n.id === selectedNovel())) {
                localStorage.setItem(NOVEL_KEY, novels[0].id);
            }

            if (picker) {
                picker.innerHTML = novels.map(n =>
                    `<option value="${Number(n.id)}">${escapeText(n.title)}</option>`
                ).join("");
                picker.value = String(selectedNovel());
            }

            return novels;
        },

        async createNovel(title) {
            const novel = await this.request("/api/novels", {
                method: "POST",
                body: JSON.stringify({ title })
            });

            localStorage.setItem(NOVEL_KEY, novel.id);
            await this.loadNovels();
            location.reload();
        },

        async switchNovel(id) {
            localStorage.setItem(NOVEL_KEY, String(Number(id)));
            location.reload();
        }
    };

    function escapeText(value) {
        return String(value).replace(/[&<>"']/g, c => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[c]));
    }
})();
