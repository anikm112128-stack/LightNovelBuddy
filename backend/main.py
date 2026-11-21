
import os
import re
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy import (
    create_engine, Column, Integer, String, Text,
    ForeignKey, inspect, text
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from adaption import Adaption

try:  # imported as part of a package (uvicorn backend.main:app)
    from .auth import build_auth_models, make_auth_router, get_owned_novel
    from .novels import make_novel_router
    from .emotion_rag import (
        build_evidence_block, cited_passages, detect_ambivalence,
        index_chapters, profile, retrieve, score_emotions, score_texture,
        split_passages,
    )
except ImportError:  # run from inside backend/
    from auth import build_auth_models, make_auth_router, get_owned_novel
    from novels import make_novel_router
    from emotion_rag import (
        build_evidence_block, cited_passages, detect_ambivalence,
        index_chapters, profile, retrieve, score_emotions, score_texture,
        split_passages,
    )


# ==================================================
# 1. CONFIGURATION
# ==================================================

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_KEY = os.getenv("ADAPTION_API_KEY")
MODEL = os.getenv("ADAPTION_MODEL", "qwen3.5-397b")

DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{BASE_DIR / 'database.db'}"
if DATABASE_URL.startswith("postgres://"):
    # Render and Heroku still hand out the legacy scheme; SQLAlchemy needs postgresql://.
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

DEFAULT_ORIGINS = [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://lightnovelbuddyf.onrender.com",
]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
] or DEFAULT_ORIGINS

engine_options = {"pool_pre_ping": True}

if DATABASE_URL.startswith("sqlite"):
    # check_same_thread is SQLite-only; psycopg rejects it as a connection option.
    engine_options["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_options)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


# ==================================================
# 2. AUTHENTICATION DATABASE MODELS
# ==================================================

User, RefreshSession = build_auth_models(Base)


# ==================================================
# 3. APPLICATION DATABASE MODELS
# ==================================================

class Novel(Base):
    __tablename__ = "novels"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, default="My Novel")

    owner_id = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=True,
        index=True
    )

    chapters = relationship(
        "Chapter",
        back_populates="novel",
        cascade="all, delete-orphan"
    )

    memories = relationship(
        "MemoryEntry",
        back_populates="novel",
        cascade="all, delete-orphan"
    )

    characters = relationship(
        "Character",
        back_populates="novel",
        cascade="all, delete-orphan"
    )


class Chapter(Base):
    __tablename__ = "chapters"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    content = Column(Text, default="")

    novel_id = Column(
        Integer,
        ForeignKey("novels.id")
    )

    novel = relationship(
        "Novel",
        back_populates="chapters"
    )


class MemoryEntry(Base):
    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    category = Column(String, default="General")
    description = Column(Text, default="")

    novel_id = Column(
        Integer,
        ForeignKey("novels.id")
    )

    novel = relationship(
        "Novel",
        back_populates="memories"
    )


class Character(Base):
    __tablename__ = "characters"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    personality = Column(Text, default="")
    description = Column(Text, default="")

    novel_id = Column(
        Integer,
        ForeignKey("novels.id")
    )

    novel = relationship(
        "Novel",
        back_populates="characters"
    )

class StoryThread(Base):
    __tablename__ = "story_threads"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    first_appearance = Column(String, default="")
    status = Column(String, default="planted")
    notes = Column(Text, default="")

    novel_id = Column(
        Integer,
        ForeignKey("novels.id"),
        nullable=False,
        index=True
    )


class CharacterRelationship(Base):
    __tablename__ = "character_relationships"

    id = Column(Integer, primary_key=True, index=True)

    novel_id = Column(
        Integer,
        ForeignKey("novels.id"),
        nullable=False,
        index=True
    )

    from_character_id = Column(
        Integer,
        ForeignKey("characters.id"),
        nullable=False
    )

    to_character_id = Column(
        Integer,
        ForeignKey("characters.id"),
        nullable=False
    )

    relationship_type = Column(String, nullable=False)
    notes = Column(Text, default="")


class IdempotencyRecord(Base):
    """Remembers a create that already happened, so a retried request
    returns the original row instead of inserting a duplicate."""

    __tablename__ = "idempotency_records"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(128), nullable=False, unique=True, index=True)
    endpoint = Column(String(120), nullable=False)
    resource_id = Column(Integer, nullable=False)
    created_at = Column(Integer, nullable=False, default=lambda: int(time.time()))


Base.metadata.create_all(bind=engine)


# ==================================================
# 4. EXISTING DATABASE MIGRATION
# ==================================================

# Add owner_id to existing SQLite databases without
# deleting chapters, memories, characters or novels.

if DATABASE_URL.startswith("sqlite"):

    inspector = inspect(engine)

    if "novels" in inspector.get_table_names():

        columns = {
            column["name"]
            for column in inspector.get_columns("novels")
        }

        if "owner_id" not in columns:

            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE novels "
                        "ADD COLUMN owner_id INTEGER REFERENCES users(id)"
                    )
                )


# ==================================================
# 5. FASTAPI APPLICATION
# ==================================================

app = FastAPI(
    title="Light Novel Buddy API",
    description="AI writing companion for light novel authors",
    version="2.1"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ==================================================
# 6. AUTHENTICATION ROUTES
# ==================================================

auth_router, User, base_get_current_user, auth_get_db = (
    make_auth_router(User, RefreshSession, lambda: SessionLocal())
)


def get_current_user(user=Depends(base_get_current_user)):

    # Legacy data is assigned only to the email
    # explicitly configured by the application owner.

    initial_email = os.getenv(
        "INITIAL_OWNER_EMAIL",
        ""
    ).strip().lower()

    if initial_email and user.email.lower() == initial_email:

        with SessionLocal() as db:

            legacy_novels = db.query(Novel).filter(
                Novel.owner_id.is_(None)
            ).all()

            if legacy_novels:

                for novel in legacy_novels:
                    novel.owner_id = user.id

                db.commit()

    return user


app.include_router(auth_router)


# ==================================================
# 7. MULTI-NOVEL ROUTES
# ==================================================

app.include_router(
    make_novel_router(
        lambda: SessionLocal(),
        Novel,
        get_current_user
    )
)


# ==================================================
# 8. REQUEST SCHEMAS
# ==================================================

class ChapterInput(BaseModel):
    title: str
    content: str = ""
    novel_id: Optional[int] = None

    @field_validator("title", mode="before")
    @classmethod
    def check_title(cls, v): return _clean_text(v, "Title", required=True, max_len=200)

    @field_validator("content", mode="before")
    @classmethod
    def check_content(cls, v): return _clean_text(v, "Content", required=True, max_len=1_000_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class ChapterUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    novel_id: Optional[int] = None

    @field_validator("title", mode="before")
    @classmethod
    def check_title(cls, v): return _clean_text(v, "Title", required=True, max_len=200)

    @field_validator("content", mode="before")
    @classmethod
    def check_content(cls, v): return _clean_text(v, "Content", required=True, max_len=1_000_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class MemoryInput(BaseModel):
    name: str
    category: str = "General"
    description: str = ""
    novel_id: Optional[int] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Name", required=True, max_len=200)

    @field_validator("category", mode="before")
    @classmethod
    def check_category(cls, v): return _clean_text(v, "Category", required=True, max_len=120)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", required=True, max_len=20_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class MemoryUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Name", required=True, max_len=200)

    @field_validator("category", mode="before")
    @classmethod
    def check_category(cls, v): return _clean_text(v, "Category", required=True, max_len=120)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", required=True, max_len=20_000)


class CharacterInput(BaseModel):
    name: str
    personality: str = ""
    description: str = ""
    novel_id: Optional[int] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Name", required=True, max_len=200)

    @field_validator("personality", mode="before")
    @classmethod
    def check_personality(cls, v): return _clean_text(v, "Personality", required=True, max_len=20_000)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", required=True, max_len=20_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    personality: Optional[str] = None
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Name", required=True, max_len=200)

    @field_validator("personality", mode="before")
    @classmethod
    def check_personality(cls, v): return _clean_text(v, "Personality", required=True, max_len=20_000)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", required=True, max_len=20_000)


class AIInput(BaseModel):
    text: str
    novel_id: Optional[int] = None
    style: str = ""
    direction: str = ""
    idea: str = ""

    @field_validator("text", mode="before")
    @classmethod
    def check_text(cls, v): return _clean_text(v, "Text", required=True, max_len=100_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)

    @field_validator("style", mode="before")
    @classmethod
    def check_style(cls, v): return _clean_text(v, "Style", strip=True, max_len=200)

    @field_validator("direction", mode="before")
    @classmethod
    def check_direction(cls, v): return _clean_text(v, "Direction", strip=True, max_len=4_000)

    @field_validator("idea", mode="before")
    @classmethod
    def check_idea(cls, v): return _clean_text(v, "Idea", strip=True, max_len=2_000)


# --------------------------------------------------
# 5. DATABASE HELPERS
# --------------------------------------------------

def _clean_text(value, label, *, required=False, strip=False, max_len=None):
    """Reject null/blank payloads instead of storing them.

    Used from pydantic validators so every create and update route answers
    with a 422 rather than a 500 IntegrityError or a silently wiped column.
    """
    if value is None:
        if required:
            raise ValueError(f"{label} is required.")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    cleaned = value.strip() if strip else value
    if required and not cleaned.strip():
        raise ValueError(f"{label} cannot be blank.")
    if max_len is not None and len(cleaned) > max_len:
        raise ValueError(f"{label} must be at most {max_len} characters.")
    return cleaned


def _clean_novel_id(value):
    """Novel ids are optional, but when supplied they must be a positive int."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("novel_id must be an integer.")
    if value < 1:
        raise ValueError("novel_id must be a positive integer.")
    return value


def normalize_idempotency_key(raw_key: Optional[str]) -> Optional[str]:
    if raw_key is None:
        return None
    cleaned = raw_key.strip()
    if not cleaned or len(cleaned) > 128 or "\x00" in raw_key:
        raise HTTPException(status_code=422, detail="Invalid Idempotency-Key header.")
    return cleaned


def save_with_idempotency(db, *, key: Optional[str], endpoint: str, model_cls, create_kwargs: dict, update_fields: dict, message: str):
    now = int(time.time())
    if key:
        db.query(IdempotencyRecord).filter(IdempotencyRecord.created_at < now - 7 * 86400).delete(synchronize_session=False)
        existing = db.query(IdempotencyRecord).filter(IdempotencyRecord.key == key).first()
        if existing:
            if existing.endpoint != endpoint:
                raise HTTPException(status_code=409, detail="Idempotency-Key already used for another endpoint.")
            item = db.query(model_cls).filter(model_cls.id == existing.resource_id).first()
            if item:
                for attr, val in update_fields.items():
                    setattr(item, attr, val)
                db.commit()
                return {"message": message, "id": item.id}
            db.delete(existing)
            db.flush()

    item = model_cls(**create_kwargs)
    db.add(item)
    db.flush()

    if key:
        db.add(IdempotencyRecord(
            key=key,
            endpoint=endpoint,
            resource_id=item.id,
            created_at=now,
        ))

    db.commit()
    db.refresh(item)

    return {"message": message, "id": item.id}


class StoryThreadInput(BaseModel):
    title: str
    first_appearance: str = ""
    status: str = "planted"
    notes: str = ""
    novel_id: Optional[int] = None


class StoryThreadUpdate(BaseModel):
    title: Optional[str] = None
    first_appearance: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class RelationshipInput(BaseModel):
    from_character_id: int
    to_character_id: int
    relationship_type: str
    notes: str = ""
    novel_id: Optional[int] = None


class NarrativeDNAInput(BaseModel):
    text: str = ""
    novel_id: Optional[int] = None
    scope: str = "excerpt"
    focus: str = "full"


class EmotionRAGInput(BaseModel):
    """A passage of new writing, to be read against the author's saved work."""

    text: str
    novel_id: Optional[int] = None
    top_k: int = 4

    @field_validator("text", mode="before")
    @classmethod
    def check_text(cls, v): return _clean_text(v, "Text", required=True, max_len=20_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)

    @field_validator("top_k", mode="before")
    @classmethod
    def check_top_k(cls, v):
        if v is None:
            return 4
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("top_k must be an integer.")
        return max(1, min(v, 8))

# ==================================================
# 9. OWNERSHIP HELPERS
# ==================================================

def resolve_novel(db, user, novel_id=None):

    if novel_id is not None:

        return get_owned_novel(
            db,
            Novel,
            novel_id,
            user.id
        )

    novel = db.query(Novel).filter(
        Novel.owner_id == user.id
    ).order_by(
        Novel.id.asc()
    ).first()

    if not novel:
        raise HTTPException(
            404,
            "No novel found. Create a novel first."
        )

    return novel


def get_owned_record(db, model, record_id, user, label):

    record = db.query(model).filter(
        model.id == record_id
    ).first()

    if not record:
        raise HTTPException(
            404,
            f"{label} not found."
        )

    get_owned_novel(
        db,
        Novel,
        record.novel_id,
        user.id
    )

    return record


def build_world_context(db, novel_id, *, label=False):
    """Collect saved lore and recent chapters for AI context.

    Returns (context_text, references). When ``label`` is true each block is
    prefixed with a stable tag such as [W12], [C3] or [CH5] and the matching
    reference metadata is returned so a caller can resolve what the model cites.
    """

    refs = {}

    memories = db.query(MemoryEntry).filter(
        MemoryEntry.novel_id == novel_id
    ).all()

    characters = db.query(Character).filter(
        Character.novel_id == novel_id
    ).all()

    chapters = db.query(Chapter).filter(
        Chapter.novel_id == novel_id
    ).order_by(
        Chapter.id.desc()
    ).limit(10).all()

    def tag(prefix, identifier):
        return f"[{prefix}{identifier}] " if label else ""

    parts = ["ESTABLISHED WORLD INFORMATION:"]

    for item in memories:

        if label:
            refs[f"W{item.id}"] = {
                "tag": f"W{item.id}",
                "kind": "world",
                "id": item.id,
                "title": item.name,
                "category": item.category,
            }

        parts.append(
            tag("W", item.id) +
            f"{item.category}: {item.name}\n"
            f"{item.description}"
        )

    parts.append("\nCHARACTERS:")

    for character in characters:

        if label:
            refs[f"C{character.id}"] = {
                "tag": f"C{character.id}",
                "kind": "character",
                "id": character.id,
                "title": character.name,
                "category": "Character",
            }

        parts.append(
            tag("C", character.id) +
            f"Name: {character.name}\n"
            f"Personality: {character.personality}\n"
            f"Details: {character.description}"
        )

    parts.append("\nRECENT CHAPTERS:")

    for chapter in reversed(chapters):

        if label:
            refs[f"CH{chapter.id}"] = {
                "tag": f"CH{chapter.id}",
                "kind": "chapter",
                "id": chapter.id,
                "title": chapter.title,
                "category": "Chapter",
            }

        parts.append(
            tag("CH", chapter.id) +
            f"{chapter.title}:\n"
            f"{(chapter.content or '')[-2500:]}"
        )

    return "\n\n".join(parts), refs


def get_world_context(db, novel_id):
    """Unlabelled context, ignoring the reference map."""

    context, _ = build_world_context(db, novel_id)

    return context


# --------------------------------------------------
# 5b. REFERENCE RESOLUTION
# --------------------------------------------------

# Models sometimes cite a tag that was never in the prompt, or write [W12] as
# W12 / (W12). Resolve defensively and drop anything that does not correspond to
# a record the request actually sent, so a hallucinated citation never reaches
# the author.

_REF_PATTERN = re.compile(r"\[?\b(W|C|CH)(\d+)\b\]?", re.IGNORECASE)


def extract_reference_tags(text: str, known: dict) -> list:
    """Return the tags cited in ``text`` that exist in ``known``, in first-seen order."""
    if not isinstance(text, str) or not text:
        return []

    found = []
    for prefix, identifier in _REF_PATTERN.findall(text):
        # CH must not be read as C when the model writes CH5.
        candidate = f"{prefix.upper()}{identifier}"
        if candidate in known and candidate not in found:
            found.append(candidate)
    return found


def reference_payload(tags: list, known: dict) -> list:
    return [known[tag] for tag in tags if tag in known]

# 11. ADAPTION AI CONNECTION
# ==================================================

def ask_ai(instructions, user_input):

    if not API_KEY:

        raise HTTPException(
            500,
            "ADAPTION_API_KEY is missing from backend/.env"
        )

    try:

        client = Adaption(api_key=API_KEY)

        response = client.responses.create(
            model=MODEL,
            instructions=instructions,
            input=user_input
        )

        result = response.output_text

        if not result:
            raise ValueError("The AI returned an empty response.")

        return result

    except HTTPException:
        raise

    except Exception as error:

        print("ADAPTION ERROR:", repr(error))

        raise HTTPException(
            502,
            "Adaption API request failed."
        )


def ai_context(db, user, novel_id):

    novel = resolve_novel(
        db,
        user,
        novel_id
    )

    return (
        novel.id,
        get_world_context(db, novel.id)
    )


# ==================================================
# 12. PUBLIC ROUTES
# ==================================================

@app.get("/")
def home():

    return {
        "message": "Welcome to Light Novel Buddy API",
        "version": "2.1"
    }


@app.get("/api/health")
def health():

    return {
        "status": "online",
        "adaption_key_configured": bool(API_KEY),
        "model": MODEL
    }


# ==================================================
# 13. NOVEL AND DASHBOARD
# ==================================================

@app.get("/api/novel")
def get_novel_info(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            novel_id
        )

        return {
            "id": novel.id,
            "title": novel.title
        }


@app.get("/api/dashboard")
def dashboard(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            novel_id
        )

        chapters = db.query(Chapter).filter(
            Chapter.novel_id == novel.id
        ).all()

        characters = db.query(Character).filter(
            Character.novel_id == novel.id
        ).count()

        memories = db.query(MemoryEntry).filter(
            MemoryEntry.novel_id == novel.id
        ).count()

        total_words = sum(
            len((chapter.content or "").split())
            for chapter in chapters
        )

        return {
            "chapters": len(chapters),
            "words": total_words,
            "characters": characters,
            "memories": memories
        }


# ==================================================
# 14. CHAPTER ROUTES
# ==================================================

@app.get("/api/chapters")
def list_chapters(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(db, user, novel_id)

        chapters = db.query(Chapter).filter(
            Chapter.novel_id == novel.id
        ).order_by(
            Chapter.id.desc()
        ).all()

        return [
            {
                "id": c.id,
                "title": c.title,
                "content": c.content
            }
            for c in chapters
        ]


@app.post("/api/chapters")
def create_chapter(
    data: ChapterInput,
    user=Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):

    idempotency_key = normalize_idempotency_key(idempotency_key)

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        return save_with_idempotency(
            db,
            key=idempotency_key,
            endpoint="chapters",
            model_cls=Chapter,
            create_kwargs={
                "title": data.title,
                "content": data.content,
                "novel_id": novel.id,
            },
            update_fields={
                "title": data.title,
                "content": data.content,
            },
            message="Chapter saved",
        )


@app.get("/api/chapters/{chapter_id}")
def get_chapter(
    chapter_id: int,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        chapter = get_owned_record(
            db,
            Chapter,
            chapter_id,
            user,
            "Chapter"
        )

        return {
            "id": chapter.id,
            "title": chapter.title,
            "content": chapter.content
        }


@app.put("/api/chapters/{chapter_id}")
def update_chapter(
    chapter_id: int,
    data: ChapterUpdate,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        chapter = get_owned_record(
            db,
            Chapter,
            chapter_id,
            user,
            "Chapter"
        )

        if data.novel_id is not None and data.novel_id != chapter.novel_id:

            get_owned_novel(
                db,
                Novel,
                data.novel_id,
                user.id
            )

            chapter.novel_id = data.novel_id

        updates = data.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(
                422,
                "No fields to update."
            )

        for key, value in updates.items():
            setattr(chapter, key, value)

        db.commit()

        return {
            "message": "Chapter updated"
        }


@app.delete("/api/chapters/{chapter_id}")
def delete_chapter(
    chapter_id: int,
    user=Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):

    idempotency_key = normalize_idempotency_key(idempotency_key)

    with SessionLocal() as db:

        if idempotency_key:
            # A retried delete after a lost response must succeed quietly
            # instead of reporting the row as missing.
            already = db.query(IdempotencyRecord).filter(
                IdempotencyRecord.key == idempotency_key
            ).first()
            if already:
                if already.endpoint != "chapters:delete":
                    raise HTTPException(
                        409,
                        "Idempotency-Key already used for another endpoint."
                    )
                return {"message": "Chapter deleted"}

        chapter = get_owned_record(
            db,
            Chapter,
            chapter_id,
            user,
            "Chapter"
        )

        db.delete(chapter)
        db.flush()

        if idempotency_key:
            db.add(IdempotencyRecord(
                key=idempotency_key,
                endpoint="chapters:delete",
                resource_id=chapter_id,
                created_at=int(time.time()),
            ))

        db.commit()

        return {
            "message": "Chapter deleted"
        }


# ==================================================
# 15. WORLD MEMORY ROUTES
# ==================================================

@app.get("/api/memories")
def list_memories(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(db, user, novel_id)

        memories = db.query(MemoryEntry).filter(
            MemoryEntry.novel_id == novel.id
        ).all()

        return [
            {
                "id": m.id,
                "name": m.name,
                "category": m.category,
                "description": m.description
            }
            for m in memories
        ]


@app.post("/api/memories")
def create_memory(
    data: MemoryInput,
    user=Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):

    idempotency_key = normalize_idempotency_key(idempotency_key)

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        return save_with_idempotency(
            db,
            key=idempotency_key,
            endpoint="memories",
            model_cls=MemoryEntry,
            create_kwargs={
                "name": data.name,
                "category": data.category,
                "description": data.description,
                "novel_id": novel.id,
            },
            update_fields={
                "name": data.name,
                "category": data.category,
                "description": data.description,
            },
            message="World memory saved",
        )


@app.put("/api/memories/{memory_id}")
def update_memory(
    memory_id: int,
    data: MemoryUpdate,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        memory = get_owned_record(
            db,
            MemoryEntry,
            memory_id,
            user,
            "Memory"
        )

        updates = data.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(
                422,
                "No fields to update."
            )

        for key, value in updates.items():
            setattr(memory, key, value)

        db.commit()

        return {
            "message": "Memory updated"
        }


@app.delete("/api/memories/{memory_id}")
def delete_memory(
    memory_id: int,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        memory = get_owned_record(
            db,
            MemoryEntry,
            memory_id,
            user,
            "Memory"
        )

        db.delete(memory)
        db.commit()

        return {
            "message": "Memory deleted"
        }


# ==================================================
# 16. CHARACTER ROUTES
# ==================================================

@app.get("/api/characters")
def list_characters(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(db, user, novel_id)

        characters = db.query(Character).filter(
            Character.novel_id == novel.id
        ).all()

        return [
            {
                "id": c.id,
                "name": c.name,
                "personality": c.personality,
                "description": c.description
            }
            for c in characters
        ]


@app.post("/api/characters")
def create_character(
    data: CharacterInput,
    user=Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):

    idempotency_key = normalize_idempotency_key(idempotency_key)

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        return save_with_idempotency(
            db,
            key=idempotency_key,
            endpoint="characters",
            model_cls=Character,
            create_kwargs={
                "name": data.name,
                "personality": data.personality,
                "description": data.description,
                "novel_id": novel.id,
            },
            update_fields={
                "name": data.name,
                "personality": data.personality,
                "description": data.description,
            },
            message="Character added",
        )


@app.put("/api/characters/{character_id}")
def update_character(
    character_id: int,
    data: CharacterUpdate,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        character = get_owned_record(
            db,
            Character,
            character_id,
            user,
            "Character"
        )

        updates = data.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(
                422,
                "No fields to update."
            )

        for key, value in updates.items():
            setattr(character, key, value)

        db.commit()

        return {
            "message": "Character updated"
        }


@app.delete("/api/characters/{character_id}")
def delete_character(
    character_id: int,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        character = get_owned_record(
            db,
            Character,
            character_id,
            user,
            "Character"
        )

        db.delete(character)
        db.commit()

        return {
            "message": "Character deleted"
        }

# ==================================================
# 16A. CHEKHOV'S GUN TRACKER
# ==================================================

@app.get("/api/chekhov")
def list_story_threads(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        novel = resolve_novel(db, user, novel_id)

        items = db.query(StoryThread).filter(
            StoryThread.novel_id == novel.id
        ).order_by(StoryThread.id.desc()).all()

        return [
            {
                "id": item.id,
                "title": item.title,
                "first_appearance": item.first_appearance,
                "status": item.status,
                "notes": item.notes
            }
            for item in items
        ]


@app.post("/api/chekhov")
def create_story_thread(
    data: StoryThreadInput,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        novel = resolve_novel(db, user, data.novel_id)

        item = StoryThread(
            title=data.title,
            first_appearance=data.first_appearance,
            status=data.status,
            notes=data.notes,
            novel_id=novel.id
        )

        db.add(item)
        db.commit()
        db.refresh(item)

        return {"message": "Story thread added", "id": item.id}


@app.put("/api/chekhov/{thread_id}")
def update_story_thread(
    thread_id: int,
    data: StoryThreadUpdate,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        item = get_owned_record(
            db, StoryThread, thread_id, user, "Story thread"
        )

        updates = data.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(
                422,
                "No fields to update."
            )

        for key, value in updates.items():
            setattr(item, key, value)

        db.commit()

        return {"message": "Story thread updated"}


@app.delete("/api/chekhov/{thread_id}")
def delete_story_thread(
    thread_id: int,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        item = get_owned_record(
            db, StoryThread, thread_id, user, "Story thread"
        )

        db.delete(item)
        db.commit()

        return {"message": "Story thread deleted"}


# ==================================================
# 16B. CHARACTER RELATIONSHIP WEB
# ==================================================

@app.get("/api/relationships")
def list_relationships(
    novel_id: Optional[int] = None,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        novel = resolve_novel(db, user, novel_id)

        items = db.query(CharacterRelationship).filter(
            CharacterRelationship.novel_id == novel.id
        ).all()

        return [
            {
                "id": item.id,
                "from_character": item.from_character_id,
                "to_character": item.to_character_id,
                "from_name": db.query(Character).filter(
                    Character.id == item.from_character_id
                ).first().name,
                "to_name": db.query(Character).filter(
                    Character.id == item.to_character_id
                ).first().name,
                "relationship_type": item.relationship_type,
                "notes": item.notes
            }
            for item in items
        ]


@app.post("/api/relationships")
def create_relationship(
    data: RelationshipInput,
    user=Depends(get_current_user)
):
    if data.from_character_id == data.to_character_id:
        raise HTTPException(400, "A character cannot be related to itself.")

    with SessionLocal() as db:
        novel = resolve_novel(db, user, data.novel_id)

        first = get_owned_record(
            db, Character, data.from_character_id, user, "Character"
        )
        second = get_owned_record(
            db, Character, data.to_character_id, user, "Character"
        )

        if first.novel_id != novel.id or second.novel_id != novel.id:
            raise HTTPException(
                400, "Both characters must belong to the selected novel."
            )

        item = CharacterRelationship(
            novel_id=novel.id,
            from_character_id=first.id,
            to_character_id=second.id,
            relationship_type=data.relationship_type,
            notes=data.notes
        )

        db.add(item)
        db.commit()
        db.refresh(item)

        return {"message": "Relationship added", "id": item.id}


@app.delete("/api/relationships/{relationship_id}")
def delete_relationship(
    relationship_id: int,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        item = get_owned_record(
            db,
            CharacterRelationship,
            relationship_id,
            user,
            "Relationship"
        )

        db.delete(item)
        db.commit()

        return {"message": "Relationship deleted"}


# ==================================================
# 16C. NARRATIVE DNA ANALYSIS
# ==================================================

@app.post("/api/ai/narrative-dna")
def analyze_narrative_dna(
    data: NarrativeDNAInput,
    user=Depends(get_current_user)
):
    with SessionLocal() as db:
        novel = resolve_novel(db, user, data.novel_id)

        if data.scope == "novel":
            chapters = db.query(Chapter).filter(
                Chapter.novel_id == novel.id
            ).order_by(Chapter.id.asc()).all()

            source_text = "\n\n".join(
                f"{chapter.title}\n{chapter.content or ''}"
                for chapter in chapters
            )[-40000:]

            if not source_text.strip():
                raise HTTPException(400, "This novel has no chapters to analyze.")

        else:
            source_text = data.text.strip()

            if not source_text:
                raise HTTPException(400, "Please provide text to analyze.")

        context = get_world_context(db, novel.id)

    instructions = """
You are the Narrative DNA analyst for Light Novel Buddy.

Analyze the author's writing without rewriting it.

Identify patterns supported by the supplied text.
Do not invent details or make unsupported claims.

Consider:
- Writing voice and sentence structure
- Vocabulary and descriptive habits
- Dialogue patterns
- Pacing and scene transitions
- Themes and recurring motifs
- Point of view and narrative distance

Explain what is distinctive, what is consistent,
and what the author could experiment with.

Use clear headings and specific examples from the text.
"""

    prompt = f"""
ANALYSIS FOCUS: {data.focus}

ESTABLISHED STORY CONTEXT:
{context}

TEXT TO ANALYZE:
{source_text}
"""

    return {
        "result": ask_ai(instructions, prompt)
            }


# ==================================================
# 16b. AI: EMOTIONAL RAG
# ==================================================

@app.post("/api/ai/emotion-rag")
def emotion_rag(
    data: EmotionRAGInput,
    user=Depends(get_current_user)
):
    """Retrieval-augmented emotional reading.

    The model never guesses the author's feelings from the passage alone. We
    retrieve passages from their own saved chapters whose emotional register
    matches the new writing, show the model how *they* handle that feeling, and
    ask it to reason from that evidence. Every claim is expected to cite the
    retrieved passage it came from.
    """

    with SessionLocal() as db:
        novel = resolve_novel(db, user, data.novel_id)

        chapters = db.query(Chapter).filter(
            Chapter.novel_id == novel.id
        ).order_by(Chapter.id.asc()).all()

        corpus = [
            chapter for chapter in chapters
            if (chapter.content or "").strip()
        ]

        # Local measurement first: this is what the browser reports instantly,
        # and it stands on its own even if the language model is unavailable.
        query_ranked, _ = score_emotions(data.text)
        query_texture = score_texture(data.text)

        index = index_chapters(corpus)
        passages = retrieve(data.text, index, top_k=data.top_k)

        novel_profile = profile(corpus)

        local = {
            "registers": query_ranked[:5],
            "texture": query_texture,
            "ambivalence": detect_ambivalence(query_ranked),
            "dominant": [item["register"] for item in query_ranked[:2]],
            "measured_from": "lexicon + density, no model involved",
        }

        retrieval = {
            "corpus_chapters": len(corpus),
            "corpus_passages": len(index),
            "query_passages": len(split_passages(data.text)),
            "top_k": data.top_k,
            "passages": [
                {
                    "tag": f"P{position}",
                    "chapter_id": passage["chapter_id"],
                    "chapter_title": passage["chapter_title"],
                    "passage_no": passage["passage_no"],
                    "emotions": passage["emotions"],
                    "texture": passage["texture"],
                    "scores": passage["scores"],
                    "excerpt": passage["text"][:280],
                }
                for position, passage in enumerate(passages, start=1)
            ],
        }

    if not index:
        # Nothing to retrieve: report the local reading and say why.
        return {
            "result": None,
            "local": local,
            "retrieval": retrieval,
            "profile": novel_profile,
            "citations": [],
            "note": (
                "No saved chapters to retrieve from yet. The local emotional "
                "reading above is measured directly from your passage. Save a "
                "few chapters and this assistant will ground its answers in "
                "your own writing."
            ),
        }

    instructions = """
You are the emotional reader of Light Novel Buddy.

Your job is to understand how the author is feeling while writing, and to
prove it from their own work rather than from guesswork.

You are given a passage of new writing and a set of passages retrieved from
the author's own saved chapters, each tagged P1, P2, P3 and so on. Each
retrieved passage carries a measured emotional register.

Reason only from the evidence you are given.

Respond in these sections, using these headings:

## What this passage is doing
Describe the emotional register of the new writing: what feeling it carries,
how strongly, and which words carry it.

## How you have written this before
For each relevant retrieved passage, explain what it shows about how this
author handles this feeling. Cite the tag, for example [P2], and quote a short
fragment. Only cite tags that appear in the context.

## Where the feeling breaks
Point out any registers pulling against each other. If the passage is
ambivalent, say so plainly instead of picking a winner.

## The honest limit
State clearly that this is an inferred reading of the writing, not a
measurement of the author's actual emotional state. One or two sentences.

Never invent evidence. If the retrieved passages do not support a claim, say
so and do not cite anything.
"""

    prompt = f"""
PASSAGE OF NEW WRITING:
{data.text}

MEASURED REGISTER OF THE NEW WRITING:
{', '.join(f"{item['register']} {item['score']:.2f}" for item in query_ranked) or "no clear register"}

THIS AUTHOR'S OVERALL EMOTIONAL PROFILE:
{', '.join(f"{item['register']} {item['score']:.2f}" for item in novel_profile["registers"][:5]) or "not established yet"}

RETRIEVED PASSAGES FROM THIS AUTHOR'S SAVED CHAPTERS:
{build_evidence_block(passages)}
"""

    result = ask_ai(instructions, prompt)

    return {
        "result": result,
        "local": local,
        "retrieval": retrieval,
        "profile": novel_profile,
        "citations": cited_passages(result, passages),
    }


# ==================================================
# 17. AI: GRAMMAR ASSISTANT
# ==================================================

@app.post("/api/ai/grammar")
def grammar_assistant(
    data: AIInput,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:
        ai_context(db, user, data.novel_id)

    instructions = """
You are the grammar and writing assistant of Light Novel Buddy.

Correct grammar, spelling, punctuation and sentence structure.
Improve readability, dialogue and paragraph flow.

Preserve the author's original meaning, vocabulary and writing style.
Do not unnecessarily rewrite the entire passage.

Return:
1. The corrected passage.
2. A short list of important corrections.
"""

    prompt = f"""
Writing style requested: {data.style}

Text to review:

{data.text}
"""

    return {
                "result": ask_ai(instructions, prompt)
    }


# ==================================================
# 18. AI: CONSISTENCY CHECKER
# ==================================================

@app.post("/api/ai/consistency")
def consistency_checker(
    data: AIInput,
    user=Depends(get_current_user)
):

    # Labelled context so the model can point at the saved record it used.
    with SessionLocal() as db:
        novel_id, _ = ai_context(db, user, data.novel_id)
        context, known_refs = build_world_context(db, novel_id, label=True)

    instructions = """
You are the story consistency checker of Light Novel Buddy.

Compare the submitted chapter with established world information.

Look for:
- Character appearance and personality contradictions
- Timeline inconsistencies
- Location and geographical errors
- Ability and magic system contradictions
- Relationship inconsistencies
- Conflicts with established history and lore

Do not invent contradictions.
If information is insufficient, say so.

For every possible issue:
1. Quote or identify the relevant passage.
2. State the tag of the established detail it conflicts with, in square
   brackets exactly as it appears in the context, for example [W12] or [C3].
   Use only tags that appear in the context. If no saved entry supports the
   point, say "no saved entry" instead of inventing a tag.
3. Explain the conflicting established detail.
4. Suggest a possible correction.

Do not rewrite the chapter automatically.
"""

    prompt = f"""
ESTABLISHED STORY CONTEXT:

{context}

NEW CHAPTER TO CHECK:

{data.text}
"""

    result = ask_ai(instructions, prompt)

    # Resolve the citations the model actually used. Anything unknown is dropped.
    tags = extract_reference_tags(result, known_refs)

    return {
        "result": result,
        "references": reference_payload(tags, known_refs),
    }


# ==================================================
# 19. AI: DESCRIPTION ASSISTANT
# ==================================================

@app.post("/api/ai/enrich")
def description_assistant(
    data: AIInput,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:
        _, context = ai_context(db, user, data.novel_id)

    instructions = """
You are the descriptive writing assistant of Light Novel Buddy.

Help authors make their writing more immersive.

You can improve:
- Landscapes and environments
- Cities and architecture
- Character descriptions and expressions
- Magical and supernatural abilities
- Atmosphere and mood
- Action scenes

Preserve the author's original idea.
Use established world information where relevant.
Do not introduce major new story events.

Return an improved version and briefly explain the changes.
"""

    prompt = f"""
Requested writing style: {data.style}

Established world context:
{context}

Original description:
{data.text}
"""

    return {
        "result": ask_ai(instructions, prompt)
    }


# ==================================================
# 20. AI: STORY DEVELOPMENT
# ==================================================

@app.post("/api/ai/story")
def story_development(
    data: AIInput,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:
        _, context = ai_context(db, user, data.novel_id)

    # `direction` already existed on the schema but was never used. It now carries
    # the directions the author selected plus any answers to follow-up questions,
    # so the same endpoint can refine a thread without a second route.
    refining = bool(data.direction)

    if refining:
        instructions = """
You are the interactive story development assistant
of Light Novel Buddy.

The author has already seen a set of possible directions and has chosen the
ones that interest them. Your job is to deepen those choices, not to repeat
them or replace them with unrelated ideas.

Produce up to four refined possibilities drawn from the author's selection.
For each one:
- A short title that makes clear which selected direction it develops
- What happens next
- How the characters might react
- A possible consequence for the story
- One concrete question the author still needs to answer

Respect established lore and character personalities.
Never decide the final direction for the author.
Do not write an entire chapter unless explicitly requested.
"""
        prompt = f"""
Established world context:
{context}

Current story situation:
{data.text}

The author selected these directions and answered follow-up questions:
{data.direction}

Develop the selected directions further.
"""
    else:
        instructions = """
You are the interactive story development assistant
of Light Novel Buddy.

Help the author explore possible directions for the story.

Generate four distinct possibilities.
Each possibility should include:
- A short title
- What happens next
- How the characters might react
- A possible consequence for the story

Respect established lore and character personalities.

Never decide the final direction for the author.
Do not write an entire chapter unless explicitly requested.

After the four possibilities, add a section titled "Questions to explore
further" with two or three open questions about the story, each on its own
line starting with a dash. These questions are for the author to answer or
ignore; do not answer them yourself.
"""
        prompt = f"""
Established world context:
{context}

Current story situation:
{data.text}

Author's own idea:
{data.idea or "No additional idea provided."}

Explore four possible directions.
"""

    result = ask_ai(instructions, prompt)

    return {"result": result, "mode": "refined" if refining else "explore"}


# ==================================================
# 21. AI: CHARACTER DEVELOPMENT
# ==================================================

@app.post("/api/ai/character")
def character_development(
    data: AIInput,
    user=Depends(get_current_user)
):

    with SessionLocal() as db:
        _, context = ai_context(db, user, data.novel_id)

    instructions = """
You are the character development assistant of Light Novel Buddy.

Analyse fictional characters and help authors develop them.

Consider:
- Personality
- Background
- Motivations
- Goals
- Strengths and weaknesses
- Relationships
- Character growth
- Behaviour and decisions

Identify unexplained behavioural changes where possible.
Suggest meaningful development opportunities.

Do not force changes to the author's character.
"""

    prompt = f"""
Established story context:
{context}

Character information:
{data.text}

Analyse this character and suggest ways to develop them.
"""

    return {
        "result": ask_ai(instructions, prompt)
    }


# ==================================================
# 22. DEVELOPMENT SERVER
# ==================================================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
