import os
import sys
from pydantic_settings import BaseSettings

# .env lives in the parent project root (vc2/)
_ENV_FILE = os.path.join(os.path.dirname(__file__), "..", "..", ".env")


class Settings(BaseSettings):
    AZURE_STORAGE_CONNECTION_STRING: str = ""
    TABLE_PREFIX: str = "VC2026"

    model_config = {
        "env_file": _ENV_FILE,
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()

if not settings.AZURE_STORAGE_CONNECTION_STRING:
    print(f"FATAL: AZURE_STORAGE_CONNECTION_STRING not set. Checked: {os.path.abspath(_ENV_FILE)}")
    sys.exit(1)
