import psycopg2
from psycopg2.extras import RealDictCursor
from .config import DATABASE_URL


def get_db_connection():
    """PostgreSQL 데이터베이스 연결을 생성하고 반환합니다"""
    if DATABASE_URL is None:
        raise ValueError("DATABASE_URL 환경 변수가 설정되지 않았습니다.")
    try:
        conn = psycopg2.connect(dsn=DATABASE_URL, cursor_factory=RealDictCursor)
        return conn
    except Exception as e:
        print(f"데이터베이스 연결 실패: {e}")
        raise e


def create_tables():
    """필요한 테이블을 생성합니다"""
    conn = get_db_connection()
    cur = conn.cursor()

    # 사용자 테이블 생성
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP,
            google_id VARCHAR(255) UNIQUE
        )
    """)

    # 기존 테이블에 google_id 컬럼이 없으면 추가
    try:
        cur.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='users' AND column_name='google_id'
        """)
        if not cur.fetchone():
            cur.execute("""
                ALTER TABLE users
                ADD COLUMN google_id VARCHAR(255) UNIQUE
            """)
            print("users 테이블에 google_id 컬럼 추가 완료")
    except Exception as e:
        print(f"google_id 컬럼 추가 중 오류 발생: {e}")

    conn.commit()
    cur.close()
    conn.close()
    print("테이블 생성 완료")
