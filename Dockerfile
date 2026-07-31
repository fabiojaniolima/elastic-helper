FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5001 \
    LOG_LEVEL=INFO \
    DB_PATH=/app/connections.db

EXPOSE 5001

CMD ["python", "app.py"]
