from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.main as app_module


@pytest.fixture()
def client(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    app_module.Base.metadata.create_all(bind=engine)
    with TestingSession() as db:
        db.add(app_module.Novel(id=1, title="Test Novel"))
        db.commit()

    monkeypatch.setattr(app_module, "engine", engine)
    monkeypatch.setattr(app_module, "SessionLocal", TestingSession)
    return TestClient(app_module.app)


def test_rejects_blank_and_null_inputs_across_creates(client):
    assert client.post("/api/chapters", json={"title": "   ", "content": "ok"}).status_code == 422
    assert client.post("/api/chapters", json={"title": "Ch 1", "content": None}).status_code == 422
    assert client.post("/api/memories", json={"name": "", "category": "General"}).status_code == 422
    assert client.post("/api/memories", json={"name": "Lore", "category": "   "}).status_code == 422
    assert client.post("/api/memories", json={"name": "Lore", "description": None}).status_code == 422
    assert client.post("/api/characters", json={"name": "\t\n"}).status_code == 422
    assert client.post("/api/characters", json={"name": "Hero", "personality": None}).status_code == 422
    for ai_route in ("grammar", "consistency", "enrich", "story", "character"):
        assert client.post(f"/api/ai/{ai_route}", json={"text": "   "}).status_code == 422
        assert client.post(f"/api/ai/{ai_route}", json={"text": "Valid", "novel_id": 0}).status_code == 422
        assert client.post(f"/api/ai/{ai_route}", json={"text": "Valid", "novel_id": 999}).status_code == 404


def test_rejects_null_and_empty_updates_and_preserves_partial_fields(client):
    ch_id = client.post("/api/chapters", json={"title": "Chapter 1", "content": "Keep body"}).json()["id"]
    mem_id = client.post("/api/memories", json={"name": "Eldoria", "category": "Kingdom", "description": "Ancient"}).json()["id"]
    char_id = client.post("/api/characters", json={"name": "Aria", "personality": "Brave", "description": "Mage"}).json()["id"]

    # Null values and empty objects must return 422 (never 500 IntegrityError or wipe data)
    for url in (f"/api/chapters/{ch_id}", f"/api/memories/{mem_id}", f"/api/characters/{char_id}"):
        assert client.put(url, json={}).status_code == 422
        assert client.put(url, json={"unknown_field": "x"}).status_code == 422

    assert client.put(f"/api/chapters/{ch_id}", json={"title": None}).status_code == 422
    assert client.put(f"/api/chapters/{ch_id}", json={"title": "   "}).status_code == 422
    assert client.put(f"/api/chapters/{ch_id}", json={"content": None}).status_code == 422
    assert client.put(f"/api/memories/{mem_id}", json={"name": None}).status_code == 422
    assert client.put(f"/api/memories/{mem_id}", json={"category": None}).status_code == 422
    assert client.put(f"/api/characters/{char_id}", json={"name": None}).status_code == 422
    assert client.put(f"/api/characters/{char_id}", json={"personality": None}).status_code == 422

    # Partial updates preserve omitted fields (including chapter content!)
    assert client.put(f"/api/chapters/{ch_id}", json={"title": "Renamed"}).status_code == 200
    assert client.get(f"/api/chapters/{ch_id}").json() == {"id": ch_id, "title": "Renamed", "content": "Keep body"}


def test_idempotent_retries_prevent_duplicates_on_lost_responses(client):
    headers = {"Idempotency-Key": "draft-key-001"}
    r1 = client.post("/api/chapters", json={"title": "Chapter 1", "content": "Draft v1"}, headers=headers)
    r2 = client.post("/api/chapters", json={"title": "Chapter 1", "content": "Draft v2"}, headers=headers)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]
    chapters = client.get("/api/chapters").json()
    assert len(chapters) == 1
    assert chapters[0]["content"] == "Draft v2"

    # Cross-endpoint reuse of the same key is rejected
    assert client.post("/api/memories", json={"name": "City"}, headers=headers).status_code == 409
    assert client.post("/api/chapters", json={"title": "Ch"}, headers={"Idempotency-Key": "   "}).status_code == 422

    # Idempotent delete retry succeeds cleanly after lost delete response
    del_headers = {"Idempotency-Key": "del-key-001"}
    assert client.delete(f"/api/chapters/{r1.json()['id']}", headers=del_headers).status_code == 200
    assert client.delete(f"/api/chapters/{r1.json()['id']}", headers=del_headers).status_code == 200
    assert client.delete(f"/api/chapters/{r1.json()['id']}").status_code == 404
