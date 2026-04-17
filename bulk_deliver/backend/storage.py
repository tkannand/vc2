import re
import structlog
from datetime import datetime, timezone
from azure.data.tables import TableServiceClient, TableClient
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from bulk_deliver.backend.config import settings

logger = structlog.get_logger()

_service_client = None


def get_service_client() -> TableServiceClient:
    global _service_client
    if _service_client is None:
        _service_client = TableServiceClient.from_connection_string(
            settings.AZURE_STORAGE_CONNECTION_STRING
        )
    return _service_client


def get_table(name: str) -> TableClient:
    return get_service_client().get_table_client(name)


def table_name(raw: str) -> str:
    return f"{settings.TABLE_PREFIX}{raw}"


def normalize_key(value: str) -> str:
    if not value:
        return ""
    ascii_only = "".join(c for c in value if 0x20 <= ord(c) <= 0x7E)
    return (
        ascii_only.replace("/", "_")
        .replace("\\", "_")
        .replace("#", "")
        .replace("?", "")
        .replace("'", "")
        .strip()
        .replace(" ", "_")
    )


# ── Audit table ─────────────────────────────────────────────────────────────

def init_audit_table():
    svc = get_service_client()
    tbl = table_name("BulkDeliveryAudit")
    try:
        svc.create_table(tbl)
        logger.info("audit_table_created", table=tbl)
    except ResourceExistsError:
        pass


# ── Voter lookup ────────────────────────────────────────────────────────────

def load_all_voters() -> dict:
    """Load all voters into a dict keyed by voter_id (EPIC).
    Returns {epic: {voter_id, name, name_en, ward, booth, sl, booth_number}}.
    """
    table = get_table(table_name("Voters"))
    voters = {}
    count = 0
    for entity in table.list_entities():
        vid = entity["RowKey"]
        voters[vid] = {
            "voter_id": vid,
            "name": entity.get("name", ""),
            "name_en": entity.get("name_en", ""),
            "ward": entity.get("ward", ""),
            "booth": entity.get("booth", ""),
            "sl": entity.get("sl", ""),
            "booth_number": entity.get("booth_number", ""),
            "section": entity.get("section", ""),
        }
        count += 1
    logger.info("voters_loaded", count=count)
    return voters


# ── Delivery status checks ──────────────────────────────────────────────────

def get_delivery_statuses(scheme_type: str, scheme_id: str, ward: str, booth: str) -> dict:
    """Get all delivery statuses for a ward/booth in a given scheme.
    Returns {voter_id: {status, delivered_by, delivered_by_name, updated_at, created_at}}.
    """
    if scheme_type == "notice":
        tbl = table_name("NoticeStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    elif scheme_type == "coupon":
        tbl = table_name("CouponStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    else:
        tbl = table_name("SchemeStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}__{scheme_id}"

    table = get_table(tbl)
    statuses = {}
    try:
        for e in table.query_entities(f"PartitionKey eq '{pk}'"):
            statuses[e["RowKey"]] = {
                "status": e.get("status", ""),
                "delivered_by": e.get("delivered_by", ""),
                "delivered_by_name": e.get("delivered_by_name", ""),
                "updated_at": e.get("updated_at", ""),
                "created_at": e.get("created_at", ""),
            }
    except Exception as exc:
        logger.error("status_query_failed", pk=pk, error=str(exc))
    return statuses


# ── Mark delivered ──────────────────────────────────────────────────────────

def mark_delivered(scheme_type: str, scheme_id: str, ward: str, booth: str,
                   voter_id: str, delivered_by: str, delivered_by_name: str):
    """Mark a single voter as delivered in the appropriate scheme table."""
    now = datetime.now(timezone.utc).isoformat()

    if scheme_type == "notice":
        tbl = table_name("NoticeStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    elif scheme_type == "coupon":
        tbl = table_name("CouponStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    else:
        tbl = table_name("SchemeStatus")
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}__{scheme_id}"

    table = get_table(tbl)
    existing = None
    try:
        existing = table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        pass

    table.upsert_entity({
        "PartitionKey": pk,
        "RowKey": voter_id,
        "status": "delivered",
        "delivered_by": delivered_by,
        "delivered_by_name": delivered_by_name,
        "updated_at": now,
        "created_at": existing["created_at"] if existing else now,
    })


# ── Audit records ───────────────────────────────────────────────────────────

def save_audit_record(batch_id: str, voter_id: str, scheme_type: str,
                      scheme_id: str, scheme_name: str, ward: str, booth: str,
                      sl: str, voter_name: str, status: str,
                      operator_name: str, source_filename: str,
                      error_message: str = ""):
    table = get_table(table_name("BulkDeliveryAudit"))
    now = datetime.now(timezone.utc).isoformat()
    table.upsert_entity({
        "PartitionKey": batch_id,
        "RowKey": voter_id,
        "scheme_type": scheme_type,
        "scheme_id": scheme_id or "",
        "scheme_name": scheme_name,
        "ward": ward,
        "booth": booth,
        "sl": sl,
        "voter_name": voter_name,
        "status": status,
        "error_message": error_message,
        "operator_name": operator_name,
        "uploaded_at": now,
        "source_filename": source_filename,
    })


# ── Scheme helpers ──────────────────────────────────────────────────────────

def get_custom_schemes() -> list:
    table = get_table(table_name("CustomSchemes"))
    results = []
    try:
        for e in table.query_entities("PartitionKey eq 'schemes'"):
            if e.get("enabled", "true") == "true":
                results.append({
                    "id": e["RowKey"],
                    "name": e.get("name", ""),
                    "type": e.get("type", "family"),
                })
    except Exception:
        pass
    return results


def get_notice_enabled() -> bool:
    table = get_table(table_name("Settings"))
    try:
        entity = table.get_entity("settings", "notice_enabled")
        return entity.get("value", "") == "true"
    except ResourceNotFoundError:
        return True


def get_coupon_enabled() -> bool:
    table = get_table(table_name("Settings"))
    try:
        entity = table.get_entity("settings", "coupon_enabled")
        return entity.get("value", "") == "true"
    except ResourceNotFoundError:
        return True
