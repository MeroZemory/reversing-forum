FROM python:3.11-slim

WORKDIR /app

# pyproject.toml 복사
COPY pyproject.toml .
RUN pip install -e .

COPY . .