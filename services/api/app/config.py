"""Runtime configuration. Every model name / URL is env-configurable (see .env.example)."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_name: str = "RevenueGuard AI"
    env: str = "dev"
    demo_mode: bool = True
    # DEMO_MODE: seed the UX v2 business data (6 more customers, invoices, reminders, unlinked items) on an empty tenant
    demo_business_seed: bool = True
    # DEMO_MODE: on startup, play the showcase (PO-184 at the Rs 70,000 approval, PO-185 waiting for two approvers)
    demo_showcase_on_start: bool = False

    database_url: str = "postgresql+asyncpg://rg:rg@postgres:5432/revenueguard"
    redis_url: str = "redis://redis:6379/0"
    # When true, background jobs (case advancement, polling) run inside the API
    # process instead of the ARQ worker. Useful for single-process demos/tests.
    inline_worker: bool = False

    jwt_secret: str = "change-me-jwt-secret"
    jwt_ttl_minutes: int = 720
    internal_hmac_secret: str = "change-me-internal-hmac"
    hmac_max_skew_seconds: int = 300
    # Fernet key (urlsafe base64, 32 bytes). Generated with Fernet.generate_key().
    fernet_key: str = ""

    public_api_url: str = "http://localhost:8000"
    web_url: str = "http://localhost:3000"
    # optional: pin the public URL (e.g. https://app.example.com). Empty = use whatever URL the browser opened.
    public_web_url: str = ""
    cors_origins: str = "http://localhost:3000"

    # Services
    internal_api_url: str = "http://api:8000"  # how harness / wa-bridge reach this API
    default_tenant_slug: str = "demo"  # tenant that wa-bridge events belong to
    laya_url: str = "http://laya:8100"
    harness_url: str = "http://harness:3100"
    wa_bridge_url: str = "http://wa-bridge:3001"
    # auto | harness | builtin.  auto = harness if reachable, else (DEMO_MODE only) builtin python runner.
    agent_runner: str = "auto"

    # Object storage
    storage_backend: str = "s3"  # s3 | local
    local_storage_dir: str = "/data/objects"
    minio_endpoint: str = "http://minio:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_bucket: str = "revenueguard"

    # LLMs (all OpenAI compatible)
    nvidia_api_key: str = ""
    nim_base_url: str = "https://integrate.api.nvidia.com/v1"
    nim_model: str = "deepseek-ai/deepseek-v4.1-flash"
    nim_vision_model: str = "deepseek-ai/deepseek-v4.1-flash"
    nim_parse_model: str = "nvidia/nemotron-parse"
    nim_omni_model: str = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_model: str = "openai/gpt-oss-120b"
    groq_stt_model: str = "whisper-large-v3"
    # Speech-to-text: Sarvam AI first (Indian languages, Hinglish code-mix), then NIM omni, then Groq Whisper
    sarvam_api_key: str = ""
    sarvam_stt_model: str = "saaras:v3"  # saaras:v3 | saaras:v4 (v4 supports keyterms, ignores mode)
    sarvam_stt_mode: str = "codemix"  # v3 only: transcribe | translate | verbatim | translit | codemix
    ollama_base_url: str = "http://host.docker.internal:11434/v1"
    ollama_model: str = "qwen3:8b"
    ollama_enabled: bool = False
    llm_timeout_seconds: float = 45.0
    llm_max_cost_inr_per_call: float = 5.0

    # Google
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8000/connectors/google/callback"
    gmail_poll_seconds: int = 60
    gmail_query: str = "newer_than:14d"

    # Zoho Books
    zoho_client_id: str = ""
    zoho_client_secret: str = ""
    zoho_redirect_uri: str = "http://localhost:8000/connectors/zoho/callback"
    zoho_dc: str = "in"
    zoho_org_id: str = ""

    # Orchestrator
    case_budget_max_agent_runs: int = 12
    case_budget_max_cost_inr: float = 25.0
    agent_max_steps: int = 8
    investigation_mode: str = "adaptive"  # adaptive | fixed (fixed tool sequence; used as an eval baseline)
    agent_max_tokens: int = 40000
    agent_max_seconds: int = 120
    agent_max_cost_inr: float = 5.0
    triage_confidence_threshold: float = 0.7
    approval_two_person_threshold_inr: int = 100000

    # Observability
    log_level: str = "INFO"
    otel_enabled: bool = False
    otel_exporter_otlp_endpoint: str = ""

    eval_results_path: str = "/app/eval/results/latest.json"

    @property
    def zoho_accounts_url(self) -> str:
        return f"https://accounts.zoho.{self.zoho_dc}"

    @property
    def zoho_api_url(self) -> str:
        return f"https://www.zohoapis.{self.zoho_dc}/books/v3"

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
