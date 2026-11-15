const API = "https://lightnovelbuddy.onrender.com";

const $ = (id) => document.getElementById(id);

let editingChapterId = null;

// API REQUEST HANDLER

async function request(path, method = "GET", data = null) {
    const options = {
        method,
        headers: { "Content-Type": "application/json" }
    };

    if (data) {
        options.body = JSON.stringify(data);
    }

    const response = await fetch(API + path, options);

    let result = {};

    try {
        result = await response.json();
    } catch (e) {}

    if (!response.ok) {
        throw new Error(result.detail || "Server returned " + response.status);
    }

    return result;
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
    window.removeEventListener("beforeunload", warnBeforeUnload);
    if (chapterIsDirty()) window.addEventListener("beforeunload", warnBeforeUnload);
    try {
        if (chapterIsDirty()) {
            localStorage.setItem(CHAPTER_DRAFT_KEY, JSON.stringify({
                chapterId: editingChapterId, baseline: chapterBaseline, ...values
            }));
        } else {
            localStorage.removeItem(CHAPTER_DRAFT_KEY);
        }
    } catch (error) {
        if (!storageWarningShown && chapterIsDirty()) {
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
            !(draft.chapterId === null || Number.isInteger(draft.chapterId))) return;
        editingChapterId = draft.chapterId;
        chapterBaseline = draft.baseline;
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

    chapterSaving = true;
    $("saveChapterButton").disabled = true;
    try {
        const wasEditing = editingChapterId !== null;
        const result = await request(wasEditing ? "/api/chapters/" + editingChapterId : "/api/chapters",
            wasEditing ? "PUT" : "POST", { title, content: snapshot.content });
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
        updateChapterDraft();
        toast("Could not save chapter: " + e.message);
    } finally {
        chapterSaving = false;
        $("saveChapterButton").disabled = false;
    }
}

function resetChapterEditor() {
    editingChapterId = null;
    chapterBaseline = { title: "", content: "" };
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
        $("chapterTitle").value = chapterBaseline.title;
        $("chapterText").value = chapterBaseline.content;
        updateChapterEditControls();
        updateChapterDraft();
        navigate("editor");
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
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
        $("chapterModal").classList.add("open");
        $("closeChapterModal").focus();

    } catch (e) {
        toast("Could not load chapter: " + e.message);
    }
}

function closeChapterView() {
    $("chapterModal").classList.remove("open");
    if (chapterModalPreviousFocus && chapterModalPreviousFocus.isConnected) chapterModalPreviousFocus.focus();
    chapterModalPreviousFocus = null;
}
document.addEventListener("keydown", event => {
    if (!$("chapterModal").classList.contains("open")) return;
    if (event.key === "Escape") { event.preventDefault(); closeChapterView(); }
    // The close button is the only interactive control in this dialog.
    if (event.key === "Tab") { event.preventDefault(); $("closeChapterModal").focus(); }
});

// CHAPTER LIST

async function loadChapters() {
    try {
        const items = await request("/api/chapters");

        $("chapterList").innerHTML = items.length
            ? items.map(c => `
                <div class="item">

                    <strong>${escapeHTML(c.title)}</strong>

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
                            onclick="viewChapter(${Number(c.id)})">
                            View
                        </button>

                        <button
                            class="edit-btn"
                            onclick="editChapter(${Number(c.id)})">
                            Edit
                        </button>

                        <button
                            class="danger"
                            onclick="deleteChapter(${Number(c.id)})">
                            Delete
                        </button>

                    </div>
                </div>
            `).join("")
            : '<div class="empty">No saved chapters yet.</div>';

    } catch (e) {
        $("chapterList").textContent = e.message;
    }
}


// Delete a saved chapter

async function deleteChapter(id) {
    if (editingChapterId === id) { toast("Finish or cancel editing this chapter before deleting it."); return; }
    if (!confirm("Delete this chapter?")) return;

    try {
        await request("/api/chapters/" + id, "DELETE");

        toast("Chapter deleted.");

        loadChapters();
        loadDashboard();

    } catch (e) {
        toast(e.message);
    }
}

// WORLD BUILDING MEMORY

let memories = [];
let editingMemoryId = null;
let memorySaving = false;
let memoryBaseline = null;

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
    if (!values.name) { toast("Please enter a name."); return; }
    memorySaving = true;
    const controls = ["memoryName", "memoryCategory", "memoryDescription", "saveMemoryButton", "cancelMemoryButton"];
    controls.forEach(id => $(id).disabled = true);
    try {
        const wasEditing = editingMemoryId !== null;
        await request(wasEditing ? "/api/memories/" + editingMemoryId : "/api/memories", wasEditing ? "PUT" : "POST", values);
        resetMemoryEditor();
        toast(wasEditing ? "World entry updated." : "World memory saved.");
        loadMemories();
        loadDashboard();
    } catch (e) {
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
                    <button class="edit-btn" onclick="editMemory(${Number(m.id)})" aria-label="Edit ${escapeHTML(m.name)}">Edit</button>
                    <button class="danger" onclick="deleteMemory(${Number(m.id)})" aria-label="Delete ${escapeHTML(m.name)}">Delete</button>
                </div>
            `).join("")
            : '<div class="empty">Your world is waiting to be documented.</div>';
    } catch (e) { $("memoryList").textContent = e.message; }
}
async function deleteMemory(id) {
    if (editingMemoryId === id) { toast("Finish or cancel editing this entry before deleting it."); return; }
    if (!confirm("Delete this world entry?")) return;
    try {
        await request("/api/memories/" + id, "DELETE");
        toast("Entry deleted.");
        loadMemories(); loadDashboard();
    } catch (e) { toast(e.message); }
}

// CHARACTER MANAGEMENT

let characters = [];
let editingCharacterId = null;
let characterSaving = false;
let characterBaseline = null;

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
    if (!values.name) { toast("Please enter a character name."); return; }
    characterSaving = true;
    const controls = ["charName", "charPersonality", "charDescription", "saveCharacterButton", "cancelCharacterButton"];
    controls.forEach(id => $(id).disabled = true);
    try {
        const wasEditing = editingCharacterId !== null;
        await request(wasEditing ? "/api/characters/" + editingCharacterId : "/api/characters", wasEditing ? "PUT" : "POST", values);
        resetCharacterEditor();
        toast(wasEditing ? "Character updated." : "Character added.");
        loadCharacters();
        loadDashboard();
    } catch (e) {
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
                    <button class="edit-btn" onclick="editCharacter(${Number(c.id)})" aria-label="Edit ${escapeHTML(c.name)}">Edit</button>
                    <button class="danger" onclick="deleteCharacter(${Number(c.id)})" aria-label="Delete ${escapeHTML(c.name)}">Delete</button>
                </div>
            `).join("")
            : '<div class="empty">Your characters will appear here.</div>';
    } catch (e) { $("characterList").textContent = e.message; }
}
async function deleteCharacter(id) {
    if (editingCharacterId === id) { toast("Finish or cancel editing this character before deleting it."); return; }
    if (!confirm("Delete this character?")) return;
    try {
        await request("/api/characters/" + id, "DELETE");
        toast("Character deleted.");
        loadCharacters(); loadDashboard();
    } catch (e) { toast(e.message); }
}

// AI WRITING TOOLS

async function runAI(feature) {

    const config = {

        grammar: {
            input: "grammarText",
            result: "grammarResult",
            extra: () => ({
                style: $("grammarMode").value
            })
        },

        consistency: {
            input: "consistencyText",
            result: "consistencyResult",
            extra: () => ({})
        },

        enrich: {
            input: "descriptionText",
            result: "descriptionResult",
            extra: () => ({
                style: $("descriptionStyle").value
            })
        },

        story: {
            input: "storySituation",
            result: "storyResult",
            extra: () => ({
                idea: $("ownIdea").value
            })
        }

    };

    const c = config[feature];

    const text = $(c.input).value.trim();
    const out = $(c.result);

    if (!text) {
        toast("Please enter some text first.");
        return;
    }

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

    }
}

// CHARACTER AI ANALYSIS

async function runCharacterAnalysis() {

    const text = $("characterAnalysisText").value.trim();

    if (!text) {
        toast("Describe a character first.");
        return;
    }

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

    }
}

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
      
