FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SCAR_DB=/data/scar_memory.db

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY static/ ./static/

# SQLite needs the directory to exist (no volume on free tiers).
RUN mkdir -p /data

EXPOSE 8000

# Railway injects $PORT; default to 8000 locally.
CMD ["sh", "-c", "python -m uvicorn src.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
