"""Multi-novel API routes. Requires authenticated user dependency."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


def make_novel_router(SessionLocal, Novel, get_current_user):
    router = APIRouter(prefix="/api/novels", tags=["novels"])

    def get_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    class NovelInput(BaseModel):
        title: str = Field(min_length=1, max_length=160)

    @router.get("")
    def list_novels(db: Session = Depends(get_db), user=Depends(get_current_user)):
        novels = db.query(Novel).filter(Novel.owner_id == user.id).order_by(Novel.id.asc()).all()
        return [{"id": n.id, "title": n.title} for n in novels]

    @router.post("", status_code=201)
    def create_novel(data: NovelInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
        novel = Novel(title=data.title.strip(), owner_id=user.id)
        db.add(novel)
        db.commit()
        db.refresh(novel)
        return {"id": novel.id, "title": novel.title}

    @router.patch("/{novel_id}")
    def rename_novel(novel_id: int, data: NovelInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
        novel = db.query(Novel).filter(Novel.id == novel_id, Novel.owner_id == user.id).first()
        if not novel:
            raise HTTPException(404, "Novel not found.")
        novel.title = data.title.strip()
        db.commit()
        return {"id": novel.id, "title": novel.title}

    @router.delete("/{novel_id}", status_code=204)
    def delete_novel(novel_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
        novel = db.query(Novel).filter(Novel.id == novel_id, Novel.owner_id == user.id).first()
        if not novel:
            raise HTTPException(404, "Novel not found.")
        db.delete(novel)
        db.commit()
        return None

    return router
