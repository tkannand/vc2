import structlog
from backend import storage

logger = structlog.get_logger()


def log_page_view(phone: str, screen: str, ip: str = ""):
    storage.log_activity(phone=phone, action="page_view", screen=screen, ip=ip)
    logger.info("page_view", user=phone[-4:], screen=screen)


def log_phone_reveal(phone: str, voter_id: str, ip: str = ""):
    storage.log_activity(phone=phone, action="phone_reveal", voter_id=voter_id, ip=ip)
    logger.info("phone_reveal", user=phone[-4:], voter_id=voter_id)


def log_call_status_change(phone: str, voter_id: str, status: str, ip: str = ""):
    storage.log_activity(
        phone=phone, action="call_status_change", voter_id=voter_id,
        details=f"status={status}", ip=ip
    )
    logger.info("call_status_change", user=phone[-4:], voter_id=voter_id, status=status)


def log_heartbeat(phone: str, screen: str, duration_ms: int, ip: str = ""):
    storage.log_activity(
        phone=phone, action="heartbeat", screen=screen,
        duration_ms=duration_ms, ip=ip
    )


def log_unauthorized_access(ip: str, endpoint: str, details: str = ""):
    storage.log_activity(
        phone="anonymous", action="unauthorized_access",
        screen=endpoint, details=details, ip=ip
    )
    logger.warning("unauthorized_access", ip=ip, endpoint=endpoint, details=details)


def log_user_management(admin_phone: str, action: str, target_phone: str, ip: str = ""):
    storage.log_activity(
        phone=admin_phone, action=f"user_{action}",
        details=f"target={target_phone[-4:]}", ip=ip
    )
    logger.info("user_management", admin=admin_phone[-4:], action=action, target=target_phone[-4:])
