import os
import re
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Path as FastAPIPath
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Text,
    ForeignKey,
)
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from adaption import Adaption


# --------------------------------------------------
# 1. CONFIGURATION
# --------------------------------------------------

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

engine = create_engine(
    DATABASE_URL,
    # check_same_thread is SQLite-only; psycopg rejects it as a connection option.
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


# --------------------------------------------------
# 2. DATABASE MODELS
# --------------------------------------------------

class Novel(Base):
    __tablename__ = "novels"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, default="My Novel")

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
    novel_id = Column(Integer, ForeignKey("novels.id"))

    novel = relationship("Novel", back_populates="chapters")


class MemoryEntry(Base):
    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    category = Column(String, default="General")
    description = Column(Text, default="")
    novel_id = Column(Integer, ForeignKey("novels.id"))

    novel = relationship("Novel", back_populates="memories")


class Character(Base):
    __tablename__ = "characters"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    personality = Column(Text, default="")
    description = Column(Text, default="")
    novel_id = Column(Integer, ForeignKey("novels.id"))

    novel = relationship("Novel", back_populates="characters")


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_keys"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(128), nullable=False, unique=True, index=True)
    endpoint = Column(String(128), nullable=False)
    resource_id = Column(Integer, nullable=False)
    created_at = Column(Integer, nullable=False)


Base.metadata.create_all(bind=engine)


# Create a default novel if the database is empty.
with SessionLocal() as db:
    if db.query(Novel).count() == 0:
        db.add(Novel(title="My Novel"))
        db.commit()


# --------------------------------------------------
# 3. FASTAPI APPLICATION
# --------------------------------------------------

app = FastAPI(
    title="Light Novel Buddy API",
    description="AI writing companion for light novel authors",
    version="2.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# 4. REQUEST SCHEMAS
# --------------------------------------------------

def _clean_text(value: object, label: str, *, required: bool = False, strip: bool = False, max_len: int = 50_000) -> str:
    if value is None:
        raise ValueError(f"{label} cannot be null.")
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    if "\x00" in value:
        raise ValueError(f"{label} contains invalid characters.")
    cleaned = value.strip() if (required or strip) else value
    if required and not cleaned:
        raise ValueError(f"{label} cannot be blank.")
    if len(cleaned) > max_len:
        raise ValueError(f"{label} must be {max_len} characters or fewer.")
    return cleaned


def _clean_novel_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("novel_id must be a positive integer.")
    return value


class _UpdateBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def require_at_least_one_field(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided for update.")
        return self


class ChapterInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    content: str = ""
    novel_id: int = 1

    @field_validator("title", mode="before")
    @classmethod
    def check_title(cls, v): return _clean_text(v, "Chapter title", required=True, max_len=300)

    @field_validator("content", mode="before")
    @classmethod
    def check_content(cls, v): return _clean_text(v, "Chapter content", max_len=500_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class ChapterUpdate(_UpdateBase):
    title: Optional[str] = None
    content: Optional[str] = None

    @field_validator("title", mode="before")
    @classmethod
    def check_title(cls, v): return _clean_text(v, "Chapter title", required=True, max_len=300)

    @field_validator("content", mode="before")
    @classmethod
    def check_content(cls, v): return _clean_text(v, "Chapter content", max_len=500_000)


class MemoryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    category: str = "General"
    description: str = ""
    novel_id: int = 1

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "World entry name", required=True, max_len=200)

    @field_validator("category", mode="before")
    @classmethod
    def check_category(cls, v): return _clean_text(v, "Category", required=True, max_len=100)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", max_len=50_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class MemoryUpdate(_UpdateBase):
    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "World entry name", required=True, max_len=200)

    @field_validator("category", mode="before")
    @classmethod
    def check_category(cls, v): return _clean_text(v, "Category", required=True, max_len=100)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", max_len=50_000)


class CharacterInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    personality: str = ""
    description: str = ""
    novel_id: int = 1

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Character name", required=True, max_len=200)

    @field_validator("personality", mode="before")
    @classmethod
    def check_personality(cls, v): return _clean_text(v, "Personality", strip=True, max_len=500)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", max_len=50_000)

    @field_validator("novel_id", mode="before")
    @classmethod
    def check_novel(cls, v): return _clean_novel_id(v)


class CharacterUpdate(_UpdateBase):
    name: Optional[str] = None
    personality: Optional[str] = None
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def check_name(cls, v): return _clean_text(v, "Character name", required=True, max_len=200)

    @field_validator("personality", mode="before")
    @classmethod
    def check_personality(cls, v): return _clean_text(v, "Personality", strip=True, max_len=500)

    @field_validator("description", mode="before")
    @classmethod
    def check_description(cls, v): return _clean_text(v, "Description", max_len=50_000)


class AIInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    novel_id: int = 1
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
    def check_direction(cls, v): return _clean_text(v, "Direction", strip=True, max_len=500)

    @field_validator("idea", mode="before")
    @classmethod
    def check_idea(cls, v): return _clean_text(v, "Idea", strip=True, max_len=2_000)


# --------------------------------------------------
# 5. DATABASE HELPERS
# --------------------------------------------------

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
    try:
        db.flush()
        if key:
            db.add(IdempotencyRecord(key=key, endpoint=endpoint, resource_id=item.id, created_at=now))
        db.commit()
    except IntegrityError:
        db.rollback()
        if key:
            existing = db.query(IdempotencyRecord).filter(IdempotencyRecord.key == key, IdempotencyRecord.endpoint == endpoint).first()
            if existing:
                winner = db.query(model_cls).filter(model_cls.id == existing.resource_id).first()
                if winner:
                    return {"message": message, "id": winner.id}
        raise HTTPException(status_code=409, detail="Duplicate conflicting request.")
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error while saving changes.")

    db.refresh(item)
    return {"message": message, "id": item.id}


def delete_with_idempotency(db, *, key: Optional[str], endpoint: str, model_cls, resource_id: int, not_found: str, message: str):
    now = int(time.time())
    if key:
        existing = db.query(IdempotencyRecord).filter(IdempotencyRecord.key == key).first()
        if existing:
            if existing.endpoint != endpoint:
                raise HTTPException(status_code=409, detail="Idempotency-Key already used for another endpoint.")
            return {"message": message}

    item = db.query(model_cls).filter(model_cls.id == resource_id).first()
    if not item:
        raise HTTPException(404, not_found)

    db.delete(item)
    if key:
        db.add(IdempotencyRecord(key=key, endpoint=endpoint, resource_id=resource_id, created_at=now))
    db.commit()
    return {"message": message}

def get_novel(db, novel_id):
    novel = db.query(Novel).filter(
        Novel.id == novel_id
    ).first()

    if not novel:
        raise HTTPException(
            status_code=404,
            detail="Novel not found."
        )

    return novel


def build_world_context(novel_id=1, *, label=False):
    """Collect saved lore and recent chapters for AI context.

    Returns (context_text, references). When ``label`` is true each block is
    prefixed with a stable tag such as [W12], [C3] or [CH5] and the matching
    reference metadata is returned so a caller can resolve what the model cites.
    """

    refs = {}

    with SessionLocal() as db:
        get_novel(db, novel_id)

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

        parts = []

        parts.append("ESTABLISHED WORLD INFORMATION:")

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


def get_world_context(novel_id=1):
    """Backward-compatible unlabelled context used by the other assistants."""
    context, _ = build_world_context(novel_id)
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


# --------------------------------------------------
# 6. ADAPTION AI CONNECTION
# --------------------------------------------------

def ask_ai(instructions, user_input, novel_id=1):

    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ADAPTION_API_KEY is missing from backend/.env"
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
            status_code=502,
            detail=f"Adaption API error: {str(error)}"
        )


# --------------------------------------------------
# 7. GENERAL ROUTES
# --------------------------------------------------

@app.get("/")
def home():
    return {
        "message": "Welcome to Light Novel Buddy API",
        "version": "2.0"
    }


@app.get("/api/health")
def health():
    return {
        "status": "online",
        "adaption_key_configured": bool(API_KEY),
        "model": MODEL
    }


@app.get("/api/novel")
def get_novel_info():
    with SessionLocal() as db:
        novel = get_novel(db, 1)

        return {
            "id": novel.id,
            "title": novel.title
        }


@app.get("/api/dashboard")
def dashboard():
    with SessionLocal() as db:
        chapters = db.query(Chapter).filter(
            Chapter.novel_id == 1
        ).all()

        characters = db.query(Character).filter(
            Character.novel_id == 1
        ).count()

        memories = db.query(MemoryEntry).filter(
            MemoryEntry.novel_id == 1
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


# --------------------------------------------------
# 8. CHAPTER ROUTES
# --------------------------------------------------

@app.get("/api/chapters")
def list_chapters():
    with SessionLocal() as db:
        chapters = db.query(Chapter).filter(
            Chapter.novel_id == 1
        ).order_by(Chapter.id.desc()).all()

        return [
            {
                "id": c.id,
                "title": c.title,
                "content": c.content
            }
            for c in chapters
        ]


@app.post("/api/chapters")
def create_chapter(data: ChapterInput, idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        get_novel(db, data.novel_id)
        return save_with_idempotency(
            db,
            key=key,
            endpoint="POST:/api/chapters",
            model_cls=Chapter,
            create_kwargs={"title": data.title, "content": data.content, "novel_id": data.novel_id},
            update_fields={"title": data.title, "content": data.content},
            message="Chapter saved",
        )


@app.get("/api/chapters/{chapter_id}")
def get_chapter(chapter_id: int = FastAPIPath(..., ge=1)):
    with SessionLocal() as db:
        chapter = db.query(Chapter).filter(
            Chapter.id == chapter_id
        ).first()

        if not chapter:
            raise HTTPException(404, "Chapter not found")

        return {
            "id": chapter.id,
            "title": chapter.title,
            "content": chapter.content
        }


@app.put("/api/chapters/{chapter_id}")
def update_chapter(data: ChapterUpdate, chapter_id: int = FastAPIPath(..., ge=1)):
    with SessionLocal() as db:
        chapter = db.query(Chapter).filter(
            Chapter.id == chapter_id
        ).first()

        if not chapter:
            raise HTTPException(404, "Chapter not found")

        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(chapter, key, value)

        db.commit()

        return {"message": "Chapter updated"}


@app.delete("/api/chapters/{chapter_id}")
def delete_chapter(chapter_id: int = FastAPIPath(..., ge=1), idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        return delete_with_idempotency(
            db,
            key=key,
            endpoint=f"DELETE:/api/chapters/{chapter_id}",
            model_cls=Chapter,
            resource_id=chapter_id,
            not_found="Chapter not found",
            message="Chapter deleted",
        )


# --------------------------------------------------
# 9. WORLD MEMORY ROUTES
# --------------------------------------------------

@app.get("/api/memories")
def list_memories():
    with SessionLocal() as db:
        memories = db.query(MemoryEntry).filter(
            MemoryEntry.novel_id == 1
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
def create_memory(data: MemoryInput, idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        get_novel(db, data.novel_id)
        return save_with_idempotency(
            db,
            key=key,
            endpoint="POST:/api/memories",
            model_cls=MemoryEntry,
            create_kwargs={"name": data.name, "category": data.category, "description": data.description, "novel_id": data.novel_id},
            update_fields={"name": data.name, "category": data.category, "description": data.description},
            message="World memory saved",
        )


@app.put("/api/memories/{memory_id}")
def update_memory(data: MemoryUpdate, memory_id: int = FastAPIPath(..., ge=1)):
    with SessionLocal() as db:
        memory = db.query(MemoryEntry).filter(
            MemoryEntry.id == memory_id
        ).first()

        if not memory:
            raise HTTPException(404, "Memory not found")

        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(memory, key, value)

        db.commit()

        return {"message": "Memory updated"}


@app.delete("/api/memories/{memory_id}")
def delete_memory(memory_id: int = FastAPIPath(..., ge=1), idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        return delete_with_idempotency(
            db,
            key=key,
            endpoint=f"DELETE:/api/memories/{memory_id}",
            model_cls=MemoryEntry,
            resource_id=memory_id,
            not_found="Memory not found",
            message="Memory deleted",
        )


# --------------------------------------------------
# 10. CHARACTER ROUTES
# --------------------------------------------------

@app.get("/api/characters")
def list_characters():
    with SessionLocal() as db:
        characters = db.query(Character).filter(
            Character.novel_id == 1
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
def create_character(data: CharacterInput, idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        get_novel(db, data.novel_id)
        return save_with_idempotency(
            db,
            key=key,
            endpoint="POST:/api/characters",
            model_cls=Character,
            create_kwargs={"name": data.name, "personality": data.personality, "description": data.description, "novel_id": data.novel_id},
            update_fields={"name": data.name, "personality": data.personality, "description": data.description},
            message="Character added",
        )


@app.put("/api/characters/{character_id}")
def update_character(data: CharacterUpdate, character_id: int = FastAPIPath(..., ge=1)):
    with SessionLocal() as db:
        character = db.query(Character).filter(
            Character.id == character_id
        ).first()

        if not character:
            raise HTTPException(404, "Character not found")

        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(character, key, value)

        db.commit()

        return {"message": "Character updated"}


@app.delete("/api/characters/{character_id}")
def delete_character(character_id: int = FastAPIPath(..., ge=1), idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key")):
    key = normalize_idempotency_key(idempotency_key)
    with SessionLocal() as db:
        return delete_with_idempotency(
            db,
            key=key,
            endpoint=f"DELETE:/api/characters/{character_id}",
            model_cls=Character,
            resource_id=character_id,
            not_found="Character not found",
            message="Character deleted",
        )


# --------------------------------------------------
# 11. AI: GRAMMAR AND WRITING CORRECTION
# --------------------------------------------------

@app.post("/api/ai/grammar")
def grammar_assistant(data: AIInput):
    with SessionLocal() as db:
        get_novel(db, data.novel_id)

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

    result = ask_ai(instructions, prompt, data.novel_id)

    return {"result": result}


# --------------------------------------------------
# 12. AI: STORY CONSISTENCY CHECKER
# --------------------------------------------------

@app.post("/api/ai/consistency")
def consistency_checker(data: AIInput):

    # Labelled context so the model can point at the saved record it used.
    context, known_refs = build_world_context(data.novel_id, label=True)

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

    result = ask_ai(instructions, prompt, data.novel_id)

    # Resolve the citations the model actually used. Anything unknown is dropped.
    tags = extract_reference_tags(result, known_refs)

    return {
        "result": result,
        "references": reference_payload(tags, known_refs),
    }


# --------------------------------------------------
# 13. AI: DESCRIPTIVE WRITING ASSISTANT
# --------------------------------------------------

@app.post("/api/ai/enrich")
def description_assistant(data: AIInput):

    context = get_world_context(data.novel_id)

    instructions = """
You are the descriptive writing assistant of Light Novel Buddy.

Help authors make their writing more immersive.

You can improve:
- Landscapes and environments
- Cities and architecture
- Character descriptions and expressions
- Magical and supernatural abilities
- Atmosphere and mood
- Action and battle scenes

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

    result = ask_ai(instructions, prompt, data.novel_id)

    return {"result": result}


# --------------------------------------------------
# 14. AI: INTERACTIVE STORY DEVELOPMENT
# --------------------------------------------------

@app.post("/api/ai/story")
def story_development(data: AIInput):

    context = get_world_context(data.novel_id)

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

    result = ask_ai(instructions, prompt, data.novel_id)

    return {"result": result}


# --------------------------------------------------
# 15. AI: CHARACTER DEVELOPMENT ASSISTANT
# --------------------------------------------------

@app.post("/api/ai/character")
def character_development(data: AIInput):

    context = get_world_context(data.novel_id)

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

    result = ask_ai(instructions, prompt, data.novel_id)

    return {"result": result}


# --------------------------------------------------
# 16. STARTUP INFORMATION
# --------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
