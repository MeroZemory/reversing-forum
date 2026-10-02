from typing import Union

from fastapi import FastAPI, HTTPException

from .models import GoogleToken
from .auth import google_login  # authenticate_user, register_user 제거
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


"""
# 기존 로그인/회원가입 엔드포인트 (주석 처리)
@app.post("/api/login")
async def login(user_login: UserLogin):
    # PostgreSQL DB에서 사용자 인증
    user = await authenticate_user(user_login)

    if user:
        return user
    else:
        # 인증 실패 시 401 에러 반환
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")


@app.post("/api/register")
async def register(user_create: UserCreate):
    # 사용자 등록
    result = await register_user(user_create)

    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return {"message": "회원가입이 완료되었습니다.", "user": result}
"""


@app.post("/api/auth/google")
async def auth_google(token_data: GoogleToken):
    """구글 로그인 처리
    
    Args:
        token_data: 구글 ID 토큰
        
    Returns:
        사용자 정보
    """
    result = await google_login(token_data)

    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return {"message": "구글 로그인이 완료되었습니다.", "user": result}
