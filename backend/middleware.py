import structlog
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from backend.auth import validate_session
from backend.activity import log_unauthorized_access
from backend import storage

logger = structlog.get_logger()

PUBLIC_PATHS = {
    "/api/auth/request-otp", "/api/auth/verify-otp", "/api/auth/select-role", "/api/auth/me",
    "/api/auth/check-user", "/api/auth/setup-pin", "/api/auth/login-pin",
    "/api/auth/forgot-pin/request-otp", "/api/auth/forgot-pin/reset",
    "/api/auth/verify-device-pin",
    "/api/health", "/api/translations",
}
STATIC_PREFIXES = ("/", "/css/", "/js/", "/icons/", "/manifest.json", "/sw.js", "/favicon")


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        if not path.startswith("/api/"):
            return await call_next(request)

        if path in PUBLIC_PATHS:
            return await call_next(request)

        token = request.cookies.get("session_token", "")
        if not token:
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]

        if not token:
            ip = get_client_ip(request)
            log_unauthorized_access(ip, path, "no_token")
            return JSONResponse(status_code=401, content={"detail": "Not authenticated"})

        user = validate_session(token)
        if not user:
            ip = get_client_ip(request)
            log_unauthorized_access(ip, path, "invalid_token")
            return JSONResponse(status_code=401, content={"detail": "Session expired or invalid"})

        request.state.user = user
        request.state.token = token
        request.state.ip = get_client_ip(request)

        role = user.get("role", "")

        # ── Security enforcement on every authenticated request ───────────
        # Superadmins always pass through.
        if role != "superadmin":
            # 1. Full app access — blocks everyone except superadmin
            if not storage.check_app_access_fast():
                ip = get_client_ip(request)
                log_unauthorized_access(ip, path, f"app_access_disabled role={role}")
                return JSONResponse(status_code=403, content={"detail": "app_access_disabled"})

            # 2. Telecalling — blocks telecaller role only
            if role == "telecaller" and not storage.check_telecalling_fast():
                ip = get_client_ip(request)
                log_unauthorized_access(ip, path, "telecalling_disabled")
                return JSONResponse(status_code=403, content={"detail": "telecalling_disabled"})

            # 3. Per-user: account active + login-hours schedule (30 s cache)
            phone = user.get("phone", "")
            sec = storage.get_user_security_fast(phone)
            if not sec.get("active", True):
                ip = get_client_ip(request)
                log_unauthorized_access(ip, path, f"account_disabled user={phone[-4:]}")
                return JSONResponse(status_code=403, content={"detail": "account_disabled"})
            if not storage.check_schedule_ist(sec.get("schedule", "")):
                ip = get_client_ip(request)
                log_unauthorized_access(ip, path, f"outside_allowed_hours user={phone[-4:]}")
                return JSONResponse(status_code=403, content={"detail": "outside_allowed_hours"})

        response = await call_next(request)
        return response


def require_role(request: Request, *roles: str):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.get("role") not in roles:
        ip = get_client_ip(request)
        log_unauthorized_access(ip, str(request.url.path), f"role={user.get('role')}_required={'|'.join(roles)}")
        raise HTTPException(status_code=403, detail="Access denied")
    return user


def require_booth_access(request: Request, ward: str, booth: str):
    user = require_role(request, "booth", "ward", "telecaller", "superadmin")
    role = user.get("role")

    if role == "booth":
        if user.get("ward") != ward or user.get("booth") != booth:
            ip = get_client_ip(request)
            log_unauthorized_access(
                ip, str(request.url.path),
                f"booth_worker_cross_access: user_booth={user.get('booth')}_requested={booth}"
            )
            raise HTTPException(status_code=403, detail="Access denied to this booth")

    elif role in ("ward", "telecaller"):
        if user.get("ward") != ward:
            ip = get_client_ip(request)
            log_unauthorized_access(
                ip, str(request.url.path),
                f"ward_user_cross_access: user_ward={user.get('ward')}_requested={ward}"
            )
            raise HTTPException(status_code=403, detail="Access denied to this ward")

    return user


def require_ward_access(request: Request, ward: str):
    user = require_role(request, "ward", "telecaller", "superadmin")
    role = user.get("role")

    if role in ("ward", "telecaller") and user.get("ward") != ward:
        ip = get_client_ip(request)
        log_unauthorized_access(
            ip, str(request.url.path),
            f"ward_cross_access: user_ward={user.get('ward')}_requested={ward}"
        )
        raise HTTPException(status_code=403, detail="Access denied to this ward")

    return user
