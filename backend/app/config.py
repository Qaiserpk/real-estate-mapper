from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://propmap:propmap@localhost:5432/propmap"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    upload_dir: str = "/app/uploads"

    # Auth. secret_key MUST be overridden in production (env: SECRET_KEY).
    secret_key: str = "dev-insecure-change-me"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 days

    # First-run platform admin, created on startup if it doesn't exist yet.
    seed_admin_email: str = "admin@propmap.pk"
    seed_admin_password: str = "admin1234"
    seed_admin_name: str = "Platform Admin"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
