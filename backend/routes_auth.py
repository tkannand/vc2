import structlog
from fastapi import APIRouter, Request, Response
from backend.models import (
    OTPRequest, OTPVerify, RoleSelectRequest,
    CheckUserRequest, PinSetupRequest, PinLoginRequest, ForgotPinResetRequest,
    VerifyDevicePinRequest,
)
from backend.auth import (
    request_otp, verify_otp, select_role, update_user_language, validate_session,
    check_user_status, setup_pin, login_with_pin, forgot_pin_reset, verify_and_bind_device,
)
from backend.middleware import get_client_ip
from backend import storage
from backend.translations import get_all_translations

logger = structlog.get_logger()
router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/check-user")
async def api_check_user(body: CheckUserRequest):
    return check_user_status(body.phone)


@router.post("/setup-pin")
async def api_setup_pin(body: PinSetupRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    result = setup_pin(body.phone, body.pin, body.pin_confirm, ip, device_id=body.device_id or "")

    if result.get("multi_role"):
        return result

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language
        response.set_cookie(
            key="session_token", value=result["token"],
            httponly=True, samesite="strict", max_age=86400, path="/",
        )
    return result


@router.post("/login-pin")
async def api_login_pin(body: PinLoginRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    result = login_with_pin(body.phone, body.pin, ip, device_id=body.device_id or "")

    if result.get("multi_role"):
        return result

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language
        response.set_cookie(
            key="session_token", value=result["token"],
            httponly=True, samesite="strict", max_age=86400, path="/",
        )
    return result


@router.post("/forgot-pin/request-otp")
async def api_forgot_pin_request_otp(body: OTPRequest, request: Request):
    ip = get_client_ip(request)
    result = await request_otp(body.phone, ip)
    return result


@router.post("/forgot-pin/reset")
async def api_forgot_pin_reset(body: ForgotPinResetRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    result = forgot_pin_reset(body.phone, body.otp, body.new_pin, body.new_pin_confirm, ip, device_id=body.device_id or "")

    if result.get("multi_role"):
        return result

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language
        response.set_cookie(
            key="session_token", value=result["token"],
            httponly=True, samesite="strict", max_age=86400, path="/",
        )
    return result


@router.post("/request-otp")
async def api_request_otp(body: OTPRequest, request: Request):
    ip = get_client_ip(request)
    result = await request_otp(body.phone, ip)
    return result


@router.post("/verify-otp")
async def api_verify_otp(body: OTPVerify, request: Request, response: Response):
    ip = get_client_ip(request)
    result = verify_otp(body.phone, body.otp, ip, device_id=body.device_id or "")

    if result.get("multi_role"):
        return result

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language

        response.set_cookie(
            key="session_token",
            value=result["token"],
            httponly=True,
            samesite="strict",
            max_age=86400,
            path="/",
        )

    return result


@router.post("/select-role")
async def api_select_role(body: RoleSelectRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    result = select_role(body.phone, body.role, ip, device_id=body.device_id or "")

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language

        response.set_cookie(
            key="session_token",
            value=result["token"],
            httponly=True,
            samesite="strict",
            max_age=86400,
            path="/",
        )

    return result


@router.post("/logout")
async def api_logout(request: Request, response: Response):
    token = request.cookies.get("session_token", "")
    if token:
        user = validate_session(token)
        if user:
            storage.log_activity(user.get("phone", ""), "logout", ip=get_client_ip(request))
        storage.delete_session(token)

    response.delete_cookie("session_token", path="/")
    return {"success": True}


@router.get("/me")
async def api_me(request: Request):
    # This is a public path so middleware does not set request.state.user.
    # Validate the session cookie directly to restore session on page refresh.
    token = request.cookies.get("session_token", "")
    if not token:
        return {"authenticated": False}

    user = validate_session(token)
    if not user:
        return {"authenticated": False}

    db_user = storage.get_user(user.get("phone", ""))
    if not db_user:
        return {"authenticated": False}

    return {
        "authenticated": True,
        "user": {
            "phone": user.get("phone", ""),
            "name": db_user.get("name", ""),
            "role": user.get("role", ""),
            "ward": user.get("ward", ""),
            "booth": user.get("booth", ""),
            "language": db_user.get("language", "en"),
            "geo_tracking": bool(db_user.get("geo_tracking", True)),
        },
    }


@router.post("/verify-device-pin")
async def api_verify_device_pin(body: VerifyDevicePinRequest, request: Request, response: Response):
    """Second step for new device binding — verify device code and create session."""
    ip = get_client_ip(request)
    result = verify_and_bind_device(body.phone, body.pin, body.device_id, body.device_code, ip)

    if result.get("multi_role"):
        return result

    if result.get("success") and result.get("token"):
        if body.language and body.language in ("en", "ta"):
            update_user_language(body.phone, body.language)
            if "user" in result:
                result["user"]["language"] = body.language
        response.set_cookie(
            key="session_token", value=result["token"],
            httponly=True, samesite="strict", max_age=86400, path="/",
        )
    return result


@router.get("/translations/{lang}")
async def api_translations(lang: str):
    if lang not in ("en", "ta"):
        lang = "en"
    return get_all_translations(lang)
