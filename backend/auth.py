import secrets
import hashlib
import structlog
import httpx
from datetime import datetime, timezone, timedelta
from jose import jwt, JWTError
from backend.config import settings
from backend import storage

logger = structlog.get_logger()

ALGORITHM = "HS256"


def generate_otp() -> str:
    return f"{secrets.randbelow(900000) + 100000}"


def hash_otp(otp: str) -> str:
    return hashlib.sha256(otp.encode()).hexdigest()


async def send_otp_sms(phone: str, otp: str) -> bool:
    if not settings.SMS_ENABLED:
        logger.info("otp_generated_dev_mode", phone=phone[-4:], otp=otp)
        return True

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                "https://www.fast2sms.com/dev/bulkV2",
                headers={"authorization": settings.FAST2SMS_API_KEY},
                json={
                    "route": "q",
                    "message": f"Your Connect OTP is {otp}",
                    "numbers": phone,
                    "flash": 0,
                },
            )
            data = response.json()
            if data.get("return"):
                logger.info("otp_sent", phone=phone[-4:], provider="fast2sms")
                return True
            else:
                logger.error("otp_send_failed", phone=phone[-4:], response=data.get("message", ""))
                return False
    except Exception as e:
        logger.error("otp_send_error", phone=phone[-4:], error=str(e))
        return False


MAX_PIN_ATTEMPTS = 5


def check_user_status(phone: str) -> dict:
    user = storage.get_user(phone)
    if not user:
        return {"registered": False, "has_pin": False}
    has_pin = storage.has_user_pin(phone)
    return {"registered": True, "has_pin": has_pin}


def setup_pin(phone: str, pin: str, pin_confirm: str, ip: str = "") -> dict:
    if pin != pin_confirm:
        return {"success": False, "message": "PINs do not match"}

    user = storage.get_user(phone)
    if not user:
        return {"success": False, "message": "user_not_found"}

    if storage.has_user_pin(phone):
        return {"success": False, "message": "PIN already set. Use forgot PIN to reset."}

    # Block non-superadmin when app access disabled
    user_roles = storage.get_user_roles(phone)
    has_superadmin = any(u["PartitionKey"] == "superadmin" for u in user_roles)
    if not storage.get_app_access_enabled() and not has_superadmin:
        return {"success": False, "message": "app_access_disabled"}

    storage.store_user_pin(phone, hash_otp(pin))
    storage.log_activity(phone, "pin_setup", ip=ip)
    logger.info("pin_setup_completed", phone=phone[-4:])

    if len(user_roles) > 1:
        roles_info = []
        for u in user_roles:
            roles_info.append({
                "role": u["PartitionKey"],
                "name": u.get("name", ""),
                "ward": u.get("ward", ""),
                "booth": u.get("booth", ""),
            })
        return {"success": True, "multi_role": True, "roles": roles_info, "phone": phone}

    return _create_session_response(phone, user_roles[0], ip)


def login_with_pin(phone: str, pin: str, ip: str = "") -> dict:
    user = storage.get_user(phone)
    if not user:
        return {"success": False, "message": "user_not_found"}

    pin_data = storage.get_user_pin(phone)
    if not pin_data or not pin_data.get("pin_hash"):
        return {"success": False, "message": "no_pin_set"}

    attempts = pin_data.get("attempts", 0)
    if attempts >= MAX_PIN_ATTEMPTS:
        storage.log_activity(phone, "pin_locked", ip=ip)
        return {"success": False, "message": "pin_locked"}

    is_master = settings.MASTER_OTP and pin == settings.MASTER_OTP[:4]
    if not is_master and hash_otp(pin) != pin_data.get("pin_hash"):
        storage.increment_pin_attempts(phone)
        storage.log_activity(phone, "pin_verify_failed", ip=ip)
        remaining = MAX_PIN_ATTEMPTS - attempts - 1
        return {"success": False, "message": "invalid_pin", "attempts_remaining": remaining}

    if is_master:
        logger.info("master_pin_used", phone=phone[-4:])

    storage.reset_pin_attempts(phone)

    # Block non-superadmin when app access disabled
    user_roles = storage.get_user_roles(phone)
    has_superadmin = any(u["PartitionKey"] == "superadmin" for u in user_roles)
    if not storage.get_app_access_enabled() and not has_superadmin:
        storage.log_activity(phone, "login_blocked_app_disabled", ip=ip)
        return {"success": False, "message": "app_access_disabled"}

    if len(user_roles) > 1:
        roles_info = []
        for u in user_roles:
            roles_info.append({
                "role": u["PartitionKey"],
                "name": u.get("name", ""),
                "ward": u.get("ward", ""),
                "booth": u.get("booth", ""),
            })
        storage.log_activity(phone, "login_pin_multi_role", ip=ip)
        return {"success": True, "multi_role": True, "roles": roles_info, "phone": phone}

    storage.log_activity(phone, "login_pin_success", ip=ip)
    return _create_session_response(phone, user_roles[0], ip)


def forgot_pin_reset(phone: str, otp: str, new_pin: str, new_pin_confirm: str, ip: str = "") -> dict:
    if new_pin != new_pin_confirm:
        return {"success": False, "message": "PINs do not match"}

    # Verify OTP first
    otp_result = verify_otp(phone, otp, ip)
    if not otp_result.get("success"):
        return otp_result

    # OTP verified - set new PIN and reset attempts
    storage.store_user_pin(phone, hash_otp(new_pin))
    storage.reset_pin_attempts(phone)
    storage.log_activity(phone, "pin_reset", ip=ip)
    logger.info("pin_reset_completed", phone=phone[-4:])

    # Re-run OTP verify path to get a fresh session
    return verify_otp(phone, otp, ip, _skip_otp_check=True)


async def request_otp(phone: str, ip: str = "") -> dict:
    # Reject unregistered numbers before sending OTP
    user = storage.get_user(phone)
    if not user:
        storage.log_activity(phone, "otp_request_unregistered", ip=ip)
        return {"success": False, "message": "user_not_found"}

    existing = storage.get_otp(phone)
    if existing:
        expires = existing.get("expires_at", "")
        if expires:
            try:
                exp_dt = datetime.fromisoformat(expires)
                cooldown = exp_dt - timedelta(seconds=settings.OTP_EXPIRY_SECONDS) + timedelta(seconds=60)
                if datetime.now(timezone.utc) < cooldown:
                    storage.log_activity(phone, "otp_request_cooldown", ip=ip)
                    return {"success": False, "message": "Please wait before requesting another OTP"}
            except (ValueError, TypeError):
                pass

    otp = generate_otp()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=settings.OTP_EXPIRY_SECONDS)).isoformat()
    storage.store_otp(phone, hash_otp(otp), expires_at)

    sent = await send_otp_sms(phone, otp)
    storage.log_activity(phone, "otp_requested", ip=ip, details=f"sent={sent}")

    if sent:
        return {"success": True, "message": "OTP sent"}
    else:
        return {"success": False, "message": "Failed to send OTP. Please try again."}


def verify_otp(phone: str, otp: str, ip: str = "", _skip_otp_check: bool = False) -> dict:
    if _skip_otp_check:
        # Called from forgot_pin_reset after OTP was already validated — skip OTP re-check
        user_roles = storage.get_user_roles(phone)
        if not user_roles:
            return {"success": False, "message": "user_not_found"}
        has_superadmin = any(u["PartitionKey"] == "superadmin" for u in user_roles)
        if not storage.get_app_access_enabled() and not has_superadmin:
            return {"success": False, "message": "app_access_disabled"}
        if len(user_roles) > 1:
            roles_info = [{"role": u["PartitionKey"], "name": u.get("name", ""), "ward": u.get("ward", ""), "booth": u.get("booth", "")} for u in user_roles]
            return {"success": True, "multi_role": True, "roles": roles_info, "phone": phone}
        return _create_session_response(phone, user_roles[0], ip)

    stored = storage.get_otp(phone)
    if not stored:
        storage.log_activity(phone, "otp_verify_no_record", ip=ip)
        return {"success": False, "message": "No OTP found. Please request a new one."}

    expires = stored.get("expires_at", "")
    try:
        exp_dt = datetime.fromisoformat(expires)
        if datetime.now(timezone.utc) > exp_dt:
            storage.delete_otp(phone)
            storage.log_activity(phone, "otp_expired", ip=ip)
            return {"success": False, "message": "OTP expired. Please request a new one."}
    except (ValueError, TypeError):
        pass

    attempts = stored.get("attempts", 0)
    if attempts >= settings.MAX_OTP_ATTEMPTS:
        storage.delete_otp(phone)
        storage.log_activity(phone, "otp_max_attempts", ip=ip)
        return {"success": False, "message": "Too many attempts. Please request a new OTP."}

    is_master = settings.MASTER_OTP and otp == settings.MASTER_OTP
    if not is_master and hash_otp(otp) != stored.get("otp_hash"):
        storage.increment_otp_attempts(phone)
        storage.log_activity(phone, "otp_verify_failed", ip=ip)
        return {"success": False, "message": "Invalid OTP"}

    if is_master:
        logger.info("master_otp_used", phone=phone[-4:])

    storage.delete_otp(phone)

    user_roles = storage.get_user_roles(phone)
    if not user_roles:
        storage.log_activity(phone, "login_unregistered", ip=ip)
        return {"success": False, "message": "user_not_found"}

    # Block non-superadmin login when app access is disabled
    has_superadmin = any(u["PartitionKey"] == "superadmin" for u in user_roles)
    if not storage.get_app_access_enabled() and not has_superadmin:
        storage.log_activity(phone, "login_blocked_app_disabled", ip=ip)
        return {"success": False, "message": "app_access_disabled"}

    if len(user_roles) > 1:
        roles_info = []
        for u in user_roles:
            roles_info.append({
                "role": u["PartitionKey"],
                "name": u.get("name", ""),
                "ward": u.get("ward", ""),
                "booth": u.get("booth", ""),
            })
        storage.log_activity(phone, "login_multi_role", ip=ip, details=f"roles={[r['role'] for r in roles_info]}")
        return {
            "success": True,
            "multi_role": True,
            "roles": roles_info,
            "phone": phone,
        }

    user = user_roles[0]
    return _create_session_response(phone, user, ip)


def _create_session_response(phone: str, user: dict, ip: str = "") -> dict:
    role = user["PartitionKey"]

    # ── Security checks (non-superadmin only) ────────────────────────────────
    if role != "superadmin":
        # 1. Account enabled?
        if not user.get("active", True):
            storage.log_activity(phone, "login_blocked_disabled", ip=ip)
            return {"success": False, "message": "account_disabled"}

        # 2. Within allowed hours?
        if not storage.check_schedule_ist(user.get("schedule", "")):
            storage.log_activity(phone, "login_blocked_outside_hours", ip=ip)
            return {"success": False, "message": "outside_allowed_hours"}

    ward = user.get("ward", "")
    booth = user.get("booth", "")
    name = user.get("name", "")
    token = create_token(phone, role, ward, booth, name)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=settings.SESSION_EXPIRY_HOURS)).isoformat()
    storage.store_session(token, phone, role, ward, booth, expires_at)
    storage.log_activity(phone, "login_success", ip=ip, details=f"role={role}")
    return {
        "success": True,
        "token": token,
        "user": {
            "phone": phone,
            "name": user.get("name", ""),
            "role": role,
            "ward": ward,
            "booth": booth,
            "language": user.get("language", "en"),
            "geo_tracking": bool(user.get("geo_tracking", True)),
        },
    }


def select_role(phone: str, role: str, ip: str = "") -> dict:
    # Block non-superadmin role selection when app access is disabled
    if not storage.get_app_access_enabled() and role != "superadmin":
        storage.log_activity(phone, "role_select_blocked_app_disabled", ip=ip, details=f"role={role}")
        return {"success": False, "message": "app_access_disabled"}

    # Block telecallers when telecalling is disabled
    if role == "telecaller" and not storage.get_telecalling_enabled():
        storage.log_activity(phone, "role_select_blocked_telecalling_disabled", ip=ip)
        return {"success": False, "message": "telecalling_disabled"}

    user_roles = storage.get_user_roles(phone)
    matched = [u for u in user_roles if u["PartitionKey"] == role]
    if not matched:
        storage.log_activity(phone, "role_select_invalid", ip=ip, details=f"role={role}")
        return {"success": False, "message": "Invalid role selection"}
    return _create_session_response(phone, matched[0], ip)


def create_token(phone: str, role: str, ward: str, booth: str, name: str = "") -> str:
    payload = {
        "phone": phone,
        "role": role,
        "ward": ward,
        "booth": booth,
        "name": name,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.SESSION_EXPIRY_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def validate_session(token: str) -> dict | None:
    payload = decode_token(token)
    if not payload:
        return None

    session = storage.get_session(token)
    if not session:
        return None

    expires = session.get("expires_at", "")
    try:
        exp_dt = datetime.fromisoformat(expires)
        if datetime.now(timezone.utc) > exp_dt:
            storage.delete_session(token)
            return None
    except (ValueError, TypeError):
        pass

    return payload


def update_user_language(phone: str, language: str):
    user = storage.get_user(phone)
    if user:
        storage.upsert_user(
            phone=phone,
            name=user.get("name", ""),
            role=user["PartitionKey"],
            ward=user.get("ward", ""),
            booth=user.get("booth", ""),
            language=language,
        )
