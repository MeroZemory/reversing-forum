from datetime import datetime
from .database import get_db_connection
from .utils import verify_password, get_password_hash
from .models import UserLogin, UserCreate


async def authenticate_user(user_login: UserLogin) -> dict:
    """사용자 인증 함수
    
    Args:
        user_login: 사용자 로그인 정보
        
    Returns:
        인증 성공 시 사용자 정보, 실패 시 None
    """
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # 사용자 이름으로 사용자 정보 조회
        cur.execute("SELECT id, username, email, password_hash, is_active FROM users WHERE username = %s", (user_login.username, ))

        user = cur.fetchone()

        # 사용자가 존재하지 않거나 비활성 상태인 경우
        if not user or not user['is_active']:
            return None

        # 비밀번호 확인
        if not verify_password(user_login.password, user['password_hash']):
            return None

        # 마지막 로그인 시간 업데이트
        cur.execute("UPDATE users SET last_login = %s WHERE id = %s", (datetime.now(), user['id']))
        conn.commit()

        # 비밀번호 해시는 제외하고 사용자 정보 반환
        return {"id": user['id'], "username": user['username'], "email": user['email'], "is_active": user['is_active']}

    except Exception as e:
        print(f"인증 과정에서 오류 발생: {e}")
        return None
    finally:
        if conn:
            conn.close()


async def register_user(user_create: UserCreate) -> dict:
    """새로운 사용자 등록 함수
    
    Args:
        user_create: 사용자 생성 정보
        
    Returns:
        등록 성공 시 사용자 정보, 실패 시 에러 메시지
    """
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # 사용자 이름 중복 확인
        cur.execute("SELECT id FROM users WHERE username = %s", (user_create.username, ))
        if cur.fetchone():
            return {"error": "이미 사용 중인 사용자 이름입니다."}

        # 이메일 중복 확인
        cur.execute("SELECT id FROM users WHERE email = %s", (user_create.email, ))
        if cur.fetchone():
            return {"error": "이미 사용 중인 이메일입니다."}

        # 비밀번호 해싱
        password_hash = get_password_hash(user_create.password)

        # 사용자 등록
        cur.execute(
            """
            INSERT INTO users (username, email, password_hash, created_at)
            VALUES (%s, %s, %s, %s)
            RETURNING id, username, email, is_active, created_at
            """, (user_create.username, user_create.email, password_hash, datetime.now()))

        new_user = cur.fetchone()
        conn.commit()

        return {"id": new_user['id'], "username": new_user['username'], "email": new_user['email'], "is_active": new_user['is_active'], "created_at": new_user['created_at']}

    except Exception as e:
        if conn:
            conn.rollback()
        print(f"사용자 등록 과정에서 오류 발생: {e}")
        return {"error": f"회원가입 처리 중 오류가 발생했습니다: {str(e)}"}
    finally:
        if conn:
            conn.close()
