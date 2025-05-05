FROM python:3.11-slim

WORKDIR /app

# pyproject.toml 복사
COPY pyproject.toml .

# 필요한 패키지 직접 설치
RUN pip install --no-cache-dir fastapi>=0.104.0 uvicorn[standard]>=0.23.2 pydantic>=2.4.2

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]