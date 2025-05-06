import os
from dotenv import load_dotenv

# .env 파일 로드
load_dotenv()

# 데이터베이스 연결 정보
DATABASE_URL = os.getenv("DATABASE_URL")