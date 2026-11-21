"""Tests for the emotional RAG pipeline.

The point of these tests is not that the lexicon is "correct" - feelings are
not measurable quantities. It is that the retrieval machinery behaves
predictably: the same kind of writing retrieves the same kind of passages, and
the backend reports what it actually did without inventing evidence.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.main as app_module
from backend import emotion_rag as rag


# --- pipeline unit tests ---------------------------------------------------

def test_split_passages_respects_bounds_and_overlap():
    text = " ".join(f"Sentence number {i} carries the scene forward." for i in range(80))
    passages = rag.split_passages(text)

    assert len(passages) > 1, "a long text should produce several passages"
    for passage in passages:
        words = len(rag._tokens(passage))
        # Overlap can push a chunk slightly past the ceiling, never far past.
        assert words <= rag.MAX_PASSAGE_WORDS + rag.PASSAGE_OVERLAP + 20


def test_split_passages_keeps_short_text_intact():
    text = "The gate was open. Ash stepped through it without a sound."
    passages = rag.split_passages(text)
    assert len(passages) == 1
    assert "Ash stepped through it" in passages[0]


def test_score_emotions_separates_registers():
    fear = "She was afraid. The dread crawled up her spine and her hands trembled with terror."
    warmth = "He smiled and laughed, warm and gentle, and held her in a soft embrace."

    fear_ranked, _ = rag.score_emotions(fear)
    warmth_ranked, _ = rag.score_emotions(warmth)

    assert fear_ranked[0]["register"] == "tension"
    assert warmth_ranked[0]["register"] == "warmth"


def test_score_emotions_reports_its_evidence():
    ranked, _ = rag.score_emotions("Terror. Dread. The fear was absolute.")
    top = ranked[0]
    assert top["register"] == "tension"
    assert top["evidence"], "a score must say which words produced it"
    assert all(word in "terror dread fear" for word in top["evidence"])


def test_ambivalence_detected_when_registers_pull_apart():
    # Fear and tenderness held at once - the interesting case.
    text = (
        "He was afraid, terrified of what came next, and yet he smiled, "
        "warm and gentle, and held her."
    )
    ranked, _ = rag.score_emotions(text)
    pairs = rag.detect_ambivalence(ranked)
    assert any(set(p["between"]) == {"tension", "warmth"} for p in pairs), (
        f"expected tension/warmth ambivalence, got {pairs}"
    )


def test_texture_detects_dialogue_and_kinetic():
    text = 'He said nothing. She asked again. He shouted, then ran and sprinted away.'
    texture = rag.score_texture(text)
    assert "dialogue_driven" in texture
    assert "kinetic" in texture


def test_retrieval_prefers_the_matching_register():
    class Chapter:
        def __init__(self, id, title, content):
            self.id, self.title, self.content = id, title, content

    chapters = [
        Chapter(1, "Quiet", "She smiled, warm and gentle, and laughed softly with her friend."),
        Chapter(2, "Dread", "Terror gripped him. Dread and fear and trembling, a cold threat in the dark."),
        Chapter(3, "Market", "The market smelled of bread and the bright colour of fabric."),
    ]
    index = rag.index_chapters(chapters)
    assert index, "index should contain passages"

    query = "Cold dread filled the room and she trembled with fear."
    results = rag.retrieve(query, index, top_k=2)

    assert results
    assert results[0]["chapter_title"] == "Dread", (
        f"expected the fear passage first, got {results[0]['chapter_title']}"
    )


def test_retrieval_is_empty_without_a_corpus():
    assert rag.retrieve("anything", []) == []


def test_profile_reports_samples_and_registers():
    class Chapter:
        def __init__(self, id, title, content):
            self.id, self.title, self.content = id, title, content

    chapters = [
        Chapter(1, "A", "She wept and wept, grief and sorrow and tears." * 3),
        Chapter(2, "B", "He smiled, warm and gentle and kind." * 3),
    ]
    result = rag.profile(chapters)
    assert result["samples"] >= 2
    assert result["registers"], "profile should rank at least one register"
    assert {"grief", "warmth"} & {r["register"] for r in result["registers"]}


def test_cited_passages_only_keeps_known_tags():
    class Chapter:
        def __init__(self):
            self.id, self.title, self.content = 1, "One", "x"

    index = rag.index_chapters([Chapter()])
    passages = rag.retrieve("x", index, top_k=2)

    cited = rag.cited_passages("As shown in [P1] and also [P9] which does not exist.", passages)
    assert [c["tag"] for c in cited] == ["P1"]


def test_evidence_block_tags_are_sequential():
    class Chapter:
        def __init__(self):
            self.id, self.title, self.content = 1, "One", "x"

    index = rag.index_chapters([Chapter()])
    passages = rag.retrieve("x", index, top_k=3)
    block = rag.build_evidence_block(passages)
    if passages:
        assert "[P1]" in block


# --- endpoint tests --------------------------------------------------------

@pytest.fixture()
def novel_with_chapters(client, session_factory):
    """Give the signed-in user a novel containing a few emotional chapters."""
    with session_factory() as db:
        novel = db.query(app_module.Novel).first()
        db.add_all([
            app_module.Chapter(
                title="The Gate",
                content=("Terror gripped him. Dread and fear, a cold trembling "
                         "threat in the dark. He was afraid. ") * 4,
                novel_id=novel.id,
            ),
            app_module.Chapter(
                title="The Hearth",
                content=("She smiled, warm and gentle, and laughed with her friend. "
                         "A soft and kind comfort, safe at home. ") * 4,
                novel_id=novel.id,
            ),
            app_module.Chapter(
                title="The Sky",
                content=("The stars were vast and ancient, a shimmering wonder. "
                         "Radiant and beautiful, endless above. ") * 4,
                novel_id=novel.id,
            ),
        ])
        db.commit()
        return novel.id


def test_endpoint_returns_local_reading_and_retrieval(client, novel_with_chapters, monkeypatch):
    seen = {}

    def fake_ask(instructions, user_input):
        seen["prompt"] = user_input
        seen["instructions"] = instructions
        return "## What this passage is doing\nFear.\n\n## How you have written this before\n[P1] does it."

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)

    body = client.post("/api/ai/emotion-rag", json={
        "text": "Dread crawled through her. She was afraid and trembling.",
        "novel_id": novel_with_chapters,
    }).json()

    assert body["result"]
    assert body["local"]["registers"], "local reading must be present"
    assert body["local"]["registers"][0]["register"] == "tension"
    assert body["retrieval"]["corpus_chapters"] == 3
    assert body["retrieval"]["corpus_passages"] >= 3
    assert body["retrieval"]["passages"], "passages should be retrieved"
    assert body["retrieval"]["passages"][0]["chapter_title"] == "The Gate"
    assert body["profile"]["registers"]

    # The prompt the model received must actually contain the retrieved text.
    assert "RETRIEVED PASSAGES" in seen["prompt"]
    assert "Terror gripped him" in seen["prompt"]


def test_endpoint_cites_only_real_passages(client, novel_with_chapters, monkeypatch):
    def fake_ask(instructions, user_input):
        return "See [P1] and [P99], which was never retrieved."

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)

    body = client.post("/api/ai/emotion-rag", json={
        "text": "Dread and fear filled the cold room.",
        "novel_id": novel_with_chapters,
    }).json()

    tags = [c["tag"] for c in body["citations"]]
    assert tags == ["P1"], f"only retrieved passages may be cited, got {tags}"


def test_endpoint_works_without_saved_chapters(client, monkeypatch):
    """A brand-new novel must degrade gracefully, not fail."""
    def fake_ask(instructions, user_input):
        raise AssertionError("the model must not be called with nothing to retrieve")

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)

    body = client.post("/api/ai/emotion-rag", json={
        "text": "She was afraid, and the fear was cold.",
    }).json()

    assert body["result"] is None
    assert body["local"]["registers"][0]["register"] == "tension"
    assert body["retrieval"]["corpus_passages"] == 0
    assert "No saved chapters" in body["note"]


def test_endpoint_rejects_blank_text(client, novel_with_chapters):
    assert client.post("/api/ai/emotion-rag", json={
        "text": "   ", "novel_id": novel_with_chapters,
    }).status_code == 422


def test_endpoint_requires_authentication(novel_with_chapters):
    anonymous = TestClient(app_module.app)
    response = anonymous.post("/api/ai/emotion-rag", json={"text": "Dread."})
    assert response.status_code == 401


def test_endpoint_respects_top_k(client, novel_with_chapters, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u: "ok")
    body = client.post("/api/ai/emotion-rag", json={
        "text": "Dread and fear.",
        "novel_id": novel_with_chapters,
        "top_k": 2,
    }).json()
    assert len(body["retrieval"]["passages"]) <= 2
