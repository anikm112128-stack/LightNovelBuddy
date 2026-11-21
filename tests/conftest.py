"""Shared test fixtures.

Every data route now requires an authenticated owner, so the fixtures here
build an in-memory database, register a real user through the public API,
log in for a real bearer token, and seed one novel owned by that user.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.main as app_module

TEST_EMAIL = "writer@example.com"
TEST_PASSWORD = "correcthorsebattery"


@pytest.fixture()
def session_factory(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    app_module.Base.metadata.create_all(bind=engine)

    monkeypatch.setattr(app_module, "engine", engine)
    monkeypatch.setattr(app_module, "SessionLocal", TestingSession)

    # The routers were built at import time and hold their own reference to
    # SessionLocal, so route dependencies are redirected through FastAPI's
    # override mechanism rather than by patching the module attribute.
    def override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app_module.app.dependency_overrides[app_module.auth_get_db] = override_get_db
    try:
        yield TestingSession
    finally:
        app_module.app.dependency_overrides.pop(app_module.auth_get_db, None)


@pytest.fixture()
def client(session_factory):
    factory = session_factory
    with TestClient(app_module.app) as test_client:
        registered = test_client.post(
            "/api/auth/register",
            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
        )
        assert registered.status_code == 201, registered.text
        user_id = registered.json()["id"]

        login = test_client.post(
            "/api/auth/login",
            data={"username": TEST_EMAIL, "password": TEST_PASSWORD},
        )
        assert login.status_code == 200, login.text
        test_client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"

        # Seed the novel after the user exists so ownership is unambiguous.
        with factory() as db:
            db.add(app_module.Novel(id=1, title="Test Novel", owner_id=user_id))
            db.commit()

        yield test_client
