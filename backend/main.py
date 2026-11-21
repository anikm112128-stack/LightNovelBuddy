
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import (
    create_engine, Column, Integer, String, Text,
    ForeignKey, inspect, text
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from adaption import Adaption

from auth import build_auth_models, make_auth_router, get_owned_novel
from novels import make_novel_router


# ==================================================
# 1. CONFIGURATION
# ==================================================

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_KEY = os.getenv("ADAPTION_API_KEY")
MODEL = os.getenv("ADAPTION_MODEL", "qwen3.5-397b")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{BASE_DIR / 'database.db'}"
)

engine_options = {"pool_pre_ping": True}

if DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {
        "check_same_thread": False
    }

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
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://lightnovelbuddyf.onrender.com"
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ==================================================
# 6. AUTHENTICATION ROUTES
# ==================================================

auth_router, User, base_get_current_user, auth_get_db = (
    make_auth_router(User, RefreshSession, SessionLocal)
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
        SessionLocal,
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


class MemoryInput(BaseModel):
    name: str
    category: str = "General"
    description: str = ""
    novel_id: Optional[int] = None


class MemoryUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None


class CharacterInput(BaseModel):
    name: str
    personality: str = ""
    description: str = ""
    novel_id: Optional[int] = None


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    personality: Optional[str] = None
    description: Optional[str] = None


class AIInput(BaseModel):
    text: str
    novel_id: Optional[int] = None
    style: str = ""
    direction: str = ""
    idea: str = ""

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


# ==================================================
# 10. WORLD CONTEXT
# ==================================================

def get_world_context(db, novel_id):

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

    parts = ["ESTABLISHED WORLD INFORMATION:"]

    for item in memories:

        parts.append(
            f"{item.category}: {item.name}\n"
            f"{item.description}"
        )

    parts.append("\nCHARACTERS:")

    for character in characters:

        parts.append(
            f"Name: {character.name}\n"
            f"Personality: {character.personality}\n"
            f"Details: {character.description}"
        )

    parts.append("\nRECENT CHAPTERS:")

    for chapter in reversed(chapters):

        parts.append(
            f"{chapter.title}:\n"
            f"{(chapter.content or '')[-2500:]}"
        )

    return "\n\n".join(parts)


# ==================================================
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
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        chapter = Chapter(
            title=data.title,
            content=data.content,
            novel_id=novel.id
        )

        db.add(chapter)
        db.commit()
        db.refresh(chapter)

        return {
            "message": "Chapter saved",
            "id": chapter.id
        }


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
    data: ChapterInput,
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

        chapter.title = data.title
        chapter.content = data.content

        db.commit()

        return {
            "message": "Chapter updated"
        }


@app.delete("/api/chapters/{chapter_id}")
def delete_chapter(
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

        db.delete(chapter)
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
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        memory = MemoryEntry(
            name=data.name,
            category=data.category,
            description=data.description,
            novel_id=novel.id
        )

        db.add(memory)
        db.commit()
        db.refresh(memory)

        return {
            "message": "World memory saved",
            "id": memory.id
        }


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

        for key, value in data.dict(exclude_unset=True).items():
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
    user=Depends(get_current_user)
):

    with SessionLocal() as db:

        novel = resolve_novel(
            db,
            user,
            data.novel_id
        )

        character = Character(
            name=data.name,
            personality=data.personality,
            description=data.description,
            novel_id=novel.id
        )

        db.add(character)
        db.commit()
        db.refresh(character)

        return {
            "message": "Character added",
            "id": character.id
        }


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

        for key, value in data.dict(exclude_unset=True).items():
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

        for key, value in data.dict(exclude_unset=True).items():
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

    with SessionLocal() as db:
        _, context = ai_context(db, user, data.novel_id)

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
1. Identify the relevant passage.
2. Explain the conflicting established detail.
3. Suggest a possible correction.

Do not rewrite the chapter automatically.
"""

    prompt = f"""
ESTABLISHED STORY CONTEXT:

{context}

NEW CHAPTER TO CHECK:

{data.text}
"""

    return {
        "result": ask_ai(instructions, prompt)
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

    instructions = """
You are the interactive story development assistant
of Light Novel Buddy.

Generate four distinct possible directions.

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

    return {
        "result": ask_ai(instructions, prompt)
    }


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
