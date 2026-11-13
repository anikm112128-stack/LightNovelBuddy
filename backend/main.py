import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Text,
    ForeignKey,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from adaption import Adaption


# --------------------------------------------------
# 1. CONFIGURATION
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_KEY = os.getenv("ADAPTION_API_KEY")
MODEL = os.getenv("ADAPTION_MODEL", "qwen3.5-397b")

DATABASE_URL = f"sqlite:///{BASE_DIR / 'database.db'}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
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
    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}):5500$"
    ),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------
# 4. REQUEST SCHEMAS
# --------------------------------------------------

class ChapterInput(BaseModel):
    title: str
    content: str = ""
    novel_id: int = 1


class MemoryInput(BaseModel):
    name: str
    category: str = "General"
    description: str = ""
    novel_id: int = 1


class MemoryUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None


class CharacterInput(BaseModel):
    name: str
    personality: str = ""
    description: str = ""
    novel_id: int = 1


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    personality: Optional[str] = None
    description: Optional[str] = None


class AIInput(BaseModel):
    text: str
    novel_id: int = 1
    style: str = ""
    direction: str = ""
    idea: str = ""


# --------------------------------------------------
# 5. DATABASE HELPERS
# --------------------------------------------------

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


def get_world_context(novel_id=1):
    """Collect saved lore and recent chapters for AI context."""

    with SessionLocal() as db:
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

        parts = []

        parts.append("ESTABLISHED WORLD INFORMATION:")

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
def create_chapter(data: ChapterInput):
    with SessionLocal() as db:
        get_novel(db, data.novel_id)

        chapter = Chapter(
            title=data.title,
            content=data.content,
            novel_id=data.novel_id
        )

        db.add(chapter)
        db.commit()
        db.refresh(chapter)

        return {
            "message": "Chapter saved",
            "id": chapter.id
        }


@app.get("/api/chapters/{chapter_id}")
def get_chapter(chapter_id: int):
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
def update_chapter(chapter_id: int, data: ChapterInput):
    with SessionLocal() as db:
        chapter = db.query(Chapter).filter(
            Chapter.id == chapter_id
        ).first()

        if not chapter:
            raise HTTPException(404, "Chapter not found")

        chapter.title = data.title
        chapter.content = data.content

        db.commit()

        return {"message": "Chapter updated"}


@app.delete("/api/chapters/{chapter_id}")
def delete_chapter(chapter_id: int):
    with SessionLocal() as db:
        chapter = db.query(Chapter).filter(
            Chapter.id == chapter_id
        ).first()

        if not chapter:
            raise HTTPException(404, "Chapter not found")

        db.delete(chapter)
        db.commit()

        return {"message": "Chapter deleted"}


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
def create_memory(data: MemoryInput):
    with SessionLocal() as db:
        get_novel(db, data.novel_id)

        memory = MemoryEntry(
            name=data.name,
            category=data.category,
            description=data.description,
            novel_id=data.novel_id
        )

        db.add(memory)
        db.commit()
        db.refresh(memory)

        return {
            "message": "World memory saved",
            "id": memory.id
        }


@app.put("/api/memories/{memory_id}")
def update_memory(memory_id: int, data: MemoryUpdate):
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
def delete_memory(memory_id: int):
    with SessionLocal() as db:
        memory = db.query(MemoryEntry).filter(
            MemoryEntry.id == memory_id
        ).first()

        if not memory:
            raise HTTPException(404, "Memory not found")

        db.delete(memory)
        db.commit()

        return {"message": "Memory deleted"}


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
def create_character(data: CharacterInput):
    with SessionLocal() as db:
        get_novel(db, data.novel_id)

        character = Character(
            name=data.name,
            personality=data.personality,
            description=data.description,
            novel_id=data.novel_id
        )

        db.add(character)
        db.commit()
        db.refresh(character)

        return {
            "message": "Character added",
            "id": character.id
        }


@app.put("/api/characters/{character_id}")
def update_character(character_id: int, data: CharacterUpdate):
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
def delete_character(character_id: int):
    with SessionLocal() as db:
        character = db.query(Character).filter(
            Character.id == character_id
        ).first()

        if not character:
            raise HTTPException(404, "Character not found")

        db.delete(character)
        db.commit()

        return {"message": "Character deleted"}


# --------------------------------------------------
# 11. AI: GRAMMAR AND WRITING CORRECTION
# --------------------------------------------------

@app.post("/api/ai/grammar")
def grammar_assistant(data: AIInput):

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

    context = get_world_context(data.novel_id)

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

    result = ask_ai(instructions, prompt, data.novel_id)

    return {"result": result}


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