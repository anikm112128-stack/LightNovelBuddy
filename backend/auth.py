"""Authentication and ownership primitives for Light Novel Buddy.

Integrate these routes/dependencies into backend/main.py as described in
INTEGRATION.md. Do not deploy until every existing data route uses
get_current_user and get_owned_novel.
"""
import os
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Session

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    # Generate a stable secret in the deployment environment. This fallback
    # is only for local development and invalidates tokens after restart.
    SECRET_KEY = secrets.token_urlsafe(48)

ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "10080"))
PBKDF2_ITERATIONS = 310_000
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def build_auth_models(Base):
    class User(Base):
        __tablename__ = "users"
        id = Column(Integer, primary_key=True, index=True)
        email = Column(String(320), unique=True, nullable=False, index=True)
        password_hash = Column(String(256), nullable=False)
        is_active = Column(Boolean, nullable=False, default=True)
        created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    class RefreshSession(Base):
        __tablename__ = "refresh_sessions"
        id = Column(Integer, primary_key=True, index=True)
        user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
        token_hash = Column(String(64), nullable=False, unique=True, index=True)
        expires_at = Column(DateTime, nullable=False)
        revoked = Column(Boolean, nullable=False, default=False)

    return User, RefreshSession


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, rounds, salt_hex, expected = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    return jwt.encode({"sub": str(user_id), "exp": expires}, SECRET_KEY, algorithm=ALGORITHM)


def make_auth_router(User, RefreshSession, SessionLocal):
    router = APIRouter(prefix="/api/auth", tags=["authentication"])

    class RegisterInput(BaseModel):
        email: EmailStr
        password: str = Field(min_length=10, max_length=128)

    class UserOutput(BaseModel):
        id: int
        email: EmailStr

    def get_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
        credentials_error = HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session is invalid or has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            user_id = int(payload.get("sub", ""))
        except (JWTError, ValueError, TypeError):
            raise credentials_error
        user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
        if not user:
            raise credentials_error
        return user

    @router.post("/register", response_model=UserOutput, status_code=201)
    def register(data: RegisterInput, db: Session = Depends(get_db)):
        email = data.email.strip().lower()
        if db.query(User).filter(User.email == email).first():
            raise HTTPException(409, "An account with this email already exists.")
        user = User(email=email, password_hash=hash_password(data.password))
        db.add(user)
        db.commit()
        db.refresh(user)
        return {"id": user.id, "email": user.email}

    @router.post("/login")
    def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
        email = form.username.strip().lower()
        user = db.query(User).filter(User.email == email, User.is_active.is_(True)).first()
        if not user or not verify_password(form.password, user.password_hash):
            # Same response for unknown email and wrong password.
            raise HTTPException(401, "Email or password is incorrect.", headers={"WWW-Authenticate": "Bearer"})
        return {"access_token": create_access_token(user.id), "token_type": "bearer"}

    @router.get("/me", response_model=UserOutput)
    def me(user=Depends(get_current_user)):
        return {"id": user.id, "email": user.email}

    return router, User, get_current_user, get_db


def get_owned_novel(db: Session, Novel, novel_id: int, user_id: int):
    """Return a novel only if it belongs to this authenticated user."""
    novel = db.query(Novel).filter(
        Novel.id == novel_id,
        Novel.owner_id == user_id,
    ).first()
    if not novel:
        raise HTTPException(404, "Novel not found.")
    return novel


def enforce_novel_ownership(Base, Novel):
    """Add this column to the Novel model before creating tables."""
    if not hasattr(Novel, "owner_id"):
        raise RuntimeError("Add Novel.owner_id to the Novel model before using auth.")
