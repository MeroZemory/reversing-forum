from pydantic import BaseModel, EmailStr
from datetime import datetime
from typing import Optional


# 사용자 기본 모델
class User(BaseModel):
    id: Optional[int] = None
    username: str
    email: EmailStr
    is_active: bool = True
    created_at: Optional[datetime] = None
    last_login: Optional[datetime] = None


# 사용자 생성 모델
class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str


# 사용자 인증 모델
class UserLogin(BaseModel):
    username: str
    password: str


# 구글 로그인 토큰 모델
class GoogleToken(BaseModel):
    token: str
