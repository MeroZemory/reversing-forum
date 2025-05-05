from typing import Union

from fastapi import FastAPI, Request, HTTPException

app = FastAPI()


@app.get("/")
def read_root():
    return {"Hello": "World"}


@app.get("/items/{item_id}")
def read_item(item_id: int, q: Union[str, None] = None):
    return {"item_id": item_id, "q": q}


@app.post("/api/login")
async def login(request: Request):
    data = await request.json()
    username = data.get("username")
    password = data.get("password")

    # 실제 서비스에서는 DB에서 사용자 정보를 확인해야 합니다.
    if username == "test" and password == "1234":
        return {"username": username}
    else:
        # 인증 실패 시 401 에러 반환
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    