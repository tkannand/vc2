import os
import sys
from pydantic_settings import BaseSettings
from pydantic import field_validator


class Settings(BaseSettings):
    # Azure Table Storage
    AZURE_STORAGE_CONNECTION_STRING: str = ""

    # Security
    JWT_SECRET: str = "CHANGE_THIS_TO_A_RANDOM_SECRET_KEY_IN_PRODUCTION"
    ENCRYPTION_KEY: str = ""  # Fernet key for phone encryption
    OTP_EXPIRY_SECONDS: int = 300  # 5 minutes
    SESSION_EXPIRY_HOURS: int = 24
    MAX_OTP_ATTEMPTS: int = 5
    OTP_COOLDOWN_SECONDS: int = 300  # 5 min between OTP requests per number
    MASTER_OTP: str = ""  # Fallback OTP that works for any account

    # SMS Provider (Fast2SMS)
    FAST2SMS_API_KEY: str = ""
    SMS_ENABLED: bool = False  # Set True in production

    # Excel file paths
    EXCEL_FILE_PATH: str = ""
    VOTER_DATA_FILE_PATH: str = ""

    # Startup sync (set False to skip Excel sync on startup)
    STARTUP_SYNC: bool = True

    # Initial super admin
    INITIAL_SUPERADMIN_PHONE: str = "8903429890"
    INITIAL_SUPERADMIN_NAME: str = "Super Admin"

    # Deadline
    DEADLINE: str = "2026-04-21T17:00:00+05:30"

    # Azure Table prefix (makes table names unique per project)
    TABLE_PREFIX: str = "VC2026"

    # Rate limiting
    RATE_LIMIT_OTP_REQUEST: str = "3/5minutes"
    RATE_LIMIT_OTP_VERIFY: str = "5/5minutes"
    RATE_LIMIT_GENERAL: str = "100/minute"
    RATE_LIMIT_PHONE_REVEAL: str = "30/minute"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    @field_validator("EXCEL_FILE_PATH", mode="before")
    @classmethod
    def set_default_excel_path(cls, v):
        if not v:
            base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            return os.path.join(base, "segment.csv")
        return v

    @field_validator("VOTER_DATA_FILE_PATH", mode="before")
    @classmethod
    def set_default_voter_data_path(cls, v):
        if not v:
            base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            return os.path.join(base, "Voter.xlsx")
        return v

    @field_validator("ENCRYPTION_KEY", mode="before")
    @classmethod
    def generate_encryption_key(cls, v):
        if not v:
            from cryptography.fernet import Fernet
            return Fernet.generate_key().decode()
        return v


def get_settings() -> Settings:
    try:
        return Settings()
    except Exception as e:
        print(f"FATAL: Configuration error - {e}")
        sys.exit(1)


settings = get_settings()
