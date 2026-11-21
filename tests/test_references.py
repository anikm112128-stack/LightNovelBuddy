"""Tests for consistency references: labelled context and citation resolution."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.main as app_module



@pytest.fixture(autouse=True)
def seed_lore(session_factory, client):
    with session_factory() as db:
        db.add(app_module.MemoryEntry(id=12, name="Oakhaven", category="Kingdom",
                                      description="A forest kingdom.", novel_id=1))
        db.add(app_module.Character(id=3, name="Ash", personality="Quiet",
                                    description="A mage.", novel_id=1))
        db.add(app_module.Chapter(id=5, title="Arrival", content="It rained.", novel_id=1))
        db.commit()



def test_labelled_context_only_for_consistency(client, monkeypatch):
    """The other assistants must keep sending unlabelled context."""
    seen = {}

    def fake_ask(instructions, user_input, novel_id=1):
        seen["prompt"] = user_input
        return "ok"

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)

    for route in ("grammar", "enrich", "story", "character"):
        client.post(f"/api/ai/{route}", json={"text": "Some prose."})
        assert "[W12]" not in seen["prompt"], f"{route} leaked reference tags"
        assert "[C3]" not in seen["prompt"], f"{route} leaked reference tags"

    client.post("/api/ai/consistency", json={"text": "Some prose."})
    assert "[W12]" in seen["prompt"], "consistency should label world entries"
    assert "[C3]" in seen["prompt"], "consistency should label characters"
    assert "[CH5]" in seen["prompt"], "consistency should label chapters"


def test_consistency_returns_resolved_references(client, monkeypatch):
    monkeypatch.setattr(
        app_module, "ask_ai",
        lambda i, u, n=1: "Issue at [W12]. Also conflicts with [C3] and [CH5].",
    )
    body = client.post("/api/ai/consistency", json={"text": "Prose."}).json()
    tags = [r["tag"] for r in body["references"]]
    assert tags == ["W12", "C3", "CH5"]
    assert body["references"][0]["title"] == "Oakhaven"
    assert body["references"][1]["kind"] == "character"
    assert body["references"][2]["kind"] == "chapter"


def test_hallucinated_and_unknown_tags_are_dropped(client, monkeypatch):
    monkeypatch.setattr(
        app_module, "ask_ai",
        lambda i, u, n=1: "See [W999] and [C77] but also [W12].",
    )
    body = client.post("/api/ai/consistency", json={"text": "Prose."}).json()
    assert [r["tag"] for r in body["references"]] == ["W12"]


def test_no_citations_yields_empty_references_not_an_error(client, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "No issues found.")
    response = client.post("/api/ai/consistency", json={"text": "Prose."})
    assert response.status_code == 200
    assert response.json()["references"] == []
    assert response.json()["result"] == "No issues found."


def test_cross_endpoint_response_shape_unchanged(client, monkeypatch):
    """Only the consistency and story endpoints may extend the original shape.

    Grammar, description and character still return exactly {"result"}; story
    gained "mode" when interactive brainstorming was added.
    """
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "text")
    for route in ("grammar", "enrich", "character"):
        body = client.post(f"/api/ai/{route}", json={"text": "Prose."}).json()
        assert set(body.keys()) == {"result"}, f"{route} response shape changed"

    story = client.post("/api/ai/story", json={"text": "Prose."}).json()
    assert set(story.keys()) == {"result", "mode"}, "story shape changed unexpectedly"
    assert story["mode"] == "explore"


def test_chapter_tag_not_misread_as_character(client, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "See [CH5].")
    body = client.post("/api/ai/consistency", json={"text": "Prose."}).json()
    assert [r["tag"] for r in body["references"]] == ["CH5"]
    assert body["references"][0]["kind"] == "chapter"
