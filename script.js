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

function navigate(page) {
    document.querySelectorAll(".page").forEach(p => {
        p.classList.remove("active");
    });

    $(page).classList.add("active");

    document.querySelectorAll(".nav").forEach(b => {
        b.classList.toggle("active", b.dataset.page === page);
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

    if (page === "dashboard") loadDashboard();
    if (page === "editor") loadChapters();
    if (page === "memory") loadMemories();
    if (page === "characters") loadCharacters();
}

document.querySelectorAll(".nav").forEach(b => {
    b.addEventListener("click", () => navigate(b.dataset.page));
});

// CHAPTER WORD COUNTER

$("chapterText").addEventListener("input", () => {
    const count = $("chapterText").value
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

    $("wordCounter").textContent = count + " words";
});

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
    const title = $("chapterTitle").value.trim();
    const content = $("chapterText").value;

    if (!title) {
        toast("Please enter a chapter title.");
        return;
    }

    try {
        if (editingChapterId !== null) {
            await request(
                "/api/chapters/" + editingChapterId,
                "PUT",
                { title, content }
            );

            toast("Chapter updated successfully.");

        } else {
            await request(
                "/api/chapters",
                "POST",
                { title, content }
            );

            toast("Chapter saved successfully.");
        }

        resetChapterEditor();

        await loadChapters();
        loadDashboard();

    } catch (e) {
        toast("Could not save chapter: " + e.message);
    }
}

// Clear the editor and exit editing mode

function resetChapterEditor() {
    editingChapterId = null;

    $("chapterTitle").value = "";
    $("chapterText").value = "";

    $("wordCounter").textContent = "0 words";

    $("saveChapterButton").textContent = "Save chapter";

    $("cancelEditButton").style.display = "none";
    $("editStatus").style.display = "none";
}

// Cancel an ongoing edit

function cancelChapterEdit() {
    if (
        editingChapterId !== null &&
        !confirm("Discard your unsaved changes?")
    ) {
        return;
    }

    resetChapterEditor();

    toast("Editing cancelled.");
}

// Load a saved chapter into the editor

async function editChapter(id) {
    try {
        const c = await request("/api/chapters/" + id);

        editingChapterId = c.id;

        $("chapterTitle").value = c.title || "";
        $("chapterText").value = c.content || "";

        const count = $("chapterText").value
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;

        $("wordCounter").textContent = count + " words";

        $("saveChapterButton").textContent = "Save changes";

        $("cancelEditButton").style.display = "inline-block";

        $("editStatus").textContent =
            "Editing: " + c.title + ". Saving will update this chapter.";

        $("editStatus").style.display = "block";

        navigate("editor");

        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });

    } catch (e) {
        toast("Could not open chapter: " + e.message);
    }
}

// CHAPTER VIEWING

async function viewChapter(id) {
    try {
        const c = await request("/api/chapters/" + id);

        $("chapterModalTitle").textContent =
            c.title || "Untitled chapter";

        $("chapterModalContent").textContent =
            c.content || "(This chapter is empty.)";

        $("chapterModal").classList.add("open");

    } catch (e) {
        toast("Could not load chapter: " + e.message);
    }
}

function closeChapterView() {
    $("chapterModal").classList.remove("open");
}

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

async function addMemory() {
    const name = $("memoryName").value.trim();

    if (!name) {
        toast("Please enter a name.");
        return;
    }

    try {
        await request("/api/memories", "POST", {
            name,
            category: $("memoryCategory").value,
            description: $("memoryDescription").value
        });

        $("memoryName").value = "";
        $("memoryDescription").value = "";

        toast("World memory saved.");

        loadMemories();
        loadDashboard();

    } catch (e) {
        toast("Could not save: " + e.message);
    }
}


async function loadMemories() {
    try {
        const items = await request("/api/memories");

        $("memoryList").innerHTML = items.length
            ? items.map(m => `
                <div class="item">

                    <span class="tag">${escapeHTML(m.category)}</span>

                    <strong>${escapeHTML(m.name)}</strong>

                    <p>${escapeHTML(m.description)}</p>

                    <button
                        class="danger"
                        onclick="deleteMemory(${Number(m.id)})">
                        Delete
                    </button>

                </div>
            `).join("")
            : '<div class="empty">Your world is waiting to be documented.</div>';

    } catch (e) {
        $("memoryList").textContent = e.message;
    }
}


async function deleteMemory(id) {
    if (!confirm("Delete this world entry?")) return;

    try {
        await request("/api/memories/" + id, "DELETE");

        toast("Entry deleted.");

        loadMemories();
        loadDashboard();

    } catch (e) {
        toast(e.message);
    }
}

// CHARACTER MANAGEMENT

async function addCharacter() {
    const name = $("charName").value.trim();

    if (!name) {
        toast("Please enter a character name.");
        return;
    }

    try {
        await request("/api/characters", "POST", {
            name,
            personality: $("charPersonality").value,
            description: $("charDescription").value
        });

        $("charName").value = "";
        $("charPersonality").value = "";
        $("charDescription").value = "";

        toast("Character added.");

        loadCharacters();
        loadDashboard();

    } catch (e) {
        toast("Could not add character: " + e.message);
    }
}


async function loadCharacters() {
    try {
        const items = await request("/api/characters");

        $("characterList").innerHTML = items.length
            ? items.map(c => `
                <div class="item">

                    <strong>${escapeHTML(c.name)}</strong>

                    <span class="tag">
                        ${escapeHTML(c.personality || "Character")}
                    </span>

                    <p>${escapeHTML(c.description)}</p>

                    <button
                        class="danger"
                        onclick="deleteCharacter(${Number(c.id)})">
                        Delete
                    </button>

                </div>
            `).join("")
            : '<div class="empty">Your characters will appear here.</div>';

    } catch (e) {
        $("characterList").textContent = e.message;
    }
}


async function deleteCharacter(id) {
    if (!confirm("Delete this character?")) return;

    try {
        await request("/api/characters/" + id, "DELETE");

        toast("Character deleted.");

        loadCharacters();
        loadDashboard();

    } catch (e) {
        toast(e.message);
    }
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
      
