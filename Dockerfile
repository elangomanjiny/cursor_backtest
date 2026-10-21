# Multi-stage: build the React UI, then serve it from FastAPI.
# Data stays on a volume (parquet). QuestDB is optional and not required.

FROM node:22-alpine AS ui
WORKDIR /src/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
COPY webapp/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
COPY --from=ui /src/webapp/dist ./webapp/dist
RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/data /app/logs

EXPOSE 8000
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
