/* Resolved by config.js (load order: config.js -> script.js -> auth.js). */
const API = (window.LNB_CONFIG && window.LNB_CONFIG.apiBase)
    || window.LNB_API
    || "https://lightnovelbuddy.onrender.com";

const $ = (id) => document.getElementById(id);

let editingChapterId = null;

const AUTH_TOKEN_KEY = "lnb_access_token";
const SELECTED_NOVEL_KEY = "lnb_selected_novel";

function getAccessToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
}

function getSelectedNovelId() {
    const id = Number(localStorage.getItem(SELECTED_NOVEL_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
}

function createRequestKey() {
    return (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function formatErrorDetail(result, status) {
    if (typeof result?.detail === "string" && result.detail.trim()) {
        return result.detail.trim();
    }

    if (Array.isArray(result?.detail) && result.detail.length) {
        return result.detail.map(item => {
            const msg = String(item?.msg || "Invalid input")
                .replace(/^Value error,\s*/i, "").trim();

            const loc = Array.isArray(item?.loc)
                ? item.loc.filter(p => !["body", "path", "header"].includes(p)).join(".")
                : "";

            return loc && !msg.toLowerCase().includes(loc.replace(/_/g, " ").toLowerCase())
                ? `${loc}: ${msg}`
                : msg;
        }).join("; ");
    }

    if (status >= 502 && status <= 504) {
        return `Server is temporarily unavailable (${status}). Please try again.`;
    }

    return "Server returned " + status;
}

async function request(path, method = "GET", data = null, { idempotencyKey = null } = {}) {
    const headers = {};
    const token = getAccessToken();

    const isPublicRoute =
        path === "/" ||
        path === "/api/health" ||
        path === "/api/auth/login" ||
        path === "/api/auth/register";

    const isNovelManagementRoute = path.startsWith("/api/novels");

    if (token && !isPublicRoute) {
        headers.Authorization = `Bearer ${token}`;
    }

    if (idempotencyKey) {
        headers["Idempotency-Key"] = idempotencyKey;
    }

    let requestPath = path;
    let requestData = data;

    const novelId = getSelectedNovelId();

    if (
        !isPublicRoute &&
        !isNovelManagementRoute &&
        !path.startsWith("/api/auth/") &&
        novelId
    ) {
        if (
            method === "GET" &&
            !/[?&]novel_id=/.test(requestPath) &&
            !/^\/api\/(chapters|memories|characters)\/\d+$/.test(requestPath)
        ) {
            requestPath += (requestPath.includes("?") ? "&" : "?")
                + `novel_id=${novelId}`;
        } else if (
            requestData &&
            typeof requestData === "object" &&
            !Array.isArray(requestData)
        ) {
            requestData = { ...requestData, novel_id: novelId };
        }
    }

    const timeoutMs = path.startsWith("/api/ai/") ? 60000 : 15000;
    const canRetry =
        method === "GET" ||
        method === "PUT" ||
        method === "DELETE" ||
        Boolean(idempotencyKey);

    const maxAttempts = canRetry ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetch(API + requestPath, {
                method,
                headers: {
                    ...headers,
                    ...(requestData ? { "Content-Type": "application/json" } : {})
                },
                body: requestData ? JSON.stringify(requestData) : undefined,
                signal: controller.signal
            });

            clearTimeout(timer);

            let result = {};

            try {
                result = await response.json();
            } catch (e) {}

            if (!response.ok) {
                const err = new Error(
                    formatErrorDetail(result, response.status)
                );

                err.status = response.status;

                if (response.status === 401 && token) {
                    localStorage.removeItem(AUTH_TOKEN_KEY);
                }

                throw err;
            }

            if ($("backendStatus")) {
                setBackendStatus("● Backend connected", true);
            }

            return result;

        } catch (err) {
            clearTimeout(timer);

            if (err && err.status) throw err;

            if (timedOut) {
                throw new Error(
                    "Request timed out. Please check your connection and try again."
                );
            }

            const offline = navigator.onLine === false;

            if (!offline && attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 200));
                continue;
            }

            if ($("backendStatus")) {
                setBackendStatus(
                    offline ? "○ Offline" : "○ Backend unavailable",
                    false
                );
            }

            throw new Error(
                offline
                    ? "You appear to be offline. Check your connection and try again."
                    : "Network error — could not reach the server. Please try again."
            );
        }
    }
}

function renderListError(containerId, label, error, onRetry) {
    const el = $(containerId);
    el.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error-state";
    box.setAttribute("role", "alert");
    const text = document.createElement("p");
    text.textContent = `${label}: ${error.message}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.textContent = "Try again";
    btn.addEventListener("click", onRetry);
    box.append(text, btn);
    el.appendChild(box);
}

// NOTIFICATIONS AND UTILITIES

function toast(message) {
    const t = $("toast");

    t.textContent = message;
    t.style.display = "block";

    clearTimeout(window.toastTimer);

    window.toastTimer = setTimeout(() => {
        t.style.display = "none";
    }, 3000);
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

function wordCount(text) {
    return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function formatNumber(value) {
    return Number(value ?? 0).toLocaleString();
}

/** Save text as a file, falling back to a new tab when downloads are blocked. */
function downloadTextFile(filename, text, mime = "text/markdown;charset=utf-8") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a moment to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function safeFilename(value) {
    const cleaned = String(value ?? "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    return cleaned || "light-novel-buddy";
}

// WORD-COUNT GOAL

const GOAL_KEY = "lightNovelBuddy.wordGoal.v1";
let currentWords = 0;

function readGoal() {
    try {
        const raw = Number(localStorage.getItem(GOAL_KEY));
        return Number.isFinite(raw) && raw >= 100 && raw <= 1000000 ? Math.floor(raw) : null;
    } catch (error) {
        return null;
    }
}

function renderGoal() {
    const goal = readGoal();
    const bar = $("goalBar");
    const fill = $("goalBarFill");
    const label = $("goalLabel");
    if (!bar || !fill || !label) return;

    $("saveGoalButton").textContent = goal ? "Update goal" : "Set goal";
    $("clearGoalButton").hidden = !goal;

    if (!goal) {
        bar.setAttribute("aria-valuenow", "0");
        fill.style.width = "0%";
        label.textContent = "No goal set yet. " + formatNumber(currentWords) + " words written so far.";
        $("goalStatus").textContent = "Set a goal and watch the bar fill as you write.";
        return;
    }

    const percent = Math.min(100, Math.round((currentWords / goal) * 100));
    bar.setAttribute("aria-valuenow", String(percent));
    fill.style.width = percent + "%";
    fill.classList.toggle("complete", currentWords >= goal);

    const remaining = Math.max(0, goal - currentWords);
    label.textContent = formatNumber(currentWords) + " of " + formatNumber(goal) + " words (" + percent + "%).";
    $("goalStatus").textContent = currentWords >= goal
        ? "Goal reached — " + formatNumber(currentWords) + " words written."
        : formatNumber(remaining) + " words to go.";
    $("goalInput").value = String(goal);
}

function saveGoal() {
    const input = $("goalInput");
    const goal = Math.floor(Number(input.value));
    if (!Number.isFinite(goal) || goal < 100 || goal > 1000000) {
        toast("Enter a goal between 100 and 1,000,000 words.");
        return;
    }
    try {
        localStorage.setItem(GOAL_KEY, String(goal));
    } catch (error) {
        toast("Could not save the goal in this browser.");
        return;
    }
    renderGoal();
    toast("Word goal set to " + formatNumber(goal) + " words.");
}

function clearGoal() {
    try {
        localStorage.removeItem(GOAL_KEY);
    } catch (error) {
        // Nothing persisted, so there is nothing to clear.
    }
    $("goalInput").value = "";
    renderGoal();
    toast("Word goal cleared.");
}

// PAGE NAVIGATION

function setMobileMenu(open) {
    $("sidebarMenu").classList.toggle("menu-open", open);
    $("mobileMenuToggle").setAttribute("aria-expanded", String(open));
}
$("mobileMenuToggle").addEventListener("click", () => {
    setMobileMenu($("mobileMenuToggle").getAttribute("aria-expanded") !== "true");
});

function navigate(page) {
    const menuWasOpen = $("mobileMenuToggle").getAttribute("aria-expanded") === "true";
    document.querySelectorAll(".page").forEach(p => {
        p.classList.remove("active");
    });

    $(page).classList.add("active");

    document.querySelectorAll(".nav").forEach(b => {
        b.classList.toggle("active", b.dataset.page === page);
        if (b.dataset.page === page) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
    });

    const titles = {
        dashboard: "Welcome, Author.",
        editor: "Chapter Editor",
        memory: "World Building Memory",
        characters: "Character Library",
        grammar: "Grammar Assistant",
        consistency: "Consistency Checker",
        description: "Description Assistant",
        story: "Story Development",
        chekhov: "Chekhov's Gun Tracker",
        narrativeDNA: "Narrative DNA",
        relationships: "Character Relationship Web"
    };

    $("pageTitle").textContent = titles[page] || "Light Novel Buddy";
    setMobileMenu(false);
    if (menuWasOpen && window.matchMedia("(max-width: 760px)").matches) {
        $("pageTitle").focus({ preventScroll: true });
    }

    if (page === "dashboard") loadDashboard();
    if (page === "editor") loadChapters();
    if (page === "memory") loadMemories();
    if (page === "characters") loadCharacters();
    if (page === "chekhov") loadChekhov();
    if (page === "narrativeDNA") {
        $("dnaResult").innerHTML = "";
    }
    if (page === "relationships") loadRelationships();
}

document.querySelectorAll(".nav").forEach(b => {
    b.addEventListener("click", () => navigate(b.dataset.page));
});

// CHAPTER DRAFTS AND WORD COUNTER
//
// Drafts are stored per writing target ("new" or a chapter id) so two tabs on
// different chapters never share a slot. Each tab also stamps a writer id, which
// lets a tab notice that another tab changed the same draft.

const DRAFT_PREFIX = "lightNovelBuddy.draft.v2.";
const LEGACY_DRAFT_KEY = "lightNovelBuddy.chapterDraft.v1";
const TAB_ID = createRequestKey();

let chapterBaseline = { title: "", content: "" };
let chapterCreateKey = null;
let chapterSaving = false;
let chapterLoading = false;
let storageWarningShown = false;
let draftConflict = null;
// Marks where this tab's draft currently lives, so a chapter switch can tidy up.
let activeDraftSlot = "new";

function chapterValues() {
    return { title: $("chapterTitle").value, content: $("chapterText").value };
}

function chapterIsDirty() {
    const values = chapterValues();
    return values.title !== chapterBaseline.title || values.content !== chapterBaseline.content;
}

function draftSlotKey(chapterId) {
    return DRAFT_PREFIX + (chapterId === null ? "new" : String(chapterId));
}

function readDraft(slot) {
    try {
        const raw = localStorage.getItem(draftSlotKey(slot));
        if (!raw) return null;
        const draft = JSON.parse(raw);
        if (typeof draft.title !== "string" || typeof draft.content !== "string" ||
            !draft.baseline || typeof draft.baseline.title !== "string" || typeof draft.baseline.content !== "string") {
            return null;
        }
        return draft;
    } catch (error) {
        return null;
    }
}

function writeDraft(slot, payload) {
    try {
        localStorage.setItem(draftSlotKey(slot), JSON.stringify(payload));
        return true;
    } catch (error) {
        return false;
    }
}

function removeDraft(slot) {
    try {
        localStorage.removeItem(draftSlotKey(slot));
    } catch (error) {
        // Nothing to clean up if storage is unavailable.
    }
}

function warnBeforeUnload(event) {
    if (!chapterIsDirty()) return;
    event.preventDefault();
    event.returnValue = "";
}

function updateChapterDraft() {
    const values = chapterValues();
    $("wordCounter").textContent = values.content.trim().split(/\s+/).filter(Boolean).length + " words";
    const dirty = chapterIsDirty();
    if (dirty && editingChapterId === null && !chapterCreateKey) chapterCreateKey = createRequestKey();
    if (!dirty && editingChapterId === null) chapterCreateKey = null;
    window.removeEventListener("beforeunload", warnBeforeUnload);
    if (dirty) window.addEventListener("beforeunload", warnBeforeUnload);

    // The draft belongs to the chapter being edited; move it if that changed.
    const slot = editingChapterId === null ? "new" : editingChapterId;
    if (slot !== activeDraftSlot && !dirty) {
        removeDraft(activeDraftSlot);
        activeDraftSlot = slot;
    }

    if (!dirty) {
        removeDraft(slot);
        return;
    }

    const saved = writeDraft(slot, {
        chapterId: editingChapterId,
        baseline: chapterBaseline,
        createKey: chapterCreateKey,
        writer: TAB_ID,
        updatedAt: Date.now(),
        ...values
    });
    if (!saved && !storageWarningShown) {
        storageWarningShown = true;
        toast("Local draft storage is unavailable. Save your work before leaving.");
    }
    activeDraftSlot = slot;
}

function updateChapterEditControls(restored = false) {
    $("saveChapterButton").textContent = editingChapterId === null ? "Save chapter" : "Save changes";
    $("cancelEditButton").style.display = editingChapterId === null ? "none" : "inline-block";
    $("editStatus").textContent = editingChapterId === null
        ? "Recovered an unsaved draft from this browser."
        : (restored ? "Recovered unsaved changes. " : "") + "Editing: " + (chapterBaseline.title || "Untitled chapter") + ". Saving will update this chapter.";
    $("editStatus").style.display = (editingChapterId !== null || restored) ? "block" : "none";
}

function applyDraft(draft) {
    editingChapterId = draft.chapterId;
    chapterBaseline = draft.baseline;
    chapterCreateKey = draft.chapterId === null && typeof draft.createKey === "string" ? draft.createKey : null;
    $("chapterTitle").value = draft.title;
    $("chapterText").value = draft.content;
    activeDraftSlot = draft.chapterId === null ? "new" : draft.chapterId;
    updateChapterEditControls(true);
    updateChapterDraft();
}

/** Migrate the single shared v1 slot into the per-target v2 layout. */
function migrateLegacyDraft() {
    let raw;
    try {
        raw = localStorage.getItem(LEGACY_DRAFT_KEY);
    } catch (error) {
        return;
    }
    if (!raw) return;

    try {
        const draft = JSON.parse(raw);
        const valid = typeof draft.title === "string" && typeof draft.content === "string" &&
            draft.baseline && typeof draft.baseline.title === "string" && typeof draft.baseline.content === "string" &&
            (draft.chapterId === null || (Number.isInteger(draft.chapterId) && draft.chapterId > 0));
        if (valid && (draft.title !== draft.baseline.title || draft.content !== draft.baseline.content)) {
            const slot = draft.chapterId === null ? "new" : draft.chapterId;
            if (!readDraft(slot)) {
                writeDraft(slot, { ...draft, writer: TAB_ID, updatedAt: Date.now() });
            }
        }
    } catch (error) {
        // A corrupt legacy draft is dropped below either way.
    }
    try {
        localStorage.removeItem(LEGACY_DRAFT_KEY);
    } catch (error) {
        // Nothing else to do.
    }
}

function restoreChapterDraft() {
    migrateLegacyDraft();

    // Any dirty draft from this browser is recoverable; prefer the newest.
    let best = null;
    let bestSlot = "new";
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (typeof key !== "string" || !key.startsWith(DRAFT_PREFIX)) continue;
            const slot = key.slice(DRAFT_PREFIX.length);
            const draft = readDraft(slot);
            if (!draft) continue;
            if (draft.title === draft.baseline.title && draft.content === draft.baseline.content) {
                removeDraft(slot);
                continue;
            }
            if (!best || Number(draft.updatedAt || 0) > Number(best.updatedAt || 0)) {
                best = draft;
                bestSlot = slot;
            }
        }
    } catch (error) {
        return;
    }
    if (!best) return;
    best.chapterId = bestSlot === "new" ? null : Number(bestSlot);
    applyDraft(best);
}

// CROSS-TAB SYNCHRONISATION

function draftSlotOf(draft) {
    return draft && (draft.chapterId === null || draft.chapterId === undefined)
        ? "new"
        : String(draft.chapterId);
}

function showDraftConflict(draft) {
    const banner = $("draftConflict");
    if (!banner) return;
    const title = (draft.title || "").trim() || "Untitled chapter";
    banner.querySelector("[data-conflict-text]").textContent =
        "Another tab saved newer changes to this draft (" + title + "). Loading it will replace what is in this editor.";
    banner.hidden = false;
}

function clearDraftConflict() {
    draftConflict = null;
    const banner = $("draftConflict");
    if (banner) banner.hidden = true;
}

function loadConflictingDraft() {
    if (!draftConflict) return;
    const incoming = draftConflict;
    clearDraftConflict();
    if (chapterIsDirty() && !confirm("Replace your current unsaved text with the version from the other tab?")) return;
    applyDraft(incoming);
    toast("Loaded the draft from the other tab.");
}

function handleStorageEvent(event) {
    // localStorage writes in other tabs surface here; ignore our own writes.
    if (!event.key || !event.key.startsWith(DRAFT_PREFIX)) return;
    if (!event.newValue) return;

    let incoming;
    try {
        incoming = JSON.parse(event.newValue);
    } catch (error) {
        return;
    }
    if (!incoming || incoming.writer === TAB_ID) return;

    const sameSlot = draftSlotOf(incoming) === draftSlotOf({
        chapterId: editingChapterId
    });

    if (sameSlot) {
        // Only surface a conflict if this tab holds unsaved work of its own.
        if (!chapterIsDirty()) {
            applyDraft(incoming);
            toast("Draft updated from another tab.");
            return;
        }
        draftConflict = incoming;
        showDraftConflict(incoming);
        return;
    }

    toast("Another tab is writing a different chapter. Your draft here is untouched.");
}

window.addEventListener("storage", handleStorageEvent);

$("chapterTitle").addEventListener("input", updateChapterDraft);
$("chapterText").addEventListener("input", updateChapterDraft);
restoreChapterDraft();

// KEYBOARD SHORTCUTS
//
// The editor card carries a shortcut hint so the keys are discoverable.

function isTypingTarget(element) {
    if (!element) return false;
    const tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

function saveChapterFromKeyboard() {
    if ($("editor").classList.contains("active")) {
        saveChapter();
        return;
    }
    if (!chapterIsDirty()) {
        toast("Nothing to save — open the Chapter Editor to start writing.");
        return;
    }
    // The draft is already persisted to local storage, so switching pages is safe.
    navigate("editor");
    saveChapter();
}

/** Ctrl/Cmd + Enter runs the assistant for the page currently on screen. */
const PAGE_ASSISTANT = {
    grammar: { button: "runGrammarButton", run: () => runAI("grammar") },
    consistency: { button: "runConsistencyButton", run: () => runAI("consistency") },
    description: { button: "runDescriptionButton", run: () => runAI("enrich") },
    story: { button: "runStoryButton", run: () => runAI("story") },
    characters: { button: "runCharacterButton", run: runCharacterAnalysis }
};

function runAssistantFromKeyboard() {
    const page = document.querySelector(".page.active");
    const assistant = page && PAGE_ASSISTANT[page.id];
    if (!assistant) {
        toast("No assistant on this page. Open one from Writing Assistants first.");
        return;
    }
    const button = $(assistant.button);
    if (button && button.disabled) return;
    assistant.run();
}

document.addEventListener("keydown", event => {
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier || event.altKey) return;

    if (event.key === "Enter") {
        // The chapter viewer handles its own keys; do not fire an assistant behind it.
        if ($("chapterModal").classList.contains("open")) return;
        event.preventDefault();
        runAssistantFromKeyboard();
        return;
    }

    if (event.key.toLowerCase() === "s") {
        // Let the browser handle save-page inside a plain input that is not the editor,
        // but always take over for chapter writing.
        if (!$("editor").classList.contains("active") && isTypingTarget(event.target)
            && event.target !== $("chapterTitle") && event.target !== $("chapterText")) {
            return;
        }
        event.preventDefault();
        saveChapterFromKeyboard();
    }
});


function setBackendStatus(text, connected) {
    const el = $("backendStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.connected = connected ? "true" : "false";
}

/* Turn a failed request into an honest connection label.
 *
 * A 401/403 means the server answered and the session is simply missing, and a
 * 404 means it answered but this account has no novel yet. Neither is an
 * outage, so neither may be reported as one.
 */
function setBackendStatusFromError(error) {
    const status = error && error.status;

    if (status === 401 || status === 403 || (error && error.authRequired)) {
        setBackendStatus("○ Sign in to load your studio", false);
        return;
    }

    if (status === 404) {
        setBackendStatus("● Backend connected — no novel yet", true);
        return;
    }

    if (status) {
        // The server replied, so the connection itself is fine.
        setBackendStatus("● Backend connected", true);
        return;
    }

    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    setBackendStatus(offline ? "○ Offline" : "○ Backend unavailable", false);
}

async function loadDashboard() {
    // Every dashboard field comes from an owned novel, so there is nothing to
    // show without a session. Asking anyway would 401 and be misreported as an
    // outage.
    if (!getAccessToken()) {
        setBackendStatusFromError(Object.assign(new Error("signed out"), { authRequired: true }));
        return;
    }

    try {
        const d = await request("/api/dashboard");

        currentWords = Number(d.words ?? 0);
        $("chapterCount").textContent = d.chapters ?? 0;
        $("wordCount").textContent = formatNumber(d.words);
        $("characterCount").textContent = d.characters ?? 0;
        $("memoryCount").textContent = d.memories ?? 0;
        renderGoal();

        const chapters = await request("/api/chapters");

        $("recentChapters").innerHTML = chapters.length
            ? chapters.slice(0, 5).map(c => `
                <div class="item">
                    <strong>${escapeHTML(c.title)}</strong>
                    <span class="small">
                        ${(c.content || "").trim().split(/\s+/).filter(Boolean).length} words
                    </span>
                </div>
            `).join("")
            : '<div class="empty">Your first chapter is waiting to be written.</div>';

    } catch (e) {
        setBackendStatusFromError(e);
    }
}

// CHAPTER SAVING AND EDITING

async function saveChapter() {
    if (chapterSaving || chapterLoading) return;
    const snapshot = chapterValues();
    const title = snapshot.title.trim();
    if (!title) {
        toast("Please enter a chapter title.");
        return;
    }
    if (title.length > 300) {
        toast("Chapter title must be 300 characters or fewer.");
        return;
    }

    chapterSaving = true;
    $("saveChapterButton").disabled = true;
    const wasEditing = editingChapterId !== null;
    if (!wasEditing && !chapterCreateKey) chapterCreateKey = createRequestKey();
    try {
        const result = await request(
            wasEditing ? "/api/chapters/" + editingChapterId : "/api/chapters",
            wasEditing ? "PUT" : "POST",
            { title, content: snapshot.content },
            wasEditing ? {} : { idempotencyKey: chapterCreateKey }
        );
        chapterCreateKey = null;
        toast(wasEditing ? "Chapter updated successfully." : "Chapter saved successfully.");

        const current = chapterValues();
        if (current.title === snapshot.title && current.content === snapshot.content) {
            resetChapterEditor();
        } else {
            // Keep newer typing as an unsaved edit of the chapter just saved.
            if (!wasEditing) editingChapterId = result.id;
            chapterBaseline = { title, content: snapshot.content };
            updateChapterEditControls();
            updateChapterDraft();
            toast("Chapter saved. Newer changes are still in your local draft.");
        }
        loadChapters();
        loadDashboard();
    } catch (e) {
        if (wasEditing && e.status === 404) {
            editingChapterId = null;
            chapterBaseline = { title: "", content: "" };
            chapterCreateKey = createRequestKey();
            updateChapterEditControls();
            updateChapterDraft();
            loadChapters();
            loadDashboard();
            toast("Could not save chapter: Chapter no longer exists on server. Save again to create a new chapter.");
        } else {
            updateChapterDraft();
            toast("Could not save chapter: " + e.message);
        }
    } finally {
        chapterSaving = false;
        $("saveChapterButton").disabled = false;
    }
}

function resetChapterEditor() {
    editingChapterId = null;
    chapterBaseline = { title: "", content: "" };
    chapterCreateKey = null;
    $("chapterTitle").value = "";
    $("chapterText").value = "";
    updateChapterEditControls();
    updateChapterDraft();
}

function cancelChapterEdit() {
    if (chapterSaving || chapterLoading) return;
    if (chapterIsDirty() && !confirm("Discard your unsaved changes?")) return;
    resetChapterEditor();
    toast("Editing cancelled.");
}

async function editChapter(id) {
    if (chapterSaving || chapterLoading) return;
    if (editingChapterId === id) {
        navigate("editor");
        return;
    }
    if (chapterIsDirty() && !confirm("Replace your unsaved draft? Your unsaved changes will be discarded.")) return;
    chapterLoading = true;
    $("chapterTitle").readOnly = true;
    $("chapterText").readOnly = true;
    $("saveChapterButton").disabled = true;
    try {
        const c = await request("/api/chapters/" + id);
        editingChapterId = c.id;
        chapterBaseline = { title: c.title || "", content: c.content || "" };
        chapterCreateKey = null;
        $("chapterTitle").value = chapterBaseline.title;
        $("chapterText").value = chapterBaseline.content;
        updateChapterEditControls();
        updateChapterDraft();
        navigate("editor");
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
        if (e.status === 404) { loadChapters(); loadDashboard(); }
        toast("Could not open chapter: " + e.message);
    } finally {
        chapterLoading = false;
        $("chapterTitle").readOnly = false;
        $("chapterText").readOnly = false;
        $("saveChapterButton").disabled = false;
    }
}

// EXPORTS

function timestampForFilename() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

function chapterHeadings(chapters) {
    const numbered = chapters.length > 1 && chapters.every((c, i) => /^\s*(chapter|ch\.?)\s*\d+/i.test(c.title || ""));
    return chapters.map((c, i) => {
        const title = (c.title || "Untitled chapter").trim();
        return numbered ? title : "Chapter " + (i + 1) + ": " + title;
    });
}

async function exportManuscript() {
    const btn = $("exportManuscriptButton");
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
        const chapters = await request("/api/chapters");
        if (!chapters.length) {
            toast("There are no saved chapters to export yet.");
            return;
        }

        // The API returns newest first; a manuscript reads oldest first.
        const ordered = [...chapters].reverse();
        const headings = chapterHeadings(ordered);
        const totalWords = ordered.reduce((sum, c) => sum + wordCount(c.content), 0);

        const parts = [
            "# Light Novel Buddy manuscript",
            "",
            "_Exported " + new Date().toLocaleString() + " — " +
                ordered.length + " chapter" + (ordered.length === 1 ? "" : "s") + ", " +
                formatNumber(totalWords) + " words._"
        ];

        ordered.forEach((chapter, i) => {
            parts.push("", "---", "", "## " + headings[i], "");
            const body = (chapter.content || "").trim();
            parts.push(body || "_(This chapter is empty.)_");
        });

        downloadTextFile("manuscript-" + timestampForFilename() + ".md", parts.join("\n") + "\n");
        toast("Manuscript exported — " + ordered.length + " chapters.");
    } catch (e) {
        toast("Could not export the manuscript: " + e.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function exportStoryBible() {
    const btn = $("exportStoryBibleButton");
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
        const [memoriesData, charactersData, chapters] = await Promise.all([
            request("/api/memories"),
            request("/api/characters"),
            request("/api/chapters")
        ]);

        if (!memoriesData.length && !charactersData.length && !chapters.length) {
            toast("There is nothing to export yet.");
            return;
        }

        const parts = ["# Story bible", "", "_Exported " + new Date().toLocaleString() + "_"];

        parts.push("", "## World", "");
        if (memoriesData.length) {
            // Group by category so the export reads like a reference document.
            const byCategory = new Map();
            memoriesData.forEach(m => {
                const category = (m.category || "General").trim();
                if (!byCategory.has(category)) byCategory.set(category, []);
                byCategory.get(category).push(m);
            });
            for (const [category, entries] of byCategory) {
                parts.push("### " + category, "");
                entries.forEach(m => {
                    parts.push("**" + (m.name || "Untitled") + "**", "");
                    parts.push((m.description || "").trim() || "_(No description.)_", "");
                });
            }
        } else {
            parts.push("_No world entries saved._", "");
        }

        parts.push("## Characters", "");
        if (charactersData.length) {
            charactersData.forEach(c => {
                parts.push("### " + (c.name || "Unnamed character"), "");
                if ((c.personality || "").trim()) parts.push("*Personality:* " + c.personality.trim(), "");
                parts.push((c.description || "").trim() || "_(No details.)_", "");
            });
        } else {
            parts.push("_No characters saved._", "");
        }

        parts.push("## Chapter index", "");
        if (chapters.length) {
            const ordered = [...chapters].reverse();
            const headings = chapterHeadings(ordered);
            ordered.forEach((chapter, i) => {
                parts.push("- **" + headings[i] + "** — " + formatNumber(wordCount(chapter.content)) + " words");
            });
        } else {
            parts.push("_No chapters saved._");
        }

        downloadTextFile("story-bible-" + timestampForFilename() + ".md", parts.join("\n") + "\n");
        toast("Story bible exported.");
    } catch (e) {
        toast("Could not export the story bible: " + e.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// CHAPTER VIEWING

let chapterModalPreviousFocus = null;
let chapterModalId = null;

async function viewChapter(id) {
    try {
        const c = await request("/api/chapters/" + id);

        $("chapterModalTitle").textContent =
            c.title || "Untitled chapter";

        $("chapterModalContent").textContent =
            c.content || "(This chapter is empty.)";

        chapterModalId = c.id;
        chapterModalPreviousFocus = document.activeElement;
        if ($("appRoot")) $("appRoot").inert = true;
        $("chapterModal").classList.add("open");
        $("closeChapterModal").focus();

    } catch (e) {
        toast("Could not load chapter: " + e.message);
    }
}

function closeChapterView() {
    $("chapterModal").classList.remove("open");
    if ($("appRoot")) $("appRoot").inert = false;
    if (chapterModalPreviousFocus && chapterModalPreviousFocus.isConnected) chapterModalPreviousFocus.focus();
    chapterModalPreviousFocus = null;
    chapterModalId = null;
}

/** Jump from the read-only viewer straight into the editor for the same chapter. */
function editFromModal() {
    if (chapterModalId === null) return;
    const id = chapterModalId;
    closeChapterView();
    // closeChapterView restores focus to the row that opened the modal; moving on
    // to the editor afterwards keeps that restore harmless and predictable.
    editChapter(id);
}
document.addEventListener("keydown", event => {
    if ($("chapterModal").classList.contains("open")) {
        if (event.key === "Escape") { event.preventDefault(); closeChapterView(); return; }
        if (event.key === "Tab") {
            const focusable = [$("editFromModalButton"), $("closeChapterModal"), $("chapterModalContent")].filter(Boolean);
            const idx = focusable.indexOf(document.activeElement);
            event.preventDefault();
            focusable[(idx + (event.shiftKey ? focusable.length - 1 : 1)) % focusable.length].focus();
        }
        return;
    }
    if (event.key === "Escape" && $("mobileMenuToggle").getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        setMobileMenu(false);
        $("mobileMenuToggle").focus();
    }
});

// CHAPTER LIST

async function loadChapters() {
    try {
        const items = await request("/api/chapters");

        $("chapterList").innerHTML = items.length
            ? items.map(c => `
                <div class="item">

                    <strong id="chapter-title-${Number(c.id)}">${escapeHTML(c.title)}</strong>

                    <p>
                        ${escapeHTML((c.content || "").slice(0, 220))}
                        ${(c.content || "").length > 220 ? "…" : ""}
                    </p>

                    <span class="small">
                        ${(c.content || "").trim().split(/\s+/).filter(Boolean).length} words
                    </span>

                    <div class="chapter-actions">

                        <button
                            class="view-btn"
                            aria-describedby="chapter-title-${Number(c.id)}"
                            onclick="viewChapter(${Number(c.id)})">
                            View
                        </button>

                        <button
                            class="edit-btn"
                            aria-describedby="chapter-title-${Number(c.id)}"
                            onclick="editChapter(${Number(c.id)})">
                            Edit
                        </button>

                        <button
                            class="danger"
                            aria-describedby="chapter-title-${Number(c.id)}"
                            onclick="deleteChapter(${Number(c.id)})">
                            Delete
                        </button>

                    </div>
                </div>
            `).join("")
            : '<div class="empty">No saved chapters yet.</div>';

    } catch (e) {
        renderListError("chapterList", "Could not load chapters", e, loadChapters);
    }
}

// Delete a saved chapter

async function deleteChapter(id) {
    if (editingChapterId === id) { toast("Finish or cancel editing this chapter before deleting it."); return; }
    if (!confirm("Delete this chapter?")) return;

    try {
        await request("/api/chapters/" + id, "DELETE", null, { idempotencyKey: createRequestKey() });

        toast("Chapter deleted.");

        loadChapters();
        loadDashboard();

    } catch (e) {
        toast("Could not delete chapter: " + e.message);
    }
}

// WORLD BUILDING MEMORY

let memories = [];
let editingMemoryId = null;
let memorySaving = false;
let memoryBaseline = null;
let memoryCreateKey = null;

function memoryValues() {
    return { name: $("memoryName").value, category: $("memoryCategory").value, description: $("memoryDescription").value };
}
function memoryHasChanges() {
    const current = memoryValues();
    return memoryBaseline ? Object.keys(current).some(key => current[key] !== memoryBaseline[key])
        : Boolean(current.name || current.description);
}
function resetMemoryEditor() {
    editingMemoryId = null;
    memoryBaseline = null;
    memoryCreateKey = null;
    $("memoryName").value = "";
    $("memoryCategory").querySelectorAll("option[data-custom-category]").forEach(option => option.remove());
    $("memoryCategory").selectedIndex = 0;
    $("memoryDescription").value = "";
    $("saveMemoryButton").textContent = "Save to world memory";
    $("cancelMemoryButton").hidden = true;
}
function editMemory(id) {
    if (memorySaving || editingMemoryId === id) return;
    const item = memories.find(entry => entry.id === id);
    if (!item) return;
    if (memoryHasChanges() && !confirm("Replace the unsaved world entry in the form?")) return;
    editingMemoryId = id;
    memoryCreateKey = null;
    memoryBaseline = { name: item.name || "", category: item.category || "General", description: item.description || "" };
    $("memoryName").value = memoryBaseline.name;
    const category = $("memoryCategory");
    category.querySelectorAll("option[data-custom-category]").forEach(option => option.remove());
    if (![...category.options].some(option => option.value === memoryBaseline.category)) {
        const option = new Option(memoryBaseline.category, memoryBaseline.category);
        option.dataset.customCategory = "true";
        category.add(option);
    }
    category.value = memoryBaseline.category;
    $("memoryDescription").value = memoryBaseline.description;
    $("saveMemoryButton").textContent = "Save changes";
    $("cancelMemoryButton").hidden = false;
    $("memoryName").focus();
    $("memoryName").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelMemoryEdit() {
    if (memorySaving) return;
    if (memoryHasChanges() && !confirm("Discard your unsaved changes?")) return;
    resetMemoryEditor();
}
async function addMemory() {
    if (memorySaving) return;
    const values = memoryValues();
    values.name = values.name.trim();
    values.category = values.category.trim();
    if (!values.name) { toast("Please enter a name."); return; }
    if (!values.category) { toast("Please select a category."); return; }
    memorySaving = true;
    const wasEditing = editingMemoryId !== null;
    if (!wasEditing && !memoryCreateKey) memoryCreateKey = createRequestKey();
    const controls = ["memoryName", "memoryCategory", "memoryDescription", "saveMemoryButton", "cancelMemoryButton"];
    controls.forEach(id => $(id).disabled = true);
    try {
        await request(
            wasEditing ? "/api/memories/" + editingMemoryId : "/api/memories",
            wasEditing ? "PUT" : "POST",
            values,
            wasEditing ? {} : { idempotencyKey: memoryCreateKey }
        );
        resetMemoryEditor();
        toast(wasEditing ? "World entry updated." : "World memory saved.");
        loadMemories();
        loadDashboard();
    } catch (e) {
        if (wasEditing && e.status === 404) {
            editingMemoryId = null;
            memoryBaseline = null;
            memoryCreateKey = createRequestKey();
            $("saveMemoryButton").textContent = "Save to world memory";
            $("cancelMemoryButton").hidden = true;
            loadMemories();
            loadDashboard();
        }
        toast("Could not save: " + e.message);
    } finally {
        memorySaving = false;
        controls.forEach(id => $(id).disabled = false);
    }
}
async function loadMemories() {
    try {
        memories = await request("/api/memories");
        $("memoryList").innerHTML = memories.length
            ? memories.map(m => `
                <div class="item">
                    <span class="tag">${escapeHTML(m.category)}</span>
                    <strong>${escapeHTML(m.name)}</strong>
                    <p>${escapeHTML(m.description)}</p>
                    <div class="chapter-actions">
                        <button class="edit-btn" onclick="editMemory(${Number(m.id)})" aria-label="Edit ${escapeHTML(m.name)}">Edit</button>
                        <button class="danger" onclick="deleteMemory(${Number(m.id)})" aria-label="Delete ${escapeHTML(m.name)}">Delete</button>
                    </div>
                </div>
            `).join("")
            : '<div class="empty">Your world is waiting to be documented.</div>';
    } catch (e) { renderListError("memoryList", "Could not load world memory", e, loadMemories); }
}
async function deleteMemory(id) {
    if (editingMemoryId === id) { toast("Finish or cancel editing this entry before deleting it."); return; }
    if (!confirm("Delete this world entry?")) return;
    try {
        await request("/api/memories/" + id, "DELETE", null, { idempotencyKey: createRequestKey() });
        toast("Entry deleted.");
        loadMemories(); loadDashboard();
    } catch (e) { toast("Could not delete entry: " + e.message); }
}

// CHARACTER MANAGEMENT

let characters = [];
let editingCharacterId = null;
let characterSaving = false;
let characterBaseline = null;
let characterCreateKey = null;

function characterValues() {
    return { name: $("charName").value, personality: $("charPersonality").value, description: $("charDescription").value };
}
function characterHasChanges() {
    const current = characterValues();
    return characterBaseline ? Object.keys(current).some(key => current[key] !== characterBaseline[key])
        : Boolean(current.name || current.personality || current.description);
}
function resetCharacterEditor() {
    editingCharacterId = null;
    characterBaseline = null;
    characterCreateKey = null;
    $("charName").value = "";
    $("charPersonality").value = "";
    $("charDescription").value = "";
    $("saveCharacterButton").textContent = "Add character";
    $("cancelCharacterButton").hidden = true;
}
function editCharacter(id) {
    if (characterSaving || editingCharacterId === id) return;
    const item = characters.find(entry => entry.id === id);
    if (!item) return;
    if (characterHasChanges() && !confirm("Replace the unsaved character in the form?")) return;
    editingCharacterId = id;
    characterCreateKey = null;
    characterBaseline = { name: item.name || "", personality: item.personality || "", description: item.description || "" };
    $("charName").value = characterBaseline.name;
    $("charPersonality").value = characterBaseline.personality;
    $("charDescription").value = characterBaseline.description;
    $("saveCharacterButton").textContent = "Save changes";
    $("cancelCharacterButton").hidden = false;
    $("charName").focus();
    $("charName").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelCharacterEdit() {
    if (characterSaving) return;
    if (characterHasChanges() && !confirm("Discard your unsaved changes?")) return;
    resetCharacterEditor();
}
async function addCharacter() {
    if (characterSaving) return;
    const values = characterValues();
    values.name = values.name.trim();
    values.personality = values.personality.trim();
    if (!values.name) { toast("Please enter a character name."); return; }
    characterSaving = true;
    const wasEditing = editingCharacterId !== null;
    if (!wasEditing && !characterCreateKey) characterCreateKey = createRequestKey();
    const controls = ["charName", "charPersonality", "charDescription", "saveCharacterButton", "cancelCharacterButton"];
    controls.forEach(id => $(id).disabled = true);
    try {
        await request(
            wasEditing ? "/api/characters/" + editingCharacterId : "/api/characters",
            wasEditing ? "PUT" : "POST",
            values,
            wasEditing ? {} : { idempotencyKey: characterCreateKey }
        );
        resetCharacterEditor();
        toast(wasEditing ? "Character updated." : "Character added.");
        loadCharacters();
        loadDashboard();
    } catch (e) {
        if (wasEditing && e.status === 404) {
            editingCharacterId = null;
            characterBaseline = null;
            characterCreateKey = createRequestKey();
            $("saveCharacterButton").textContent = "Add character";
            $("cancelCharacterButton").hidden = true;
            loadCharacters();
            loadDashboard();
        }
        toast("Could not save character: " + e.message);
    } finally {
        characterSaving = false;
        controls.forEach(id => $(id).disabled = false);
    }
}
async function loadCharacters() {
    try {
        characters = await request("/api/characters");
        $("characterList").innerHTML = characters.length
            ? characters.map(c => `
                <div class="item">
                    <strong>${escapeHTML(c.name)}</strong>
                    <span class="tag">${escapeHTML(c.personality || "Character")}</span>
                    <p>${escapeHTML(c.description)}</p>
                    <div class="chapter-actions">
                        <button class="edit-btn" onclick="editCharacter(${Number(c.id)})" aria-label="Edit ${escapeHTML(c.name)}">Edit</button>
                        <button class="danger" onclick="deleteCharacter(${Number(c.id)})" aria-label="Delete ${escapeHTML(c.name)}">Delete</button>
                    </div>
                </div>
            `).join("")
            : '<div class="empty">Your characters will appear here.</div>';
    } catch (e) { renderListError("characterList", "Could not load characters", e, loadCharacters); }
}
async function deleteCharacter(id) {
    if (editingCharacterId === id) { toast("Finish or cancel editing this character before deleting it."); return; }
    if (!confirm("Delete this character?")) return;
    try {
        await request("/api/characters/" + id, "DELETE", null, { idempotencyKey: createRequestKey() });
        toast("Character deleted.");
        loadCharacters(); loadDashboard();
    } catch (e) { toast("Could not delete character: " + e.message); }
}

// CHEKHOV'S GUN TRACKER

async function loadChekhov() {
    try {
        const items = await request("/api/chekhov");

        $("chekhovList").innerHTML = items.length
            ? items.map(item => `
                <div class="item">
                    <strong>${escapeHTML(item.title)}</strong>
                    <span class="tag">${escapeHTML(item.status)}</span>
                    <p>First appearance: ${escapeHTML(item.first_appearance || "Not specified")}</p>
                    <p>${escapeHTML(item.notes || "")}</p>
                    <button class="danger" onclick="deleteChekhov(${Number(item.id)})">
                        Delete
                    </button>
                </div>
            `).join("")
            : '<div class="empty">No story threads recorded yet.</div>';

    } catch (e) {
        renderListError("chekhovList", "Could not load story threads", e, loadChekhov);
    }
}

async function addChekhov() {
    const title = $("chekhovTitle").value.trim();

    if (!title) {
        toast("Please enter a story element.");
        return;
    }

    const button = $("addChekhovButton");
    button.disabled = true;

    try {
        await request("/api/chekhov", "POST", {
            title,
            first_appearance: $("chekhovChapter").value.trim(),
            status: $("chekhovStatus").value,
            notes: $("chekhovNotes").value.trim()
        });

        $("chekhovTitle").value = "";
        $("chekhovChapter").value = "";
        $("chekhovNotes").value = "";
        $("chekhovMessage").textContent = "Story thread added.";

        toast("Story thread added.");
        await loadChekhov();

    } catch (e) {
        $("chekhovMessage").textContent = "Could not add thread: " + e.message;
    } finally {
        button.disabled = false;
    }
}

async function deleteChekhov(id) {
    if (!confirm("Delete this story thread?")) return;

    try {
        await request("/api/chekhov/" + id, "DELETE");
        toast("Story thread deleted.");
        await loadChekhov();
    } catch (e) {
        toast("Could not delete story thread: " + e.message);
    }
}


// NARRATIVE DNA

async function analyzeNarrativeDNA() {
    const button = $("analyzeDNAButton");
    if (button.disabled) return;

    const scope = $("dnaScope").value;
    const text = $("dnaText").value.trim();

    if (scope === "excerpt" && !text) {
        toast("Please enter some writing to analyze.");
        return;
    }

    button.disabled = true;
    $("dnaMessage").textContent = "Analyzing your writing...";
    $("dnaResult").textContent = "";

    try {
        const result = await request("/api/ai/narrative-dna", "POST", {
            text,
            scope,
            focus: $("dnaFocus").value
        });

        $("dnaResult").textContent = result.result || "No analysis returned.";
        $("dnaMessage").textContent = "Analysis complete.";

    } catch (e) {
        $("dnaMessage").textContent = "Analysis failed: " + e.message;
    } finally {
        button.disabled = false;
    }
}


// CHARACTER RELATIONSHIP WEB

async function loadRelationships() {
    try {
        await loadCharacters();

        const from = $("relationshipFrom");
        const to = $("relationshipTo");

        const options = characters.map(character =>
            `<option value="${Number(character.id)}">${escapeHTML(character.name)}</option>`
        ).join("");

        from.innerHTML = '<option value="">Select character</option>' + options;
        to.innerHTML = '<option value="">Select character</option>' + options;

        const relationships = await request("/api/relationships");

        $("relationshipGraph").innerHTML = relationships.length
            ? relationships.map(item => `
                <div class="item">
                    <strong>${escapeHTML(item.from_name)} → ${escapeHTML(item.to_name)}</strong>
                    <span class="tag">${escapeHTML(item.relationship_type)}</span>
                    <p>${escapeHTML(item.notes || "")}</p>
                    <button class="danger" onclick="deleteRelationship(${Number(item.id)})">
                        Remove
                    </button>
                </div>
            `).join("")
            : '<div class="empty">Add relationships to start building your character web.</div>';

    } catch (e) {
        renderListError(
            "relationshipGraph",
            "Could not load relationships",
            e,
            loadRelationships
        );
    }
}

async function addRelationship() {
    const fromId = Number($("relationshipFrom").value);
    const toId = Number($("relationshipTo").value);

    if (!fromId || !toId) {
        toast("Select both characters first.");
        return;
    }

    if (fromId === toId) {
        toast("Choose two different characters.");
        return;
    }

    const button = $("addRelationshipButton");
    button.disabled = true;

    try {
        await request("/api/relationships", "POST", {
            from_character_id: fromId,
            to_character_id: toId,
            relationship_type: $("relationshipType").value,
            notes: $("relationshipNotes").value.trim()
        });

        $("relationshipNotes").value = "";
        $("relationshipMessage").textContent = "Relationship added.";

        toast("Relationship added.");
        await loadRelationships();

    } catch (e) {
        $("relationshipMessage").textContent = "Could not add relationship: " + e.message;
    } finally {
        button.disabled = false;
    }
}

async function deleteRelationship(id) {
    if (!confirm("Remove this relationship?")) return;

    try {
        await request("/api/relationships/" + id, "DELETE");
        toast("Relationship removed.");
        await loadRelationships();
    } catch (e) {
        toast("Could not remove relationship: " + e.message);
    }
}


// FEATURE BUTTON EVENTS

$("addChekhovButton").addEventListener("click", addChekhov);
$("analyzeDNAButton").addEventListener("click", analyzeNarrativeDNA);
$("addRelationshipButton").addEventListener("click", addRelationship);

// AI WRITING TOOLS

async function runAI(feature) {

    const config = {

        grammar: {
            input: "grammarText",
            result: "grammarResult",
            button: "runGrammarButton",
            extra: () => ({
                style: $("grammarMode").value
            })
        },

        consistency: {
            input: "consistencyText",
            result: "consistencyResult",
            button: "runConsistencyButton",
            extra: () => ({})
        },

        enrich: {
            input: "descriptionText",
            result: "descriptionResult",
            button: "runDescriptionButton",
            extra: () => ({
                style: $("descriptionStyle").value
            })
        },

        story: {
            input: "storySituation",
            result: "storyResult",
            button: "runStoryButton",
            extra: () => ({
                idea: $("ownIdea").value
            })
        }

    };

    const c = config[feature];
    if (!c) return;
    const btn = $(c.button);
    if (btn && btn.disabled) return;

    const text = $(c.input).value.trim();
    const out = $(c.result);

    if (!text) {
        toast("Please enter some text first.");
        return;
    }

    if (btn) btn.disabled = true;
    out.innerHTML =
        '<div class="result">✦ Thinking about your story...</div>';

    try {

        const result = await request(
            "/api/ai/" + feature,
            "POST",
            {
                text,
                ...c.extra()
            }
        );

        renderAIResult(out, result.result, result.references);

        if (feature === "story") {
            storyDirections = parseDirections(result.result);
            storyQuestions = parseQuestions(result.result);
            showBrainstormPanel();
        }

    } catch (e) {

        out.innerHTML =
            '<div class="result">Something went wrong: ' +
            escapeHTML(e.message) +
            '</div>';

    } finally {
        if (btn) btn.disabled = false;
    }
}

// AI RESULT ACTIONS

/**
 * Render an AI response with actions for moving it into the author's own draft.
 * Text stays in textContent so nothing from the model is ever parsed as markup.
 */
function renderAIResult(container, text, references = null) {
    container.innerHTML = "";

    const value = String(text ?? "").trim() || "No result returned.";

    const box = document.createElement("div");
    box.className = "result";

    // Sources are resolved on the server and only include records the request
    // actually sent, so every tag shown here points at a real saved entry.
    if (Array.isArray(references) && references.length) {
        const sources = document.createElement("div");
        sources.className = "result-sources";

        const heading = document.createElement("p");
        heading.className = "result-sources-label";
        heading.textContent = "Checked against " + references.length +
            " saved " + (references.length === 1 ? "entry" : "entries");
        sources.appendChild(heading);

        const list = document.createElement("ul");
        list.className = "source-list";

        references.forEach(ref => {
            const item = document.createElement("li");
            item.className = "source-item";

            const tag = document.createElement("span");
            tag.className = "source-tag";
            tag.textContent = String(ref.tag || "");

            const title = document.createElement("span");
            title.className = "source-title";
            title.textContent = String(ref.title || "Untitled");

            const category = document.createElement("span");
            category.className = "source-category";
            category.textContent = String(ref.category || "");

            item.append(tag, title, category);
            list.appendChild(item);
        });

        sources.appendChild(list);
        box.appendChild(sources);
    }

    const body = document.createElement("div");
    body.className = "result-text";
    body.textContent = value;

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyText(value, copy));

    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "ghost";
    insert.textContent = "Insert into editor";
    insert.addEventListener("click", () => insertIntoEditor(value, insert));

    actions.append(copy, insert);
    box.append(body, actions);
    container.appendChild(box);
}

async function copyText(value, button) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
        } else {
            // Fallback for non-secure contexts, where the async clipboard API is unavailable.
            const helper = document.createElement("textarea");
            helper.value = value;
            helper.setAttribute("readonly", "");
            helper.style.position = "fixed";
            helper.style.top = "-1000px";
            document.body.appendChild(helper);
            helper.select();
            const copied = document.execCommand("copy");
            helper.remove();
            if (!copied) throw new Error("Copy was blocked by the browser.");
        }
        if (button) {
            const original = button.textContent;
            button.textContent = "Copied";
            setTimeout(() => { button.textContent = original; }, 2000);
        }
        toast("Copied to clipboard.");
    } catch (error) {
        toast("Could not copy: " + error.message);
    }
}

function insertIntoEditor(value, button) {
    const target = $("chapterText");
    if (!target) return;

    if (chapterIsDirty() || target.value.trim()) {
        const proceed = confirm("Add this suggestion to the chapter editor? Your current draft text is kept and the suggestion is appended.");
        if (!proceed) return;
    }

    // Append rather than replace: the assistant's output is a suggestion, and the
    // author's existing words must survive by default.
    const existing = target.value.replace(/\s+$/, "");
    const separator = existing ? "\n\n" : "";
    target.value = existing + separator + value;

    navigate("editor");
    updateChapterDraft();
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);

    if (button) {
        const original = button.textContent;
        button.textContent = "Inserted";
        setTimeout(() => { button.textContent = original; }, 2000);
    }
    toast("Suggestion added to the editor. Nothing is saved until you save the chapter.");
}

// INTERACTIVE STORY BRAINSTORMING
//
// The story endpoint returns prose. Rather than depend on structured JSON from
// the model, the prose is split into selectable blocks so a failure to follow a
// format degrades into one big option instead of an error.

let storyDirections = [];
let storyQuestions = [];

/** Split an AI response into the individual directions it describes. */
function parseDirections(text) {
    const value = String(text ?? "").trim();
    if (!value) return [];

    const lines = value.split(/\r?\n/);

    // A direction starts at a numbered marker ("1.", "2)"), a bullet at the start
    // of the response, or a markdown heading. Anything else is body text. Being
    // strict here matters: a loose rule turns every paragraph into an "option".
    const startsDirection = line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (/^#{1,4}\s+/.test(trimmed)) return true;
        if (/^\d+[.)]\s+/.test(trimmed)) return true;
        if (/^[-*•]\s+/.test(trimmed)) return true;
        return false;
    };

    const blocks = [];
    let current = null;
    let insideQuestions = false;

    lines.forEach(line => {
        const trimmed = line.trim();

        // The trailing question section is not a direction.
        if (/^#*\s*questions?\s+to\s+explore/i.test(trimmed)) {
            insideQuestions = true;
            return;
        }
        if (insideQuestions) return;

        if (startsDirection(line)) {
            if (current) blocks.push(current);
            current = { title: trimmed, body: [] };
        } else if (current) {
            current.body.push(line);
        } else if (trimmed) {
            // Prose before the first marker: keep it as a single fallback option.
            current = { title: null, body: [line] };
        }
    });
    if (current) blocks.push(current);

    return blocks
        .map((block, i) => {
            const body = block.body.join("\n").trim();
            let title = block.title
                ? block.title.replace(/^(\d+[.)]|[-*•]|#{1,4})\s*/, "").replace(/\*\*/g, "").trim()
                : "";
            if (!title) {
                const firstLine = (body.split("\n")[0] || "").replace(/\*\*/g, "").trim();
                title = firstLine.slice(0, 80) || "Direction " + (i + 1);
            }
            return { title, body };
        })
        .filter(direction => direction.title || direction.body);
}

/** Pull "Questions to explore further" out of an exploration response. */
function parseQuestions(text) {
    const value = String(text ?? "");
    const match = value.match(/questions?\s+to\s+explore\s+further\s*:?[ \t]*\r?\n([\s\S]*)$/i);
    if (!match) return [];

    return match[1]
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,4})\s*/, "").replace(/\*\*/g, "").trim())
        .filter(line => line.length > 3)
        .slice(0, 4);
}

function renderDirectionOptions() {
    const holder = $("directionOptions");
    if (!holder) return;
    holder.innerHTML = "";

    storyDirections.forEach((direction, index) => {
        const label = document.createElement("label");
        label.className = "direction-option";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = String(index);
        input.className = "direction-checkbox";

        const text = document.createElement("span");
        text.className = "direction-title";
        text.textContent = direction.title;

        label.append(input, text);
        holder.appendChild(label);
    });
}

function selectedDirectionIndexes() {
    return [...document.querySelectorAll(".direction-checkbox:checked")]
        .map(input => Number(input.value))
        .filter(index => Number.isInteger(index) && index >= 0 && index < storyDirections.length);
}

function selectedDirectionsText(withAnswers = true) {
    const chosen = selectedDirectionIndexes().map(index => {
        const direction = storyDirections[index];
        return "- " + direction.title + (direction.body ? "\n  " + direction.body.replace(/\n/g, "\n  ") : "");
    });

    const answers = withAnswers && $("storyAnswers") ? $("storyAnswers").value.trim() : "";
    if (answers) chosen.push("\nAuthor's decisions and answers:\n" + answers);
    return chosen.join("\n");
}

function showBrainstormPanel() {
    const panel = $("brainstormPanel");
    if (!panel) return;
    panel.hidden = storyDirections.length === 0;
    renderDirectionOptions();

    const questions = $("storyQuestions");
    if (questions) {
        questions.innerHTML = "";
        if (storyQuestions.length) {
            const heading = document.createElement("p");
            heading.className = "result-sources-label";
            heading.textContent = "Questions to explore further";
            questions.appendChild(heading);

            const list = document.createElement("ul");
            list.className = "question-list";
            storyQuestions.forEach(question => {
                const item = document.createElement("li");
                item.textContent = question;
                list.appendChild(item);
            });
            questions.appendChild(list);
        }
    }
}

function resetBrainstorm() {
    storyDirections = [];
    storyQuestions = [];
    const panel = $("brainstormPanel");
    if (panel) panel.hidden = true;
    const questions = $("storyQuestions");
    if (questions) questions.innerHTML = "";
    const answers = $("storyAnswers");
    if (answers) answers.value = "";
    const result = $("storyResult");
    if (result) result.innerHTML = "";
}

async function requestStoryRefinement(directionText, button, pendingLabel) {
    const situation = $("storySituation").value.trim();
    if (!situation) {
        toast("Describe the current situation first.");
        return;
    }
    if (!directionText.trim()) {
        toast("Select at least one direction to develop.");
        return;
    }

    if (button) button.disabled = true;
    const out = $("storyResult");
    out.innerHTML = '<div class="result">✦ Thinking about your story...</div>';

    try {
        const result = await request("/api/ai/story", "POST", {
            text: situation,
            direction: directionText.slice(0, 4000)
        });

        storyDirections = parseDirections(result.result);
        storyQuestions = [];
        renderAIResult(out, result.result);
        showBrainstormPanel();
        toast(pendingLabel);
    } catch (e) {
        out.innerHTML = '<div class="result">Something went wrong: ' + escapeHTML(e.message) + '</div>';
    } finally {
        if (button) button.disabled = false;
    }
}

async function refineStory() {
    const indexes = selectedDirectionIndexes();
    if (!indexes.length) {
        toast("Select the directions you want to develop.");
        return;
    }
    await requestStoryRefinement(selectedDirectionsText(), $("refineStoryButton"), "Developed the directions you selected.");
}

async function combineDirections() {
    const indexes = selectedDirectionIndexes();
    if (indexes.length < 2) {
        toast("Select at least two directions to combine.");
        return;
    }
    const combined = "Combine these directions into one coherent possibility, keeping what makes each interesting:\n" +
        selectedDirectionsText(false);
    await requestStoryRefinement(combined, $("combineStoryButton"), "Combined the directions you selected.");
}

// CHARACTER AI ANALYSIS

async function runCharacterAnalysis() {
    const btn = $("runCharacterButton");
    if (btn && btn.disabled) return;

    const text = $("characterAnalysisText").value.trim();

    if (!text) {
        toast("Describe a character first.");
        return;
    }

    if (btn) btn.disabled = true;
    $("characterResult").innerHTML =
        '<div class="result">Analysing character...</div>';

    try {

        const result = await request(
            "/api/ai/character",
            "POST",
            { text }
        );

        renderAIResult($("characterResult"), result.result);

    } catch (e) {

        $("characterResult").innerHTML =
            '<div class="result">Something went wrong: ' +
            escapeHTML(e.message) +
            '</div>';

    } finally {
        if (btn) btn.disabled = false;
    }
}

window.addEventListener("offline", () => {
    setBackendStatus("○ Offline", false);
});
window.addEventListener("online", () => {
    initialise();
});

// APPLICATION STARTUP

async function initialise() {

    renderGoal();

    try {

        await request("/api/health");

        setBackendStatus("● Backend connected", true);

        // The dashboard needs an owned novel, which only exists once somebody
        // is signed in. auth.js calls initialise() again after login.
        if (getAccessToken()) {
            loadDashboard();
        } else {
            setBackendStatusFromError(Object.assign(new Error("signed out"), { authRequired: true }));
        }

    } catch (e) {

        setBackendStatus("○ Backend not connected", false);

    }

}

window.initialise = initialise;

initialise();
