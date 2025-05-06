from datetime import datetime
from .database import get_db_connection
from .utils import verify_password
from .models import UserLogin

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
        cur.execute(
            "SELECT id, username, email, password_hash, is_active FROM users WHERE username = %s",
            (user_login.username,)
        )
        
        user = cur.fetchone()
        
        # 사용자가 존재하지 않거나 비활성 상태인 경우
        if not user or not user['is_active']:
            return None
        
        # 비밀번호 확인
        if not verify_password(user_login.password, user['password_hash']):
            return None
            
        # 마지막 로그인 시간 업데이트
        cur.execute(
            "UPDATE users SET last_login = %s WHERE id = %s",
            (datetime.now(), user['id'])
        )
        conn.commit()
        
        # 비밀번호 해시는 제외하고 사용자 정보 반환
        return {
            "id": user['id'],
            "username": user['username'],
            "email": user['email'],
            "is_active": user['is_active']
        }
        
    except Exception as e:
        print(f"인증 과정에서 오류 발생: {e}")
        return None
    finally:
        if conn:
            conn.close() 