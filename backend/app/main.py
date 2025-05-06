from typing import Union

from fastapi import FastAPI, HTTPException

from .models import UserLogin
from .auth import authenticate_user
from .database import create_tables

app = FastAPI()

# 애플리케이션 시작 시 테이블 생성
@app.on_event("startup")
async def startup_event():
    create_tables()


@app.get("/")
def read_root():
    return {"Hello": "World"}


@app.get("/items/{item_id}")
def read_item(item_id: int, q: Union[str, None] = None):
    return {"item_id": item_id, "q": q}


@app.post("/api/login")
async def login(user_login: UserLogin):
    # PostgreSQL DB에서 사용자 인증
    user = await authenticate_user(user_login)
    
    if user:
        return user
    else:
        # 인증 실패 시 401 에러 반환
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    