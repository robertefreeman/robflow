from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, Optional, Sequence


@dataclass(frozen=True)
class InferenceConfig:
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    default_model: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = 30.0
    max_retries: int = 2


@dataclass(frozen=True)
class WorkerConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    database_url: Optional[str] = None
    poll_interval_seconds: float = 2.0
    lease_seconds: int = 60
    run_once: bool = False
    inference: InferenceConfig = field(default_factory=InferenceConfig)


def _load_headers(raw_headers: Optional[str]) -> Dict[str, str]:
    if not raw_headers:
        return {}
    value = json.loads(raw_headers)
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise ValueError("ROBFLOW_INFERENCE_HEADERS_JSON must be a JSON object with string values")
    return dict(value)


def create_inference_config() -> InferenceConfig:
    return InferenceConfig(
        base_url=os.getenv("ROBFLOW_INFERENCE_BASE_URL"),
        api_key=os.getenv("ROBFLOW_INFERENCE_API_KEY"),
        default_model=os.getenv("ROBFLOW_INFERENCE_DEFAULT_MODEL"),
        headers=_load_headers(os.getenv("ROBFLOW_INFERENCE_HEADERS_JSON")),
        timeout_seconds=float(os.getenv("ROBFLOW_INFERENCE_TIMEOUT_SECONDS", "30")),
        max_retries=int(os.getenv("ROBFLOW_INFERENCE_MAX_RETRIES", "2")),
    )


def create_config() -> WorkerConfig:
    return WorkerConfig(
        host=os.getenv("WORKER_ADK_HOST", "127.0.0.1"),
        port=int(os.getenv("WORKER_ADK_PORT", "8080")),
        database_url=os.getenv("DATABASE_URL"),
        poll_interval_seconds=float(os.getenv("WORKER_ADK_POLL_INTERVAL_SECONDS", "2")),
        lease_seconds=int(os.getenv("WORKER_ADK_LEASE_SECONDS", "60")),
        run_once=os.getenv("WORKER_ADK_RUN_ONCE", "").lower() in {"1", "true", "yes"},
        inference=create_inference_config(),
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = set(argv or [])
    config = create_config()
    print(f"robflow worker-adk ready on {config.host}:{config.port}")
    if not config.database_url:
        print("DATABASE_URL is not set; worker runtime polling is disabled.")
        return 0

    from .runtime import create_postgres_worker

    worker = create_postgres_worker(config.database_url)
    if "--once" in args or config.run_once:
        worker.run_once()
    else:
        worker.run_forever(config.poll_interval_seconds)
    return 0
