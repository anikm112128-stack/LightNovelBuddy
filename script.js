const API = "https://lightnovelbuddy.onrender.com";

const $ = (id) => document.getElementById(id);

let editingChapterId = null;

const AUTH_TOKEN_KEY = "lnb_access_token";
const SELECTED_NOVEL_KEY = "lnb_selected_novel";

function getAccessToken() {
    return sessionStorage.getItem(AUTH_TOKEN_KEY);
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
                    sessionStorage.removeItem(AUTH_TOKEN_KEY);
                }

                throw err;
            }

            if ($("backendStatus")) {
                $("backendStatus").textContent = "● Backend connected";
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
                $("backendStatus").textContent = offline
                    ? "○ Offline"
                    : "○ Backend unavailable";
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
        story: "Story Development"
    };

    $("pageTitle").textContent = titles[page] || "Light Novel Buddy";
    setMobileMenu(false);
    if (menuWasOpen && window.matchMedia("(max-width: 760px)").matches) $("pageTitle").focus({ preventScroll: true });

    if (page === "dashboard") loadDashboard();
    if (page === "editor") loadChapters();
    if (page === "memory") loadMemories();
    if (page === "characters") loadCharacters();
}

document.querySelectorAll(".nav").forEach(b => {
    b.addEventListener("click", () => navigate(b.dataset.page));
});

// CHAPTER DRAFTS AND WORD COUNTER

const CHAPTER_DRAFT_KEY = "lightNovelBuddy.chapterDraft.v1";
let chapterBaseline = { title: "", content: "" };
let chapterCreateKey = null;
let chapterSaving = false;
let chapterLoading = false;
let storageWarningShown = false;

function chapterValues() {
    return { title: $("chapterTitle").value, content: $("chapterText").value };
}

function chapterIsDirty() {
    const values = chapterValues();
    return values.title !== chapterBaseline.title || values.content !== chapterBaseline.content;
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
    try {
        if (dirty) {
            localStorage.setItem(CHAPTER_DRAFT_KEY, JSON.stringify({
                chapterId: editingChapterId, baseline: chapterBaseline, createKey: chapterCreateKey, ...values
            }));
        } else {
            localStorage.removeItem(CHAPTER_DRAFT_KEY);
        }
    } catch (error) {
        if (!storageWarningShown && dirty) {
            storageWarningShown = true;
            toast("Local draft storage is unavailable. Save your work before leaving.");
        }
    }
}

function updateChapterEditControls(restored = false) {
    $("saveChapterButton").textContent = editingChapterId === null ? "Save chapter" : "Save changes";
    $("cancelEditButton").style.display = editingChapterId === null ? "none" : "inline-block";
    $("editStatus").textContent = editingChapterId === null
        ? "Recovered an unsaved draft from this browser."
        : (restored ? "Recovered unsaved changes. " : "") + "Editing: " + (chapterBaseline.title || "Untitled chapter") + ". Saving will update this chapter.";
    $("editStatus").style.display = (editingChapterId !== null || restored) ? "block" : "none";
}

function restoreChapterDraft() {
    try {
        const raw = localStorage.getItem(CHAPTER_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (typeof draft.title !== "string" || typeof draft.content !== "string" ||
            !draft.baseline || typeof draft.baseline.title !== "string" || typeof draft.baseline.content !== "string" ||
            !(draft.chapterId === null || (Number.isInteger(draft.chapterId) && draft.chapterId > 0))) {
            localStorage.removeItem(CHAPTER_DRAFT_KEY);
            return;
        }
        if (draft.title === draft.baseline.title && draft.content === draft.baseline.content) {
            localStorage.removeItem(CHAPTER_DRAFT_KEY);
            return;
        }
        editingChapterId = draft.chapterId;
        chapterBaseline = draft.baseline;
        chapterCreateKey = draft.chapterId === null && typeof draft.createKey === "string" ? draft.createKey : null;
        $("chapterTitle").value = draft.title;
        $("chapterText").value = draft.content;
        updateChapterEditControls(true);
        updateChapterDraft();
    } catch (error) {
        // The editor remains usable if storage is blocked or contains invalid data.
    }
}

$("chapterTitle").addEventListener("input", updateChapterDraft);
$("chapterText").addEventListener("input", updateChapterDraft);
restoreChapterDraft();

// DASHBOARD

async function loadDashboard() {
    try {
        const d = await request("/api/dashboard");

        $("chapterCount").textContent = d.chapters ?? 0;
        $("wordCount").textContent = Number(d.words ?? 0).toLocaleString();
        $("characterCount").textContent = d.characters ?? 0;
        $("memoryCount").textContent = d.memories ?? 0;

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
        $("backendStatus").textContent = "Backend unavailable";
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

// CHAPTER VIEWING

let chapterModalPreviousFocus = null;

async function viewChapter(id) {
    try {
        const c = await request("/api/chapters/" + id);

        $("chapterModalTitle").textContent =
            c.title || "Untitled chapter";

        $("chapterModalContent").textContent =
            c.content || "(This chapter is empty.)";

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
}
document.addEventListener("keydown", event => {
    if ($("chapterModal").classList.contains("open")) {
        if (event.key === "Escape") { event.preventDefault(); closeChapterView(); return; }
        if (event.key === "Tab") {
            const focusable = [$("closeChapterModal"), $("chapterModalContent")].filter(Boolean);
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

        out.innerHTML =
            '<div class="result">' +
            escapeHTML(result.result || "No result returned.") +
            '</div>';

    } catch (e) {

        out.innerHTML =
            '<div class="result">Something went wrong: ' +
            escapeHTML(e.message) +
            '</div>';

    } finally {
        if (btn) btn.disabled = false;
    }
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

        $("characterResult").innerHTML =
            '<div class="result">' +
            escapeHTML(result.result || "No result returned.") +
            '</div>';

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
    if ($("backendStatus")) $("backendStatus").textContent = "○ Offline";
});
window.addEventListener("online", () => {
    initialise();
});

// APPLICATION STARTUP

async function initialise() {

    try {

        await request("/api/health");

        $("backendStatus").textContent = "● Backend connected";

        loadDashboard();

    } catch (e) {

        $("backendStatus").textContent = "○ Backend not connected";

    }

}

initialise();
      
