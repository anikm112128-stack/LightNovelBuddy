/* Runtime API configuration.
 *
 * No more editing script.js to point at a local backend.
 *
 * Resolution order (first match wins):
 *   1. ?api=https://example.com      — quick switch without touching files
 *   2. window.LNB_API                — legacy global, still honoured
 *   3. localStorage "lnb_api_base"   — set from the browser console, per browser
 *   4. config.local.js               — git-ignored file, loaded after this script
 *   5. DEPLOYED_API                  — the safe default
 *
 * Load before script.js and auth.js.
 */
(() => {
    const DEPLOYED_API = "https://lightnovelbuddy.onrender.com";
    const STORAGE_KEY = "lnb_api_base";

    function normalise(value) {
        if (typeof value !== "string") return null;
        const trimmed = value.trim().replace(/\/+$/, "");
        if (!trimmed) return null;
        try {
            const url = new URL(trimmed);
            if (url.protocol !== "http:" && url.protocol !== "https:") return null;
            return trimmed;
        } catch (error) {
            return null;
        }
    }

    function readStored() {
        try {
            return normalise(localStorage.getItem(STORAGE_KEY));
        } catch (error) {
            return null; // Storage can be blocked; fall through to the default.
        }
    }

    function fromQuery() {
        try {
            return normalise(new URLSearchParams(location.search).get("api"));
        } catch (error) {
            return null;
        }
    }

    const apiBase =
        fromQuery() ||
        normalise(window.LNB_API) ||
        readStored() ||
        DEPLOYED_API;

    window.LNB_CONFIG = {
        apiBase,
        deployedApi: DEPLOYED_API,
        /** Persist an override for this browser. Pass null/"" to clear it. */
        setApiBase(value) {
            if (value === null || value === undefined || value === "") {
                try {
                    localStorage.removeItem(STORAGE_KEY);
                } catch (error) {
                    return false;
                }
                return true;
            }
            const next = normalise(value);
            if (!next) return false; // Reject garbage instead of silently clearing.
            try {
                localStorage.setItem(STORAGE_KEY, next);
            } catch (error) {
                return false;
            }
            return true;
        },
        isLocalOverride: apiBase !== DEPLOYED_API
    };
})();
