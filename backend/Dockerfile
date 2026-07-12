FROM python:3.12-slim

WORKDIR /app

# GeoAlchemy2/psycopg2 runtime deps are covered by psycopg2-binary; keep image lean.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
