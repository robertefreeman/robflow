FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY pyproject.toml README.md ./
COPY src ./src
RUN python -m pip install --no-cache-dir --upgrade pip && python -m pip install --no-cache-dir .
EXPOSE 8080
CMD ["python", "-m", "robflow_worker_adk"]
