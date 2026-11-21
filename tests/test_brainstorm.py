"""Tests for interactive story brainstorming."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.main as app_module



def test_explore_mode_asks_for_questions(client, monkeypatch):
    seen = {}

    def fake_ask(instructions, user_input, novel_id=1):
        seen["instructions"] = instructions
        seen["prompt"] = user_input
        return "directions"

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)
    body = client.post("/api/ai/story", json={"text": "Ash stands at the gate."}).json()

    assert body["mode"] == "explore"
    assert "Questions to explore" in seen["instructions"]
    # The refine-only wording must not leak into the first pass.
    assert "already seen a set of possible directions" not in seen["instructions"]


def test_direction_switches_endpoint_into_refine_mode(client, monkeypatch):
    seen = {}

    def fake_ask(instructions, user_input, novel_id=1):
        seen["instructions"] = instructions
        seen["prompt"] = user_input
        return "refined"

    monkeypatch.setattr(app_module, "ask_ai", fake_ask)
    body = client.post("/api/ai/story", json={
        "text": "Ash stands at the gate.",
        "direction": "- The betrayal happens early\nAuthor's decisions and answers:\nBefore the festival"
    }).json()

    assert body["mode"] == "refined"
    assert "already seen a set of possible directions" in seen["instructions"]
    assert "The betrayal happens early" in seen["prompt"]
    assert "Before the festival" in seen["prompt"]


def test_blank_direction_stays_in_explore_mode(client, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "x")
    body = client.post("/api/ai/story", json={
        "text": "Situation.", "direction": "   "
    }).json()
    assert body["mode"] == "explore"


def test_direction_length_is_bounded(client, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "x")
    too_long = "a" * 4001
    response = client.post("/api/ai/story", json={"text": "Sit.", "direction": too_long})
    assert response.status_code == 422


def test_null_direction_is_rejected(client, monkeypatch):
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: "x")
    assert client.post("/api/ai/story", json={"text": "Sit.", "direction": None}).status_code == 422


def test_other_assistants_ignore_direction(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(app_module, "ask_ai", lambda i, u, n=1: seen.setdefault("prompt", u) or "x")
    client.post("/api/ai/grammar", json={"text": "Prose.", "direction": "- something"})
    assert "already seen a set of possible directions" not in seen["prompt"]
    assert "something" not in seen["prompt"]
