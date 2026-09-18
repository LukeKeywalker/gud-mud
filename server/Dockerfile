FROM python:3.12-slim
WORKDIR /app
COPY shared /app/shared
COPY server /app/server
COPY client/static /app/client/static
COPY maps /app/maps
COPY db /app/db
RUN pip install --no-cache-dir /app/server
EXPOSE 8000
CMD ["uvicorn", "mud_server.app:app", "--host", "0.0.0.0", "--port", "8000"]
