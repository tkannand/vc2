import os
import threading
import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from backend.config import settings
from backend import storage as store
from backend.sync import sync_voter_data_once, sync_seg_data_incremental
from backend.middleware import AuthMiddleware
from backend.routes_auth import router as auth_router
from backend.routes_booth import router as booth_router
from backend.routes_ward import router as ward_router
from backend.routes_admin import router as admin_router
from backend.routes_notice import router as notice_router
from backend.routes_coupon import router as coupon_router
from backend.routes_telecaller import router as telecaller_router
from backend.routes_schemes import router as schemes_router
from backend.models import ActivityLogEntry, HeartbeatEntry
from backend.middleware import get_client_ip

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.dev.ConsoleRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(0),
)

logger = structlog.get_logger()
limiter = Limiter(key_func=get_remote_address)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("app_starting", table_prefix=settings.TABLE_PREFIX)
    store.init_tables()

    existing = store.get_user(settings.INITIAL_SUPERADMIN_PHONE)
    if not existing:
        store.upsert_user(
            phone=settings.INITIAL_SUPERADMIN_PHONE,
            name=settings.INITIAL_SUPERADMIN_NAME,
            role="superadmin",
        )
        logger.info("initial_superadmin_created", phone=settings.INITIAL_SUPERADMIN_PHONE[-4:])

    if settings.STARTUP_SYNC:
        def run_sync():
            voter_result = sync_voter_data_once()
            logger.info("voter_data_sync_result", **voter_result)
            seg_result = sync_seg_data_incremental()
            logger.info("seg_sync_result", **seg_result)

        threading.Thread(target=run_sync, daemon=True, name="startup-sync").start()
        logger.info("startup_sync_launched_in_background")
    else:
        logger.info("startup_sync_skipped", reason="STARTUP_SYNC=False")

    yield
    logger.info("app_shutdown")


app = FastAPI(title="Connect", lifespan=lifespan)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": "Too many requests. Please slow down."})


app.add_middleware(AuthMiddleware)

app.include_router(auth_router)
app.include_router(booth_router)
app.include_router(ward_router)
app.include_router(admin_router)
app.include_router(notice_router)
app.include_router(coupon_router)
app.include_router(telecaller_router)
app.include_router(schemes_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "deadline": settings.DEADLINE}


@app.get("/api/translations")
async def get_translations(lang: str = "en"):
    from backend.translations import get_all_translations
    if lang not in ("en", "ta"):
        lang = "en"
    return get_all_translations(lang)


@app.post("/api/activity/log")
async def log_activity_endpoint(request: Request, body: ActivityLogEntry):
    user = getattr(request.state, "user", None)
    phone = user["phone"] if user else "anonymous"
    ip = get_client_ip(request)
    store.log_activity(
        phone=phone, action=body.action, screen=body.screen or "",
        details=body.details or "", duration_ms=body.duration_ms or 0,
        ip=ip, voter_id=body.voter_id or "",
    )
    return {"ok": True}


@app.post("/api/activity/heartbeat")
async def heartbeat_endpoint(request: Request, body: HeartbeatEntry):
    user = getattr(request.state, "user", None)
    phone = user["phone"] if user else "anonymous"
    ip = get_client_ip(request)
    loc_details = ""
    if body.lat is not None and body.lng is not None:
        loc_details = f"lat={body.lat:.6f},lng={body.lng:.6f}"

    store.log_activity(
        phone=phone, action="heartbeat", screen=body.screen,
        duration_ms=body.duration_ms, ip=ip,
        details=loc_details,
    )
    # Also update last-known location on the user entity
    if loc_details and phone != "anonymous":
        from datetime import datetime, timezone as _tz
        ts = datetime.now(_tz.utc).isoformat()
        store.update_user_location(phone, body.lat, body.lng, ts)
    return {"ok": True}


app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")
app.mount("/icons", StaticFiles(directory=os.path.join(FRONTEND_DIR, "icons")), name="icons")


@app.get("/manifest.json")
async def manifest():
    return FileResponse(os.path.join(FRONTEND_DIR, "manifest.json"))


@app.get("/sw.js")
async def service_worker():
    return FileResponse(os.path.join(FRONTEND_DIR, "sw.js"), media_type="application/javascript")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    file_path = os.path.join(FRONTEND_DIR, full_path)
    if full_path and os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
