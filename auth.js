/* Light Novel Buddy authentication and multi-novel management */

(() => {
    const API = (window.LNB_CONFIG && window.LNB_CONFIG.apiBase)
        || window.LNB_API
        || "https://lightnovelbuddy.onrender.com";
    "use strict";

    const API = "https://lightnovelbuddy.onrender.com";

    const TOKEN_KEY = "lnb_access_token";
    const NOVEL_KEY = "lnb_selected_novel";

    const $ = id => document.getElementById(id);

    // Keep login sessions across browser restarts.
    const token = () => localStorage.getItem(TOKEN_KEY);

    const selectedNovel = () => {
        const id = Number(localStorage.getItem(NOVEL_KEY));
        return Number.isInteger(id) && id > 0 ? id : null;
    };

    const authScreen = $("authScreen");
    const workspace = document.querySelector("#appRoot > .app");
    const loginForm = $("loginForm");

    let registerMode = false;

    function showMessage(message, isError = false) {
        const element = $("authMessage");
        if (!element) return;

        element.textContent = message;
        element.style.color = isError ? "#d45b5b" : "";
    }

    function showAuth() {
        if (authScreen) {
            authScreen.hidden = false;
            authScreen.style.display = "";
        }

        if (workspace) {
            workspace.hidden = true;
            workspace.style.display = "none";
        }
    }

    function showWorkspace() {
        if (authScreen) {
            authScreen.hidden = true;
            authScreen.style.display = "none";
        }

        if (workspace) {
            workspace.hidden = false;
            workspace.style.display = "";
        }
    }

    function setRegisterMode(enabled) {
        registerMode = enabled;

        const fields = $("registerFields");
        const loginPassword = $("authPassword");
        const registerPassword = $("registerPassword");
        const confirmPassword = $("confirmPassword");

        if (fields) fields.hidden = !enabled;

        if (loginPassword) {
            loginPassword.hidden = enabled;
            loginPassword.required = !enabled;
            loginPassword.value = "";
        }

        if (registerPassword) {
            registerPassword.required = enabled;
        }

        if (confirmPassword) {
            confirmPassword.required = enabled;
        }

        const loginButton = loginForm?.querySelector(
            'button[type="submit"]:not(#registerSubmit)'
        );

        if (loginButton) loginButton.hidden = enabled;
        if ($("registerSubmit")) $("registerSubmit").hidden = !enabled;
        if ($("showRegister")) $("showRegister").hidden = enabled;
        if ($("showLogin")) $("showLogin").hidden = !enabled;

        showMessage("");
    }

    async function apiRequest(path, options = {}) {
        const headers = new Headers(options.headers || {});

        if (token()) {
            headers.set("Authorization", `Bearer ${token()}`);
        }

        if (options.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        const response = await fetch(API + path, {
            ...options,
            headers
        });

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            const detail = body?.detail;

            const message = Array.isArray(detail)
                ? detail.map(item => item.msg || "Invalid input").join("; ")
                : detail || `Request failed (${response.status})`;

            const error = new Error(message);
            error.status = response.status;
            throw error;
        }

        return body;
    }

    async function loadNovels() {
        const novels = await apiRequest("/api/novels");
        const picker = $("novelPicker");

        if (!novels.length) {
            const created = await apiRequest("/api/novels", {
                method: "POST",
                body: JSON.stringify({ title: "My Novel" })
            });

            novels.push(created);
        }

        let currentId = selectedNovel();

        if (!novels.some(novel => Number(novel.id) === currentId)) {
            currentId = Number(novels[0].id);
            localStorage.setItem(NOVEL_KEY, String(currentId));
        }

        if (picker) {
            picker.replaceChildren();

            novels.forEach(novel => {
                const option = document.createElement("option");
                option.value = String(novel.id);
                option.textContent = novel.title;
                picker.appendChild(option);
            });

            picker.value = String(currentId);
        }

        return novels;
    }

    async function login(email, password) {
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

        localStorage.setItem(TOKEN_KEY, body.access_token);

        try {
            await apiRequest("/api/auth/me");
            await loadNovels();

            showWorkspace();

            if (typeof window.initialise === "function") {
                await window.initialise();
            }

            return body;

        } catch (error) {
            localStorage.removeItem(TOKEN_KEY);
            throw error;
        }
    }

    async function register(email, password) {
        await apiRequest("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({ email, password })
        });

        return login(email, password);
    }

    function logout() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(NOVEL_KEY);

        showAuth();
        setRegisterMode(false);

        if (loginForm) loginForm.reset();

        showMessage("You have signed out.");
    }

    async function createNovel(title) {
        const cleanTitle = String(title || "").trim();

        if (!cleanTitle) {
            alert("Please enter a novel title.");
            return;
        }

        const created = await apiRequest("/api/novels", {
            method: "POST",
            body: JSON.stringify({ title: cleanTitle })
        });

        localStorage.setItem(NOVEL_KEY, String(created.id));

        await loadNovels();
        window.location.reload();
    }

    function switchNovel(id) {
        const nextId = Number(id);

        if (!Number.isInteger(nextId) || nextId < 1) return;

        localStorage.setItem(NOVEL_KEY, String(nextId));
        window.location.reload();
    }

    window.lnbAuth = {
        token,
        selectedNovel,
        request: apiRequest,
        login,
        register,
        logout,
        loadNovels,
        createNovel,
        switchNovel
    };

    $("showRegister")?.addEventListener("click", () => {
        setRegisterMode(true);
    });

    $("showLogin")?.addEventListener("click", () => {
        setRegisterMode(false);
    });

    $("logoutButton")?.addEventListener("click", logout);

    $("novelPicker")?.addEventListener("change", event => {
        switchNovel(event.target.value);
    });

    $("newNovelButton")?.addEventListener("click", () => {
        const title = prompt("What would you like to call your new novel?");
        if (title === null) return;

        createNovel(title).catch(error => {
            alert("Could not create novel: " + error.message);
        });
    });

    loginForm?.addEventListener("submit", async event => {
        event.preventDefault();

        const email = $("authEmail").value.trim();

        const password = registerMode
            ? $("registerPassword").value
            : $("authPassword").value;

        if (registerMode) {
            const confirmation = $("confirmPassword").value;

            if (password !== confirmation) {
                showMessage("Passwords do not match.", true);
                return;
            }

            if (password.length < 10) {
                showMessage(
                    "Password must contain at least 10 characters.",
                    true
                );
                return;
            }
        }

        const submitButton = registerMode
            ? $("registerSubmit")
            : loginForm.querySelector(
                'button[type="submit"]:not(#registerSubmit)'
            );

        if (submitButton) submitButton.disabled = true;

        showMessage(
            registerMode
                ? "Creating your account..."
                : "Signing in..."
        );

        try {
            if (registerMode) {
                await register(email, password);
            } else {
                await login(email, password);
            }

            showMessage("");

        } catch (error) {
            showMessage(error.message, true);

        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });

    async function start() {
        setRegisterMode(false);

        if (!token()) {
            showAuth();
            return;
        }

        try {
            await apiRequest("/api/auth/me");
            await loadNovels();

            showWorkspace();

            if (typeof window.initialise === "function") {
                await window.initialise();
            }

        } catch (error) {
            localStorage.removeItem(TOKEN_KEY);

            showAuth();

            showMessage(
                "Your session has expired. Please sign in again.",
                true
            );
        }
    }

    start();

})();
