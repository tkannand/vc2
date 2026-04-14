import re
import time
import json
import structlog
from datetime import datetime, timezone, timedelta
from azure.data.tables import TableServiceClient, TableClient
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from cryptography.fernet import Fernet
from typing import Optional
from backend.config import settings

# ---- IST timezone helpers ----
_IST = timezone(timedelta(hours=5, minutes=30))


def check_schedule_ist(schedule_json: str) -> bool:
    """Return True if the current IST time is within the allowed window (applies every day)."""
    if not schedule_json:
        return True
    try:
        schedule = json.loads(schedule_json)
    except Exception:
        return True
    if schedule.get("always", True):
        return True
    start = schedule.get("start", "")
    end   = schedule.get("end", "")
    if not start or not end:
        return True
    current = datetime.now(_IST).strftime("%H:%M")
    return start <= current <= end

# Reverse Excel auto-date corruption: "06-Apr" → "6/4", "12-Mar" → "12/3"
_EXCEL_DATE_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_EXCEL_DATE_RE = re.compile(r'^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$', re.IGNORECASE)

def fix_excel_date(value: str) -> str:
    """Convert Excel-corrupted date strings back to house numbers: '06-Apr' → '6/4'."""
    if not value:
        return value
    m = _EXCEL_DATE_RE.match(value.strip())
    if m:
        month = _EXCEL_DATE_MONTHS[m.group(2).lower()]
        return f"{m.group(1)}/{month}"
    return value

logger = structlog.get_logger()

# ---- Fast in-memory cache for security-critical settings ----
# Refreshed every 15 seconds so disabling takes effect within 15 s
# without adding a DB round-trip to every API request.
_SEC_SETTINGS_CACHE: dict = {}
_SEC_SETTINGS_TS: dict    = {}
_SEC_CACHE_TTL = 15  # seconds

# ---- Per-user security cache (active flag + schedule) ----
# TTL = 30 s so disabling a user or changing their schedule takes effect quickly.
_USER_SEC_CACHE: dict = {}   # {phone: (monotonic_ts, data_dict)}
_USER_SEC_TTL = 30  # seconds


def get_user_security_fast(phone: str) -> dict:
    """Return cached {active, schedule} for a user (30 s TTL)."""
    now = time.monotonic()
    if phone in _USER_SEC_CACHE:
        ts, data = _USER_SEC_CACHE[phone]
        if now - ts < _USER_SEC_TTL:
            return data
    user = get_user(phone)
    if user:
        data = {
            "active": user.get("active", True),
            "schedule": user.get("schedule", ""),
        }
    else:
        data = {"active": True, "schedule": ""}
    _USER_SEC_CACHE[phone] = (now, data)
    return data


def invalidate_user_security_cache(phone: str):
    _USER_SEC_CACHE.pop(phone, None)


def _get_sec_setting(key: str) -> Optional[str]:
    now = time.monotonic()
    if key in _SEC_SETTINGS_CACHE and now - _SEC_SETTINGS_TS.get(key, 0) < _SEC_CACHE_TTL:
        return _SEC_SETTINGS_CACHE[key]
    val = get_setting(key)          # real DB read
    _SEC_SETTINGS_CACHE[key] = val
    _SEC_SETTINGS_TS[key]    = now
    return val


def _invalidate_sec_cache(key: str):
    _SEC_SETTINGS_CACHE.pop(key, None)
    _SEC_SETTINGS_TS.pop(key, None)

RAW_TABLES = ["Voters", "Users", "CallStatus", "ActivityLogs", "Sessions", "OTPs", "NoticeVoters", "NoticeStatus", "Settings", "SyncFailures", "CouponFamilies", "CouponStatus", "CouponAuditLog", "CustomSchemes", "SchemeStatus"]


def table_name(raw: str) -> str:
    return f"{settings.TABLE_PREFIX}{raw}"


TABLES = [table_name(t) for t in RAW_TABLES]

_fernet = None
_service_client = None


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(settings.ENCRYPTION_KEY.encode() if isinstance(settings.ENCRYPTION_KEY, str) else settings.ENCRYPTION_KEY)
    return _fernet


def get_service_client() -> TableServiceClient:
    global _service_client
    if _service_client is None:
        _service_client = TableServiceClient.from_connection_string(settings.AZURE_STORAGE_CONNECTION_STRING)
    return _service_client


def get_table(name: str) -> TableClient:
    return get_service_client().get_table_client(name)


def init_tables():
    svc = get_service_client()
    for tbl in TABLES:
        try:
            svc.create_table(tbl)
            logger.info("table_created", table=tbl)
        except ResourceExistsError:
            pass
        except Exception as e:
            logger.error("table_creation_failed", table=tbl, error=str(e))
    logger.info("tables_initialized", count=len(TABLES), prefix=settings.TABLE_PREFIX)


def encrypt_phone(phone: str) -> str:
    if not phone or phone == "nan" or phone == "None":
        return ""
    phone_str = str(phone).strip().split(".")[0]
    if not phone_str or phone_str == "nan":
        return ""
    return get_fernet().encrypt(phone_str.encode()).decode()


def decrypt_phone(encrypted: str) -> str:
    if not encrypted:
        return ""
    try:
        return get_fernet().decrypt(encrypted.encode()).decode()
    except Exception:
        return ""


def mask_phone(phone: str) -> str:
    if not phone or len(phone) < 4:
        return "****"
    return "*" * (len(phone) - 4) + phone[-4:]


def normalize_key(value: str) -> str:
    if not value:
        return ""
    # Strip non-ASCII characters first — Azure Table Storage keys must be valid XML 1.0,
    # which excludes chars outside the printable ASCII range causing OutOfRangeInput errors
    ascii_only = "".join(c for c in value if 0x20 <= ord(c) <= 0x7E)
    return ascii_only.replace("/", "_").replace("\\", "_").replace("#", "").replace("?", "").replace("'", "").strip().replace(" ", "_")


# ---- Voter Operations ----

def _xml_safe(s: str) -> str:
    """Strip characters that are invalid in XML 1.0 (Azure Table Storage format).

    Removes: U+0000-U+0008, U+000B-U+000C, U+000E-U+001F, U+007F-U+009F
    These ranges cause OutOfRangeInput errors in Azure Table Storage.
    """
    return "".join(
        c for c in s
        if not (ord(c) <= 0x08 or ord(c) in (0x0B, 0x0C)
                or 0x0E <= ord(c) <= 0x1F or ord(c) == 0x7F
                or 0x80 <= ord(c) <= 0x9F)
    )


def _build_voter_entity(voter: dict) -> dict:
    ward = normalize_key(voter.get("ward", ""))
    booth = normalize_key(voter.get("booth", ""))
    def s(k, default=""):
        """Get string field, stripped of XML-invalid chars (Azure rejects them)."""
        return _xml_safe(str(voter.get(k, default) or default))
    return {
        "PartitionKey": f"{ward}__{booth}",
        "RowKey": str(voter["voter_id"]),
        # Names
        "name":               s("name"),
        "name_en":            s("name_en"),
        "name_ta":            s("name_ta"),
        "name_seg":           s("name_seg"),
        # Relations
        "relation_name":      s("relation_name"),
        "relation_name_ta":   s("relation_name_ta"),
        "relation_name_seg":  s("relation_name_seg"),
        "relationship":       s("relationship"),
        # Demographics
        "age":                voter.get("age", 0),
        "gender":             s("gender"),
        # Address
        "house":              s("house"),
        "house2":             s("house2"),
        # Ward / Booth
        "ward":               s("ward"),
        "booth":              s("booth"),
        "ac":                 s("ac"),
        "piv0":               s("piv0"),
        "piv2":               s("piv2"),
        # Booth metadata
        "booth_number":       s("booth_number"),
        "booth_display":      s("booth_display"),
        "booth_name":         s("booth_name"),
        "booth_name_tamil":   s("booth_name_tamil"),
        # Section
        "section":            s("section"),
        "section_num":        s("section_num"),
        "section_name":       s("section_name"),
        "section_name_ta":    s("section_name_ta"),
        # Seg enrichment
        "famcode":            s("famcode"),
        "is_head":            s("is_head", "No"),
        "party_support":      s("party_support"),
        "physically_disabled": s("physically_disabled"),
        "religion":           s("religion"),
        "caste":              s("caste"),
        "education":          s("education"),
        "occupation":         s("occupation"),
        "economic_status":    s("economic_status"),
        "outside_voter":      s("outside_voter"),
        # Phones (encrypted)
        "phone_sr_enc":       encrypt_phone(voter.get("phone_sr", "")),
        "whatsapp_enc":       encrypt_phone(voter.get("whatsapp", "")),
        "phone_enc":          encrypt_phone(voter.get("phone", "")),
        "phone3_enc":         encrypt_phone(voter.get("phone3", "")),
        # Misc
        "ration_card":        s("ration_card"),
        "sl":                 s("sl"),
        "is_deleted":         s("is_deleted", "False"),
        "seg_synced":         s("seg_synced", "false"),
    }


def upsert_voter(voter: dict):
    table = get_table(table_name("Voters"))
    table.upsert_entity(_build_voter_entity(voter))


def batch_upsert_voters(voters: list) -> int:
    """Batch upsert voters using Azure Table transactions (100 per batch, grouped by partition).

    Returns total number of entities submitted.
    """
    from collections import defaultdict
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Group entities by PartitionKey — Azure requires same PK per transaction
    partitions: dict[str, list] = defaultdict(list)
    for voter in voters:
        entity = _build_voter_entity(voter)
        partitions[entity["PartitionKey"]].append(entity)

    table = get_table(table_name("Voters"))

    def submit_chunk(chunk: list):
        try:
            ops = [("upsert", e) for e in chunk]
            table.submit_transaction(ops)
            return len(chunk)
        except Exception as exc:
            logger.error("voter_batch_chunk_failed", error=str(exc)[:200],
                         sample_pk=chunk[0].get("PartitionKey", "?") if chunk else "?")
            return 0

    # Build all chunks across all partitions

    chunks = []
    for entities in partitions.values():
        for i in range(0, len(entities), 100):
            chunks.append(entities[i : i + 100])

    total = 0
    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = []
            for chunk in chunks:
                try:
                    futures.append(executor.submit(submit_chunk, chunk))
                except RuntimeError:
                    # Interpreter shutting down — stop submitting, process what's queued
                    break
            for future in as_completed(futures):
                try:
                    total += future.result()
                except Exception as exc:
                    logger.error("voter_batch_future_failed", error=str(exc)[:200])
    except Exception as exc:
        logger.error("voter_batch_executor_failed", error=str(exc)[:200])

    return total


def get_seg_synced_voter_ids() -> set:
    """Return the set of voter IDs that already have seg data merged.

    Uses a projection query (RowKey only) so it's fast even with 200K+ rows.
    """
    table = get_table(table_name("Voters"))
    synced = set()
    for entity in table.query_entities("seg_synced eq 'true'", select=["RowKey"]):
        synced.add(entity["RowKey"])
    logger.info("seg_synced_ids_loaded", count=len(synced))
    return synced


def merge_voter_seg_data(voter_id: str, ward: str, booth: str, seg: dict):
    """Merge segmentation fields into an existing voter record.

    Uses Azure's MERGE mode so only the supplied fields are written —
    name_ta, name_en, and other voter-data fields are left untouched.
    Sets seg_synced = 'true' so this voter is skipped on subsequent restarts.
    """
    from azure.data.tables import UpdateMode
    table = get_table(table_name("Voters"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"

    entity = {
        "PartitionKey": pk,
        "RowKey": voter_id,
        "name": seg.get("name", ""),
        "relation_name": seg.get("relation_name", ""),
        "relationship": seg.get("relationship", ""),
        "age": seg.get("age", 0),
        "gender": seg.get("gender", ""),
        "house": seg.get("house", ""),
        "house2": seg.get("house2", ""),
        "famcode": seg.get("famcode", ""),
        "is_head": seg.get("is_head", "No"),
        "party_support": seg.get("party_support", ""),
        "physically_disabled": seg.get("physically_disabled", ""),
        "religion": seg.get("religion", ""),
        "caste": seg.get("caste", ""),
        "education": seg.get("education", ""),
        "occupation": seg.get("occupation", ""),
        "economic_status": seg.get("economic_status", ""),
        "outside_voter": seg.get("outside_voter", ""),
        "phone_sr_enc": encrypt_phone(seg.get("phone_sr", "")),
        "whatsapp_enc": encrypt_phone(seg.get("whatsapp", "")),
        "phone_enc": encrypt_phone(seg.get("phone", "")),
        "phone3_enc": encrypt_phone(seg.get("phone3", "")),
        "booth": seg.get("booth", ""),
        "ward": ward,
        "ac": seg.get("ac", ""),
        "section": seg.get("section", ""),
        "ration_card": str(seg.get("ration_card", "")),
        "seg_synced": "true",
    }
    # MERGE mode: only updates specified fields, preserves name_ta / name_en etc.
    table.upsert_entity(entity, mode=UpdateMode.MERGE)


def batch_merge_voter_seg_data(seg_list: list) -> int:
    """Batch merge seg data into voter records using parallel transactions.

    Each entry in seg_list is a (voter_id, ward, booth, seg_dict) tuple.
    Uses MERGE mode so name_ta / name_en are never overwritten.
    Returns total entities submitted.
    """
    from collections import defaultdict
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from azure.data.tables import UpdateMode

    partitions: dict[str, list] = defaultdict(list)
    for voter_id, ward, booth, seg in seg_list:
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
        entity = {
            "PartitionKey": pk,
            "RowKey": voter_id,
            "name": seg.get("name", ""),
            "relation_name": seg.get("relation_name", ""),
            "relationship": seg.get("relationship", ""),
            "age": seg.get("age", 0),
            "gender": seg.get("gender", ""),
            "house": seg.get("house", ""),
            "house2": seg.get("house2", ""),
            "famcode": seg.get("famcode", ""),
            "is_head": seg.get("is_head", "No"),
            "party_support": seg.get("party_support", ""),
            "physically_disabled": seg.get("physically_disabled", ""),
            "religion": seg.get("religion", ""),
            "caste": seg.get("caste", ""),
            "education": seg.get("education", ""),
            "occupation": seg.get("occupation", ""),
            "economic_status": seg.get("economic_status", ""),
            "outside_voter": seg.get("outside_voter", ""),
            "phone_sr_enc": encrypt_phone(seg.get("phone_sr", "")),
            "whatsapp_enc": encrypt_phone(seg.get("whatsapp", "")),
            "phone_enc": encrypt_phone(seg.get("phone", "")),
            "phone3_enc": encrypt_phone(seg.get("phone3", "")),
            "booth": seg.get("booth", ""),
            "ward": ward,
            "ac": seg.get("ac", ""),
            "section": seg.get("section", ""),
            "ration_card": str(seg.get("ration_card", "")),
            "seg_synced": "true",
        }
        partitions[pk].append(entity)

    table = get_table(table_name("Voters"))

    def submit_chunk(chunk: list):
        ops = [("upsert", e, {"mode": UpdateMode.MERGE}) for e in chunk]
        table.submit_transaction(ops)
        return len(chunk)

    chunks = []
    for entities in partitions.values():
        for i in range(0, len(entities), 100):
            chunks.append(entities[i : i + 100])

    total = 0
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(submit_chunk, chunk) for chunk in chunks]
        for future in as_completed(futures):
            total += future.result()

    return total


def get_voters_by_booth(ward: str, booth: str) -> list:
    table = get_table(table_name("Voters"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    entities = table.query_entities(f"PartitionKey eq '{pk}'")
    result = []
    for e in entities:
        d = dict(e)  # plain dict copy — never mutate Azure SDK entity objects
        if d.get("house"):
            d["house"] = fix_excel_date(d["house"])
        if d.get("house2"):
            d["house2"] = fix_excel_date(d["house2"])
        # SECTION_NAME always wins over seg section (which may contain ward names)
        if d.get("section_name"):
            d["section"] = d["section_name"]
        # Ensure section_name_ta is always present for Tamil language display
        if not d.get("section_name_ta"):
            d["section_name_ta"] = ""
        result.append(d)
    return result


def get_voter_famcodes_for_booth(ward: str, booth: str) -> list:
    """Light projection query — fetches voter_id, famcode, seg_synced, section, gender, age for one booth."""
    table   = get_table(table_name("Voters"))
    pk      = f"{normalize_key(ward)}__{normalize_key(booth)}"
    result  = []
    for entity in table.query_entities(
        f"PartitionKey eq '{pk}'",
        select=["RowKey", "famcode", "seg_synced", "section_name", "section", "gender", "age", "party_support"],
    ):
        result.append({
            "voter_id":       entity["RowKey"],
            "famcode":        (entity.get("famcode") or "").strip(),
            "seg_synced":     entity.get("seg_synced", "false") == "true",
            "party_support":  (entity.get("party_support") or "").strip(),
            "section":        entity.get("section_name") or entity.get("section", ""),
            "gender":         (entity.get("gender") or "").strip().upper(),
            "age":            entity.get("age", 0),
        })
    return result


def get_voter_famcodes_for_ward(ward: str) -> list:
    """Single range-scan query for all voters across all booths in a ward.

    More efficient than N per-booth queries — one Azure Table range scan
    on the PartitionKey prefix instead of N separate partition queries.
    PartitionKey format: '{normalize_key(ward)}__{normalize_key(booth)}'
    """
    table     = get_table(table_name("Voters"))
    pk_prefix = f"{normalize_key(ward)}__"
    # Upper bound: increment the last char of the prefix ('_' → '`', ASCII 95→96)
    # This correctly excludes any other ward whose normalized name starts with the same prefix.
    pk_hi = pk_prefix[:-1] + chr(ord(pk_prefix[-1]) + 1)
    filter_expr = f"PartitionKey ge '{pk_prefix}' and PartitionKey lt '{pk_hi}'"
    result = []
    for entity in table.query_entities(
        filter_expr,
        select=["RowKey", "PartitionKey", "famcode", "seg_synced",
                "section_name", "section", "booth", "gender", "age", "party_support"],
    ):
        result.append({
            "voter_id":       entity["RowKey"],
            "famcode":        (entity.get("famcode") or "").strip(),
            "seg_synced":     entity.get("seg_synced", "false") == "true",
            "party_support":  (entity.get("party_support") or "").strip(),
            "section":        entity.get("section_name") or entity.get("section", ""),
            "booth":          entity.get("booth", ""),
            "gender":         (entity.get("gender") or "").strip().upper(),
            "age":            entity.get("age", 0),
        })
    return result


def get_voter_by_id(ward: str, booth: str, voter_id: str) -> Optional[dict]:
    table = get_table(table_name("Voters"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    try:
        return table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        return None


def update_voter_person_data(ward: str, booth: str, voter_id: str,
                              phones: list = None, party_support: str = None):
    """Update phone numbers and/or party support for a voter using MERGE mode."""
    from azure.data.tables import UpdateMode
    table = get_table(table_name("Voters"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"

    entity = {
        "PartitionKey": pk,
        "RowKey": voter_id,
    }

    if phones is not None:
        phone_fields = ["phone_sr_enc", "whatsapp_enc", "phone_enc", "phone3_enc"]
        for i, field in enumerate(phone_fields):
            if i < len(phones) and phones[i]:
                entity[field] = encrypt_phone(phones[i])
            else:
                entity[field] = ""

    if party_support is not None:
        entity["party_support"] = party_support

    table.upsert_entity(entity, mode=UpdateMode.MERGE)
    logger.info("voter_person_updated", voter_id=voter_id, ward=ward, booth=booth,
                phones_count=len(phones) if phones else 0,
                has_party=bool(party_support))


def store_dashboard_cache(voter_counts: dict, wards: list, booths_per_ward: dict,
                          seg_counts: dict = None, universe: dict = None):
    """Persist ward/booth/count metadata so dashboard never scans the Voters table.

    voter_counts : {pk: total_voters}  — all 218K, used by notice
    seg_counts   : {pk: seg_voters}    — seg_synced only (140K), used by calling dashboard
    universe     : demographic summary dict stored as JSON for instant dashboard load
    """
    import json
    set_setting("cached_wards", json.dumps(wards), "system")
    for ward, booth_list in booths_per_ward.items():
        set_setting(f"cached_booths_{normalize_key(ward)}", json.dumps(booth_list), "system")
    for pk, count in voter_counts.items():
        set_setting(f"voter_count_{pk}", str(count), "system")
    if seg_counts:
        for pk, count in seg_counts.items():
            set_setting(f"seg_count_{pk}", str(count), "system")
    if universe:
        set_setting("stats_universe", json.dumps(universe), "system")
    logger.info("dashboard_cache_stored", wards=len(wards),
                voter_counts=len(voter_counts), seg_counts=len(seg_counts or {}))


def get_universe_stats() -> dict:
    """Return cached voter universe demographics (computed at sync time)."""
    import json
    cached = get_setting("stats_universe")
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass
    return {}


def get_all_wards() -> list:
    import json
    cached = get_setting("cached_wards")
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass
    # Fallback: full table scan (only runs before first sync completes)
    table = get_table(table_name("Voters"))
    wards = set()
    for entity in table.query_entities("", select=["ward"]):
        w = entity.get("ward", "")
        if w:
            wards.add(w)
    return sorted(list(wards))


def get_booths_for_ward(ward: str) -> list:
    import json
    cached = get_setting(f"cached_booths_{normalize_key(ward)}")
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass
    # Fallback: full table scan
    table = get_table(table_name("Voters"))
    pk_prefix = normalize_key(ward)
    booths = set()
    for entity in table.query_entities("", select=["PartitionKey", "booth"]):
        if entity["PartitionKey"].startswith(pk_prefix):
            b = entity.get("booth", "")
            if b:
                booths.add(b)
    return sorted(list(booths))


def get_sections_for_booth(ward: str, booth: str) -> list:
    """Return sorted list of {section, section_ta} dicts for a booth."""
    voters = get_voters_by_booth(ward, booth)
    sections: dict = {}  # section_name -> section_name_ta
    for v in voters:
        s = v.get("section", "")
        if s and s not in sections:
            sections[s] = v.get("section_name_ta", "")
    return [{"section": s, "section_ta": sections[s]} for s in sorted(sections.keys())]


def get_voter_count() -> int:
    table = get_table(table_name("Voters"))
    count = 0
    for _ in table.query_entities("", select=["PartitionKey"]):
        count += 1
    return count


# ---- User Operations ----

def upsert_user(phone: str, name: str, role: str, ward: str = "", booth: str = "", language: str = "en"):
    table = get_table(table_name("Users"))
    # Fetch existing to preserve security fields (device_id, active, schedule, geo_tracking, location)
    try:
        existing = dict(table.get_entity(role, phone))
    except ResourceNotFoundError:
        existing = {}
    entity = {
        **existing,           # preserve all existing fields (incl. security fields)
        "PartitionKey": role,
        "RowKey": phone,
        "name": name,
        "ward": ward,
        "booth": booth,
        "language": language,
    }
    # Set active=True only for brand-new users (no existing entity)
    if not existing:
        entity["active"] = True
        entity["geo_tracking"] = True
    table.upsert_entity(entity)
    invalidate_user_security_cache(phone)
    logger.info("user_upserted", phone=phone[-4:], role=role)


def get_user(phone: str) -> Optional[dict]:
    table = get_table(table_name("Users"))
    for role in ["superadmin", "ward", "booth", "telecaller"]:
        try:
            entity = table.get_entity(role, phone)
            return dict(entity)
        except ResourceNotFoundError:
            continue
    return None


def get_user_roles(phone: str) -> list:
    table = get_table(table_name("Users"))
    roles = []
    for role in ["superadmin", "ward", "booth", "telecaller"]:
        try:
            entity = table.get_entity(role, phone)
            roles.append(dict(entity))
        except ResourceNotFoundError:
            continue
    return roles


def get_all_users() -> list:
    table = get_table(table_name("Users"))
    return list(table.query_entities(""))


def delete_user(phone: str, role: str):
    table = get_table(table_name("Users"))
    try:
        table.delete_entity(role, phone)
        logger.info("user_deleted", phone=phone[-4:], role=role)
    except ResourceNotFoundError:
        pass


def update_user_security(phone: str, active: Optional[bool] = None,
                         schedule: Optional[str] = None,
                         geo_tracking: Optional[bool] = None):
    """Update security fields across all role entities for a phone number."""
    table = get_table(table_name("Users"))
    for role in ["superadmin", "ward", "booth", "telecaller"]:
        try:
            entity = dict(table.get_entity(role, phone))
        except ResourceNotFoundError:
            continue
        if active is not None:
            entity["active"] = active
        if schedule is not None:
            entity["schedule"] = schedule
        if geo_tracking is not None:
            entity["geo_tracking"] = geo_tracking
        table.upsert_entity(entity)
    invalidate_user_security_cache(phone)
    logger.info("user_security_updated", phone=phone[-4:])


def update_user_location(phone: str, lat: float, lng: float, ts: str):
    """Store last known GPS location on all role entities."""
    table = get_table(table_name("Users"))
    for role in ["superadmin", "ward", "booth", "telecaller"]:
        try:
            entity = dict(table.get_entity(role, phone))
            entity["last_lat"] = lat
            entity["last_lng"] = lng
            entity["last_location_at"] = ts
            table.upsert_entity(entity)
        except ResourceNotFoundError:
            continue


def record_login(phone: str):
    """Increment login_count and set last_login_at on all role entities for a phone."""
    from azure.data.tables import UpdateMode
    table = get_table(table_name("Users"))
    now = datetime.now(timezone.utc).isoformat()
    for role in ["superadmin", "ward", "booth", "telecaller"]:
        try:
            entity = dict(table.get_entity(role, phone))
            entity["login_count"] = entity.get("login_count", 0) + 1
            entity["last_login_at"] = now
            table.upsert_entity(entity)
        except ResourceNotFoundError:
            continue
    logger.info("login_recorded", phone=phone[-4:])


def get_users_by_role(role: str) -> list:
    table = get_table(table_name("Users"))
    return list(table.query_entities(f"PartitionKey eq '{role}'"))


def get_users_for_ward(ward: str) -> list:
    table = get_table(table_name("Users"))
    all_users = list(table.query_entities(""))
    return [u for u in all_users if u.get("ward", "") == ward]


# ---- Call Status Operations ----

def upsert_call_status(ward: str, booth: str, voter_id: str, status: str, notes: str = "", called_by: str = ""):
    table = get_table(table_name("CallStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    existing = None
    try:
        existing = table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        pass

    entity = {
        "PartitionKey": pk,
        "RowKey": voter_id,
        "status": status,
        "notes": notes,
        "called_by": called_by,
        "updated_at": now,
        "created_at": existing["created_at"] if existing else now,
    }
    table.upsert_entity(entity)
    logger.info("call_status_updated", voter_id=voter_id, status=status, by=called_by[-4:] if called_by else "")


def get_call_status(ward: str, booth: str, voter_id: str) -> Optional[dict]:
    table = get_table(table_name("CallStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    try:
        return dict(table.get_entity(pk, voter_id))
    except ResourceNotFoundError:
        return None


def get_all_call_statuses(ward: str, booth: str) -> dict:
    table = get_table(table_name("CallStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    statuses = {}
    for entity in table.query_entities(f"PartitionKey eq '{pk}'"):
        statuses[entity["RowKey"]] = dict(entity)
    return statuses


def get_pending_voters(ward: str, booth: str, phone: str) -> list:
    """Get voters with in_progress status called by a specific user."""
    table = get_table(table_name("CallStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    pending = []
    for entity in table.query_entities(
        f"PartitionKey eq '{pk}' and status eq 'in_progress' and called_by eq '{phone}'"
    ):
        pending.append(dict(entity))
    return pending


def get_call_stats(ward: str, booth: str) -> dict:
    statuses = get_all_call_statuses(ward, booth)

    # Use seg_count (seg_synced voters only) — these are the voters being called
    # voter_count is the full 218K used by notice
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    cached = get_setting(f"seg_count_{pk}") or get_setting(f"voter_count_{pk}")
    if cached:
        total = int(cached)
    else:
        total = sum(1 for v in get_voters_by_booth(ward, booth)
                    if v.get("seg_synced") == "true")

    called = sum(1 for s in statuses.values() if s.get("status") == "called")
    didnt_answer = sum(1 for s in statuses.values() if s.get("status") == "didnt_answer")
    skipped = sum(1 for s in statuses.values() if s.get("status") == "skipped")
    not_called = total - called - didnt_answer - skipped

    return {
        "total": total,
        "called": called,
        "didnt_answer": didnt_answer,
        "skipped": skipped,
        "not_called": not_called,
        "completion_pct": round((called / total * 100) if total > 0 else 0, 1),
    }


# ---- OTP Operations ----

def store_otp(phone: str, otp: str, expires_at: str):
    table = get_table(table_name("OTPs"))
    entity = {
        "PartitionKey": "otp",
        "RowKey": phone,
        "otp_hash": otp,
        "expires_at": expires_at,
        "attempts": 0,
    }
    table.upsert_entity(entity)


def get_otp(phone: str) -> Optional[dict]:
    table = get_table(table_name("OTPs"))
    try:
        return dict(table.get_entity("otp", phone))
    except ResourceNotFoundError:
        return None


def increment_otp_attempts(phone: str):
    table = get_table(table_name("OTPs"))
    try:
        entity = table.get_entity("otp", phone)
        entity["attempts"] = entity.get("attempts", 0) + 1
        table.upsert_entity(entity)
    except ResourceNotFoundError:
        pass


def delete_otp(phone: str):
    table = get_table(table_name("OTPs"))
    try:
        table.delete_entity("otp", phone)
    except ResourceNotFoundError:
        pass


# ---- Session Operations ----

def store_session(token: str, phone: str, role: str, ward: str, booth: str, expires_at: str):
    table = get_table(table_name("Sessions"))
    entity = {
        "PartitionKey": "session",
        "RowKey": token,
        "phone": phone,
        "role": role,
        "ward": ward,
        "booth": booth,
        "expires_at": expires_at,
    }
    table.upsert_entity(entity)


def get_session(token: str) -> Optional[dict]:
    table = get_table(table_name("Sessions"))
    try:
        return dict(table.get_entity("session", token))
    except ResourceNotFoundError:
        return None


def delete_session(token: str):
    table = get_table(table_name("Sessions"))
    try:
        table.delete_entity("session", token)
    except ResourceNotFoundError:
        pass


# ---- Activity Log Operations ----

def log_activity(phone: str, action: str, screen: str = "", details: str = "",
                 duration_ms: int = 0, ip: str = "", voter_id: str = ""):
    table = get_table(table_name("ActivityLogs"))
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    ts = now.isoformat()

    entity = {
        "PartitionKey": date_str,
        "RowKey": f"{ts}_{phone}_{action}",
        "phone": phone,
        "action": action,
        "screen": screen,
        "details": details,
        "duration_ms": duration_ms,
        "ip": ip,
        "voter_id": voter_id,
        "timestamp": ts,
    }
    try:
        table.create_entity(entity)
    except ResourceExistsError:
        entity["RowKey"] = f"{ts}_{phone}_{action}_{now.microsecond}"
        table.create_entity(entity)
    except Exception as e:
        logger.error("activity_log_failed", error=str(e), action=action)


def get_activity_logs(date_from: str = "", date_to: str = "", phone: str = "",
                      action: str = "", limit: int = 200) -> list:
    table = get_table(table_name("ActivityLogs"))
    filters = []
    if date_from:
        filters.append(f"PartitionKey ge '{date_from}'")
    if date_to:
        filters.append(f"PartitionKey le '{date_to}'")
    if phone:
        filters.append(f"phone eq '{phone}'")
    if action:
        filters.append(f"action eq '{action}'")

    query = " and ".join(filters) if filters else ""
    results = []
    for entity in table.query_entities(query):
        results.append(dict(entity))
        if len(results) >= limit:
            break
    return results


def get_worker_activity_summary(ward: str = "", booth: str = "") -> list:
    table = get_table(table_name("CallStatus"))
    all_statuses = []

    if ward and booth:
        pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
        all_statuses = list(table.query_entities(f"PartitionKey eq '{pk}'"))
    elif ward:
        pk_prefix = normalize_key(ward)
        for entity in table.query_entities(""):
            if entity["PartitionKey"].startswith(pk_prefix):
                all_statuses.append(dict(entity))
    else:
        all_statuses = list(table.query_entities(""))

    worker_stats = {}
    for s in all_statuses:
        worker = s.get("called_by", "unknown")
        if worker not in worker_stats:
            worker_stats[worker] = {"phone": worker, "called": 0, "didnt_answer": 0, "skipped": 0, "total": 0, "last_updated": ""}
        status = s.get("status", "")
        if status == "called":
            worker_stats[worker]["called"] += 1
        elif status == "didnt_answer":
            worker_stats[worker]["didnt_answer"] += 1
        elif status == "skipped":
            worker_stats[worker]["skipped"] += 1
        worker_stats[worker]["total"] += 1
        updated = s.get("updated_at", "")
        if updated > worker_stats[worker]["last_updated"]:
            worker_stats[worker]["last_updated"] = updated

    result = list(worker_stats.values())
    result.sort(key=lambda x: x["total"], reverse=True)
    return result


# ---- Notice Voter Operations ----

def upsert_notice_voter(data: dict):
    table = get_table(table_name("NoticeVoters"))
    ward = normalize_key(data.get("ward", ""))
    booth = normalize_key(data.get("booth", ""))
    pk = f"{ward}__{booth}"

    entity = {
        "PartitionKey": pk,
        "RowKey": str(data["voter_id"]),
        "name": data.get("name", ""),
        "relation_type": data.get("relation_type", ""),
        "relation_name": data.get("relation_name", ""),
        "age": data.get("age", 0),
        "gender": data.get("gender", ""),
        "section": data.get("section", ""),
        "famcode": data.get("famcode", ""),
        "is_head": data.get("is_head", "No"),
        "house": data.get("house", ""),
        "ward": data.get("ward", ""),
        "booth": data.get("booth", ""),
        "booth_number": data.get("booth_number", ""),
        "booth_name": data.get("booth_name", ""),
    }
    table.upsert_entity(entity)


def get_notice_voter(ward: str, booth: str, voter_id: str) -> Optional[dict]:
    """Look up a single voter — all 218K voters are now in seg_data ward partitions."""
    return get_voter_by_id(ward, booth, voter_id)


def get_notice_voters_by_booth(ward: str, booth: str) -> list:
    """Return all voters for a booth — all 218K are in seg_data ward partitions."""
    return get_voters_by_booth(ward, booth)


def get_notice_streets(ward: str, booth: str) -> list:
    voters = get_notice_voters_by_booth(ward, booth)
    sections = set()
    for v in voters:
        s = v.get("section", "")
        if s:
            sections.add(s)
    return sorted(list(sections))


def get_notice_all_wards() -> list:
    """All voters are now in seg_data ward partitions — same wards as everything else."""
    return get_all_wards()


def get_notice_booths_for_ward(ward: str) -> tuple:
    """Return (sorted_booths, booth_info_map) — same booth cache as everywhere."""
    booths = get_booths_for_ward(ward)
    bi_map = get_booth_meta_map(ward)
    booth_info: dict = {}
    for b in booths:
        meta = bi_map.get(b, {})
        booth_info[b] = {
            "booth_number": meta.get("booth_number", ""),
            "booth_name":   meta.get("booth_name", ""),
        }
    return sorted(booth_info.keys()), booth_info


def get_booth_info_map(ward: str) -> dict:
    """Return {booth: {booth_number, booth_name}} - from booth metadata, fallback to NoticeVoters."""
    result = get_booth_meta_map(ward)
    if result:
        return result
    _, info_map = get_notice_booths_for_ward(ward)
    return info_map


def store_booth_meta(ward: str, booth: str, booth_number: str, booth_name: str,
                     booth_name_tamil: str = "", ward_name: str = ""):
    """Store booth metadata (number + name + tamil + ward display) from voter data file."""
    table = get_table(table_name("Settings"))
    entity = {
        "PartitionKey": f"booth_meta_{normalize_key(ward)}",
        "RowKey": normalize_key(booth),
        "booth": booth,
        "booth_number": booth_number,
        "booth_name": booth_name,
        "booth_name_tamil": booth_name_tamil,
        "ward_name": ward_name,
    }
    table.upsert_entity(entity)


def get_booth_meta_map(ward: str) -> dict:
    """Return {booth: {booth_number, booth_name, booth_name_tamil, ward_name}} from stored booth metadata."""
    table = get_table(table_name("Settings"))
    pk = f"booth_meta_{normalize_key(ward)}"
    result = {}
    for entity in table.query_entities(f"PartitionKey eq '{pk}'"):
        b = entity.get("booth", "")
        if b:
            result[b] = {
                "booth_number": entity.get("booth_number", ""),
                "booth_name": entity.get("booth_name", ""),
                "booth_name_tamil": entity.get("booth_name_tamil", ""),
                "ward_name": entity.get("ward_name", ""),
            }
    return result


# ---- Notice Status Operations ----

def upsert_notice_status(ward: str, booth: str, voter_id: str, status: str,
                         delivered_by: str = "", delivered_by_name: str = ""):
    table = get_table(table_name("NoticeStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    existing = None
    try:
        existing = table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        pass

    entity = {
        "PartitionKey": pk,
        "RowKey": voter_id,
        "status": status,
        "delivered_by": delivered_by,
        "delivered_by_name": delivered_by_name,
        "updated_at": now,
        "created_at": existing["created_at"] if existing else now,
    }
    table.upsert_entity(entity)
    logger.info("notice_status_updated", voter_id=voter_id, status=status, by=delivered_by[-4:] if delivered_by else "")


def get_all_notice_statuses(ward: str, booth: str) -> dict:
    table = get_table(table_name("NoticeStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    statuses = {}
    for entity in table.query_entities(f"PartitionKey eq '{pk}'"):
        statuses[entity["RowKey"]] = dict(entity)
    return statuses


def get_notice_stats(ward: str, booth: str) -> dict:
    statuses = get_all_notice_statuses(ward, booth)
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    cached = get_setting(f"voter_count_{pk}")
    total = int(cached) if cached else len(get_voters_by_booth(ward, booth))
    delivered = sum(1 for s in statuses.values() if s.get("status") == "delivered")
    pending = total - delivered

    return {
        "total": total,
        "delivered": delivered,
        "pending": pending,
        "completion_pct": round((delivered / total * 100) if total > 0 else 0, 1),
    }


# ---- Settings Operations ----

def get_setting(key: str) -> Optional[str]:
    table = get_table(table_name("Settings"))
    try:
        entity = table.get_entity("settings", key)
        return entity.get("value", "")
    except ResourceNotFoundError:
        return None


def set_setting(key: str, value: str, updated_by: str = ""):
    table = get_table(table_name("Settings"))
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    entity = {
        "PartitionKey": "settings",
        "RowKey": key,
        "value": value,
        "updated_by": updated_by,
        "updated_at": now,
    }
    table.upsert_entity(entity)
    logger.info("setting_updated", key=key, value=value, by=updated_by[-4:] if updated_by else "")


def get_notice_enabled() -> bool:
    val = get_setting("notice_enabled")
    return val == "true" if val is not None else True


def set_notice_enabled(enabled: bool, updated_by: str = ""):
    set_setting("notice_enabled", "true" if enabled else "false", updated_by)


def get_coupon_enabled() -> bool:
    val = get_setting("coupon_enabled")
    return val == "true" if val is not None else True


def set_coupon_enabled(enabled: bool, updated_by: str = ""):
    set_setting("coupon_enabled", "true" if enabled else "false", updated_by)


def store_user_pin(phone: str, pin_hash: str):
    table = get_table(table_name("Settings"))
    entity = {
        "PartitionKey": "pin",
        "RowKey": phone,
        "pin_hash": pin_hash,
        "attempts": 0,
        "locked_until": "",
    }
    table.upsert_entity(entity)
    logger.info("pin_stored", phone=phone[-4:])


def get_user_pin(phone: str) -> Optional[dict]:
    table = get_table(table_name("Settings"))
    try:
        return dict(table.get_entity("pin", phone))
    except ResourceNotFoundError:
        return None


def has_user_pin(phone: str) -> bool:
    pin_data = get_user_pin(phone)
    return pin_data is not None and bool(pin_data.get("pin_hash"))


def get_all_pin_phones() -> set:
    """Return set of phone numbers that have a PIN set (single partition scan)."""
    table = get_table(table_name("Settings"))
    phones = set()
    for entity in table.query_entities("PartitionKey eq 'pin'", select=["RowKey", "pin_hash"]):
        if entity.get("pin_hash"):
            phones.add(entity["RowKey"])
    return phones


def increment_pin_attempts(phone: str):
    table = get_table(table_name("Settings"))
    try:
        entity = table.get_entity("pin", phone)
        entity["attempts"] = entity.get("attempts", 0) + 1
        table.upsert_entity(entity)
    except ResourceNotFoundError:
        pass


def reset_pin_attempts(phone: str):
    table = get_table(table_name("Settings"))
    try:
        entity = table.get_entity("pin", phone)
        entity["attempts"] = 0
        table.upsert_entity(entity)
    except ResourceNotFoundError:
        pass


def get_app_access_enabled() -> bool:
    val = get_setting("app_access_enabled")
    return val == "true" if val is not None else True


def set_app_access_enabled(enabled: bool, updated_by: str = ""):
    set_setting("app_access_enabled", "true" if enabled else "false", updated_by)
    _invalidate_sec_cache("app_access_enabled")


def get_telecalling_enabled() -> bool:
    val = get_setting("telecalling_enabled")
    return val == "true" if val is not None else True


def set_telecalling_enabled(enabled: bool, updated_by: str = ""):
    set_setting("telecalling_enabled", "true" if enabled else "false", updated_by)
    _invalidate_sec_cache("telecalling_enabled")


# ---- Fast cached checks used by middleware on every request ----

def check_app_access_fast() -> bool:
    """Returns False if full app access is disabled (non-superadmins blocked)."""
    val = _get_sec_setting("app_access_enabled")
    return val == "true" if val is not None else True


def check_telecalling_fast() -> bool:
    """Returns False if telecalling is disabled."""
    val = _get_sec_setting("telecalling_enabled")
    return val == "true" if val is not None else True


# ---- Sync Failures ----

def store_sync_failures(failures: list):
    """Store notice sync failures for admin review."""
    import json
    table = get_table(table_name("SyncFailures"))
    for f in failures:
        row_key = f"{int(time.time() * 1000)}_{f.get('ward','')}_{f.get('by_phone','')[-4:] if f.get('by_phone') else ''}"
        entity = {
            "PartitionKey": normalize_key(f.get("ward", "unknown")),
            "RowKey": row_key,
            "ward": f.get("ward", ""),
            "booth": f.get("booth", ""),
            "voter_ids": json.dumps(f.get("voter_ids", [])),
            "action": f.get("action", ""),
            "by_phone": f.get("by_phone", ""),
            "by_name": f.get("by_name", ""),
            "attempted_at": f.get("attempted_at", ""),
            "failed_at": f.get("failed_at", ""),
            "fail_reason": f.get("fail_reason", ""),
        }
        try:
            table.upsert_entity(entity)
        except Exception as e:
            logger.error("store_sync_failure_error", error=str(e))


def get_sync_failures(limit: int = 200) -> list:
    """Return most recent sync failures across all wards."""
    import json
    table = get_table(table_name("SyncFailures"))
    entities = list(table.list_entities())
    entities.sort(key=lambda e: e.get("failed_at", ""), reverse=True)
    result = []
    for e in entities[:limit]:
        result.append({
            "ward": e.get("ward", ""),
            "booth": e.get("booth", ""),
            "voter_ids": json.loads(e.get("voter_ids", "[]")),
            "action": e.get("action", ""),
            "by_phone": e.get("by_phone", ""),
            "by_name": e.get("by_name", ""),
            "attempted_at": e.get("attempted_at", ""),
            "failed_at": e.get("failed_at", ""),
            "fail_reason": e.get("fail_reason", ""),
        })
    return result


# ---- Coupon Families ----

def sanitize_voter_for_coupon(voter: dict) -> dict:
    """Shared voter sanitizer for coupon search results."""
    return {
        "voter_id":         voter.get("RowKey", ""),
        "name":             voter.get("name", ""),
        "name_en":          voter.get("name_en", ""),
        "name_ta":          voter.get("name_ta", ""),
        "sl":               voter.get("sl", ""),
        "booth":            voter.get("booth", ""),
        "section":          voter.get("section", ""),
        "section_ta":       voter.get("section_name_ta", ""),
        "house":            voter.get("house", ""),
        "famcode":          voter.get("famcode", ""),
        "is_head":          voter.get("is_head", "No"),
        "age":              voter.get("age", 0),
        "gender":           voter.get("gender", ""),
        "relation_type":    voter.get("relation_type", "") or voter.get("relationship", ""),
        "relation_name":    voter.get("relation_name", ""),
        "relation_name_ta": voter.get("relation_name_ta", ""),
    }


def get_coupon_families(ward: str, booth: str) -> list:
    """Return all custom coupon families for a booth (excludes the __ejected__ sentinel entry)."""
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    result = []
    for e in table.query_entities(f"PartitionKey eq '{pk}'"):
        if e["RowKey"] in (_EJECTED_KEY, _CROSS_CLAIMED_KEY):
            continue
        result.append({
            "famcode":      e["RowKey"],
            "voter_ids":    json.loads(e.get("voter_ids", "[]")),
            "members_data": json.loads(e.get("members_data", "[]")),
            "created_by":   e.get("created_by", ""),
            "created_at":   e.get("created_at", ""),
        })
    return result


def create_coupon_family(ward: str, booth: str, voter_ids: list, created_by: str, members_data: list = None) -> str:
    """Create a new custom coupon family; stores inline member data for cross-booth display."""
    import json, uuid
    famcode = f"CPN_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    table.upsert_entity({
        "PartitionKey": pk,
        "RowKey":       famcode,
        "voter_ids":    json.dumps(voter_ids),
        "members_data": json.dumps(members_data or []),
        "created_by":   created_by,
        "created_at":   now,
    })
    return famcode


def update_coupon_family_members(ward: str, booth: str, famcode: str, voter_ids: list,
                                 created_by: str = "", members_data: list = None):
    """Update existing custom family members. Stores inline data for cross-booth display.
    If entry doesn't exist (natural family being edited for first time), creates it."""
    import json
    from datetime import datetime, timezone
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    now = datetime.now(timezone.utc).isoformat()
    md_json = json.dumps(members_data or [])
    try:
        e = dict(table.get_entity(pk, famcode))
        e["voter_ids"]    = json.dumps(voter_ids)
        e["members_data"] = md_json
        table.upsert_entity(e)
    except ResourceNotFoundError:
        table.upsert_entity({
            "PartitionKey": pk,
            "RowKey":       famcode,
            "voter_ids":    json.dumps(voter_ids),
            "members_data": md_json,
            "created_by":   created_by,
            "created_at":   now,
        })


def delete_coupon_family(ward: str, booth: str, famcode: str):
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    try:
        table.delete_entity(pk, famcode)
    except ResourceNotFoundError:
        pass


_EJECTED_KEY = "__ejected__"


def get_ejected_coupon_voters(ward: str, booth: str) -> set:
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    try:
        e = table.get_entity(pk, _EJECTED_KEY)
        return set(json.loads(e.get("voter_ids", "[]")))
    except ResourceNotFoundError:
        return set()


def add_ejected_coupon_voters(ward: str, booth: str, voter_ids: list):
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    current = get_ejected_coupon_voters(ward, booth)
    current.update(voter_ids)
    table.upsert_entity({"PartitionKey": pk, "RowKey": _EJECTED_KEY, "voter_ids": json.dumps(list(current))})


def remove_from_ejected_coupon_voters(ward: str, booth: str, voter_ids: list):
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    current = get_ejected_coupon_voters(ward, booth)
    current -= set(voter_ids)
    if not current:
        try:
            table.delete_entity(pk, _EJECTED_KEY)
        except ResourceNotFoundError:
            pass
    else:
        table.upsert_entity({"PartitionKey": pk, "RowKey": _EJECTED_KEY, "voter_ids": json.dumps(list(current))})


_CROSS_CLAIMED_KEY = "__cross_claimed__"


def get_cross_claimed_voters(ward: str, booth: str) -> set:
    """Voters claimed by a family in another ward — hidden from this ward entirely."""
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    try:
        e = table.get_entity(pk, _CROSS_CLAIMED_KEY)
        return set(json.loads(e.get("voter_ids", "[]")))
    except ResourceNotFoundError:
        return set()


def add_cross_claimed_voters(ward: str, booth: str, voter_ids: list):
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    current = get_cross_claimed_voters(ward, booth)
    current.update(voter_ids)
    table.upsert_entity({"PartitionKey": pk, "RowKey": _CROSS_CLAIMED_KEY, "voter_ids": json.dumps(list(current))})


def remove_cross_claimed_voters(ward: str, booth: str, voter_ids: list):
    import json
    table = get_table(table_name("CouponFamilies"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    current = get_cross_claimed_voters(ward, booth)
    current -= set(voter_ids)
    if not current:
        try:
            table.delete_entity(pk, _CROSS_CLAIMED_KEY)
        except ResourceNotFoundError:
            pass
    else:
        table.upsert_entity({"PartitionKey": pk, "RowKey": _CROSS_CLAIMED_KEY, "voter_ids": json.dumps(list(current))})


# ---- Coupon Status ----

def upsert_coupon_status(ward: str, booth: str, voter_id: str, status: str,
                         delivered_by: str = "", delivered_by_name: str = ""):
    table = get_table(table_name("CouponStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    existing = None
    try:
        existing = table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        pass
    table.upsert_entity({
        "PartitionKey": pk,
        "RowKey": voter_id,
        "status": status,
        "delivered_by": delivered_by,
        "delivered_by_name": delivered_by_name,
        "updated_at": now,
        "created_at": existing["created_at"] if existing else now,
    })


def get_all_coupon_statuses(ward: str, booth: str) -> dict:
    table = get_table(table_name("CouponStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    statuses = {}
    for e in table.query_entities(f"PartitionKey eq '{pk}'"):
        statuses[e["RowKey"]] = dict(e)
    return statuses


def get_coupon_stats(ward: str, booth: str) -> dict:
    statuses = get_all_coupon_statuses(ward, booth)
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    cached = get_setting(f"voter_count_{pk}")
    total = int(cached) if cached else len(get_voters_by_booth(ward, booth))
    delivered = sum(1 for s in statuses.values() if s.get("status") == "delivered")
    return {
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
        "completion_pct": round(delivered / total * 100) if total else 0,
    }


def get_scheme_stats(ward: str, booth: str, scheme_id: str) -> dict:
    statuses = get_all_scheme_statuses(ward, booth, scheme_id)
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}"
    cached = get_setting(f"voter_count_{pk}")
    total = int(cached) if cached else len(get_voters_by_booth(ward, booth))
    delivered = sum(1 for s in statuses.values() if s.get("status") == "delivered")
    return {
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
        "completion_pct": round(delivered / total * 100) if total else 0,
    }


# ---- Coupon Audit Log ----

def log_coupon_action(ward: str, booth: str, action: str, famcode: str,
                      voter_ids: list, old_voter_ids: list, by_phone: str, by_name: str):
    """Log a coupon family create/update/delete action for audit and undo."""
    import json, uuid
    from datetime import datetime, timezone
    table = get_table(table_name("CouponAuditLog"))
    now = datetime.now(timezone.utc)
    # Reversed timestamp so newest sorts first in Azure Table (lexicographic)
    rev_ts = str(9999999999999 - int(now.timestamp() * 1000)).zfill(13)
    row_key = f"{rev_ts}_{uuid.uuid4().hex[:6]}"
    table.upsert_entity({
        "PartitionKey": normalize_key(ward),
        "RowKey": row_key,
        "ward": ward,
        "booth": booth,
        "action": action,
        "famcode": famcode,
        "voter_ids": json.dumps(voter_ids),
        "old_voter_ids": json.dumps(old_voter_ids),
        "by_phone": by_phone,
        "by_name": by_name,
        "timestamp": now.isoformat(),
    })
    return row_key


def get_coupon_audit_log(ward: str = "", booth: str = "", by_phone: str = "", limit: int = 200) -> list:
    """Return audit log entries, newest first. Filters by ward/booth/by_phone."""
    import json
    table = get_table(table_name("CouponAuditLog"))
    if ward:
        entities = table.query_entities(f"PartitionKey eq '{normalize_key(ward)}'")
    else:
        entities = table.list_entities()
    results = []
    for e in entities:
        if booth and e.get("booth", "") != booth:
            continue
        if by_phone and e.get("by_phone", "") != by_phone:
            continue
        results.append({
            "log_id":       e["RowKey"],
            "ward":         e.get("ward", ""),
            "booth":        e.get("booth", ""),
            "action":       e.get("action", ""),
            "famcode":      e.get("famcode", ""),
            "voter_ids":    json.loads(e.get("voter_ids", "[]")),
            "old_voter_ids": json.loads(e.get("old_voter_ids", "[]")),
            "by_phone":     e.get("by_phone", ""),
            "by_name":      e.get("by_name", ""),
            "timestamp":    e.get("timestamp", ""),
        })
        if len(results) >= limit:
            break
    return results


# ── Custom Schemes ────────────────────────────────────────────────────────────

def create_custom_scheme(name: str, scheme_type: str, created_by: str) -> str:
    """Create a new custom distribution scheme. Returns the generated scheme_id."""
    import uuid
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())[:24]
    scheme_id = f"cs_{slug}_{int(time.time())}_{uuid.uuid4().hex[:4]}"
    table = get_table(table_name("CustomSchemes"))
    now = datetime.now(timezone.utc).isoformat()
    table.upsert_entity({
        "PartitionKey": "schemes",
        "RowKey": scheme_id,
        "name": name.strip(),
        "type": scheme_type,
        "created_by": created_by,
        "created_at": now,
        "enabled": "true",
    })
    return scheme_id


def get_custom_schemes() -> list:
    """Return all enabled custom schemes ordered by creation time."""
    table = get_table(table_name("CustomSchemes"))
    results = []
    try:
        for e in table.query_entities("PartitionKey eq 'schemes'"):
            if e.get("enabled", "true") == "true":
                results.append({
                    "id":         e["RowKey"],
                    "name":       e.get("name", ""),
                    "type":       e.get("type", "family"),
                    "created_at": e.get("created_at", ""),
                })
    except Exception:
        pass
    results.sort(key=lambda x: x["created_at"])
    return results


# ── Generic Scheme Status ─────────────────────────────────────────────────────

def upsert_scheme_status(ward: str, booth: str, scheme_id: str, voter_id: str,
                         status: str, delivered_by: str = "", delivered_by_name: str = ""):
    """Record delivery status for any custom scheme — PK includes scheme_id so all schemes are independent."""
    table = get_table(table_name("SchemeStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}__{scheme_id}"
    now = datetime.now(timezone.utc).isoformat()
    existing = None
    try:
        existing = table.get_entity(pk, voter_id)
    except ResourceNotFoundError:
        pass
    table.upsert_entity({
        "PartitionKey": pk,
        "RowKey": voter_id,
        "status": status,
        "delivered_by": delivered_by,
        "delivered_by_name": delivered_by_name,
        "updated_at": now,
        "created_at": existing["created_at"] if existing else now,
    })


def get_all_scheme_statuses(ward: str, booth: str, scheme_id: str) -> dict:
    """Return {voter_id: status_entity} for a specific scheme in a booth."""
    table = get_table(table_name("SchemeStatus"))
    pk = f"{normalize_key(ward)}__{normalize_key(booth)}__{scheme_id}"
    statuses = {}
    try:
        for e in table.query_entities(f"PartitionKey eq '{pk}'"):
            statuses[e["RowKey"]] = dict(e)
    except Exception:
        pass
    return statuses


def update_custom_scheme(scheme_id: str, name: str, scheme_type: str, updated_by: str = ""):
    """Edit a custom scheme's name and type."""
    table = get_table(table_name("CustomSchemes"))
    try:
        e = dict(table.get_entity("schemes", scheme_id))
        e["name"]            = name.strip()
        e["type"]            = scheme_type
        e["updated_by"]      = updated_by
        e["updated_at"]      = datetime.now(timezone.utc).isoformat()
        table.upsert_entity(e)
    except ResourceNotFoundError:
        pass


def delete_custom_scheme(scheme_id: str):
    """Permanently delete a custom scheme definition (status data remains in SchemeStatus)."""
    table = get_table(table_name("CustomSchemes"))
    try:
        table.delete_entity("schemes", scheme_id)
    except ResourceNotFoundError:
        pass


def set_custom_scheme_enabled(scheme_id: str, enabled: bool, updated_by: str = ""):
    """Enable or disable a custom scheme (schemes are never deleted, only toggled)."""
    table = get_table(table_name("CustomSchemes"))
    try:
        e = dict(table.get_entity("schemes", scheme_id))
        e["enabled"]             = "true" if enabled else "false"
        e["enabled_updated_by"]  = updated_by
        e["enabled_updated_at"]  = datetime.now(timezone.utc).isoformat()
        table.upsert_entity(e)
    except ResourceNotFoundError:
        pass


def get_all_custom_schemes_for_settings() -> list:
    """Return ALL custom schemes including disabled ones — for the settings page."""
    table = get_table(table_name("CustomSchemes"))
    results = []
    try:
        for e in table.query_entities("PartitionKey eq 'schemes'"):
            results.append({
                "id":                  e["RowKey"],
                "name":                e.get("name", ""),
                "type":                e.get("type", "family"),
                "enabled":             e.get("enabled", "true") == "true",
                "created_by":          e.get("created_by", ""),
                "created_at":          e.get("created_at", ""),
                "enabled_updated_by":  e.get("enabled_updated_by", ""),
                "enabled_updated_at":  e.get("enabled_updated_at", ""),
            })
    except Exception:
        pass
    results.sort(key=lambda x: x["created_at"])
    return results
