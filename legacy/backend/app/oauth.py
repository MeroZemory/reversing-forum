from google.oauth2 import id_token
from google.auth.transport import requests
import os
from dotenv import load_dotenv
from fastapi import HTTPException

# .env 파일에서 환경 변수 로드
load_dotenv()

# Google OAuth 설정
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:3000/auth/google/callback")


async def verify_google_token(token: str):
    """
    Google ID 토큰을 검증하고 사용자 정보를 반환합니다.
    """
    try:
        # 토큰 검증
        idinfo = id_token.verify_oauth2_token(token, requests.Request(), GOOGLE_CLIENT_ID)

        # 토큰이 Google에서 발급된 것인지 확인
        if idinfo['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
            raise ValueError('잘못된 발급자입니다.')

        # 사용자 정보 반환
        user_info = {
            'email': idinfo['email'],
            'name': idinfo.get('name', ''),
            'picture': idinfo.get('picture', ''),
            'sub': idinfo['sub']  # Google의 고유 사용자 ID
        }

        return user_info
    except ValueError as e:
        # 토큰 검증 실패
        raise HTTPException(status_code=401, detail=f"유효하지 않은 토큰: {str(e)}")
