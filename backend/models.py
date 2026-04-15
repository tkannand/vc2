from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
import re


class OTPRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v


class OTPVerify(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    otp: str = Field(..., min_length=6, max_length=6)
    language: Optional[str] = "en"

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("otp")
    @classmethod
    def validate_otp(cls, v):
        if not re.match(r"^\d{6}$", v):
            raise ValueError("OTP must be exactly 6 digits")
        return v

    @field_validator("language")
    @classmethod
    def validate_language(cls, v):
        if v not in ("en", "ta"):
            raise ValueError("Language must be 'en' or 'ta'")
        return v


class RoleSelectRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    role: str
    ward: Optional[str] = None
    booth: Optional[str] = None
    language: Optional[str] = "en"

    @field_validator("phone")
    @classmethod
    def validate_phone_role(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v):
        if v not in ("superadmin", "ward", "booth", "telecaller"):
            raise ValueError("Role must be superadmin, ward, booth, or telecaller")
        return v

    @field_validator("language")
    @classmethod
    def validate_language_role(cls, v):
        if v not in ("en", "ta"):
            raise ValueError("Language must be 'en' or 'ta'")
        return v


class AddUserRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    name: str = Field(..., min_length=1, max_length=100)
    role: str
    ward: Optional[str] = None
    booth: Optional[str] = None

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v):
        if v not in ("superadmin", "ward", "booth", "telecaller"):
            raise ValueError("Role must be superadmin, ward, booth, or telecaller")
        return v


class BulkRemoveRequest(BaseModel):
    phones: list[str] = Field(..., min_length=1, max_length=200)

    @field_validator("phones")
    @classmethod
    def validate_phones(cls, v):
        for p in v:
            if not re.match(r"^\d{10}$", p):
                raise ValueError(f"Invalid phone number: {p}")
        return v


class UpdateCallStatus(BaseModel):
    status: str
    notes: Optional[str] = Field(None, max_length=1000)

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        valid = ("called", "didnt_answer", "skipped", "not_called")
        if v not in valid:
            raise ValueError(f"Status must be one of: {', '.join(valid)}")
        return v

    @field_validator("notes")
    @classmethod
    def sanitize_notes(cls, v):
        if v:
            v = re.sub(r"<[^>]+>", "", v)
            v = v.strip()
        return v


class ActivityLogEntry(BaseModel):
    action: str
    screen: Optional[str] = None
    details: Optional[str] = None
    duration_ms: Optional[int] = None
    voter_id: Optional[str] = None


class HeartbeatEntry(BaseModel):
    screen: str
    duration_ms: int
    lat: Optional[float] = None
    lng: Optional[float] = None


class UpdateUserSecurityRequest(BaseModel):
    active: Optional[bool] = None
    schedule: Optional[str] = None           # JSON string or empty string
    geo_tracking: Optional[bool] = None


class CheckUserRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v


class PinSetupRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    pin: str = Field(..., min_length=4, max_length=4)
    pin_confirm: str = Field(..., min_length=4, max_length=4)
    language: Optional[str] = "en"

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("pin", "pin_confirm")
    @classmethod
    def validate_pin(cls, v):
        if not re.match(r"^\d{4}$", v):
            raise ValueError("PIN must be exactly 4 digits")
        return v


class PinLoginRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    pin: str = Field(..., min_length=4, max_length=4)
    language: Optional[str] = "en"

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("pin")
    @classmethod
    def validate_pin(cls, v):
        if not re.match(r"^\d{4}$", v):
            raise ValueError("PIN must be exactly 4 digits")
        return v


class ForgotPinResetRequest(BaseModel):
    phone: str = Field(..., min_length=10, max_length=10)
    otp: str = Field(..., min_length=6, max_length=6)
    new_pin: str = Field(..., min_length=4, max_length=4)
    new_pin_confirm: str = Field(..., min_length=4, max_length=4)
    language: Optional[str] = "en"

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        if not re.match(r"^\d{10}$", v):
            raise ValueError("Phone must be exactly 10 digits")
        return v

    @field_validator("otp")
    @classmethod
    def validate_otp(cls, v):
        if not re.match(r"^\d{6}$", v):
            raise ValueError("OTP must be exactly 6 digits")
        return v

    @field_validator("new_pin", "new_pin_confirm")
    @classmethod
    def validate_pin(cls, v):
        if not re.match(r"^\d{4}$", v):
            raise ValueError("PIN must be exactly 4 digits")
        return v


class NoticeDeliverRequest(BaseModel):
    voter_ids: list[str] = Field(..., min_length=1, max_length=200)

    @field_validator("voter_ids")
    @classmethod
    def validate_voter_ids(cls, v):
        if not v:
            raise ValueError("At least one voter ID required")
        return v


class UpdatePersonRequest(BaseModel):
    phones: Optional[List[str]] = Field(None, max_length=4)
    party_support: Optional[str] = Field(None, max_length=100)

    @field_validator("phones")
    @classmethod
    def validate_phones(cls, v):
        if v is None:
            return v
        if len(v) > 4:
            raise ValueError("Maximum 4 phone numbers allowed")
        for phone in v:
            if phone and not re.match(r"^\d{10}$", phone):
                raise ValueError(f"Each phone must be exactly 10 digits, got: {phone}")
        return v

    @field_validator("party_support")
    @classmethod
    def sanitize_party_support(cls, v):
        if v is not None:
            v = re.sub(r"<[^>]+>", "", v)
            v = v.strip()
        return v


class NoticeToggleRequest(BaseModel):
    enabled: bool
