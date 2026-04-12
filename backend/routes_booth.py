import structlog
from fastapi import APIRouter, Request
from backend.middleware import require_booth_access, get_client_ip
from backend.models import UpdateCallStatus
from backend import storage
from backend.activity import log_phone_reveal, log_call_status_change, log_page_view

logger = structlog.get_logger()
router = APIRouter(prefix="/api/booth", tags=["booth"])


def sanitize_voter(voter: dict, include_masked_phone: bool = True) -> dict:
    result = {
        "voter_id": voter.get("RowKey", ""),
        "name": voter.get("name", ""),
        "name_ta": voter.get("name_ta", ""),
        "relation_name": voter.get("relation_name", ""),
        "relation_name_ta": voter.get("relation_name_ta", ""),
        "relationship": voter.get("relationship", ""),
        "age": voter.get("age", 0),
        "gender": voter.get("gender", ""),
        "house": voter.get("house", ""),
        "house2": voter.get("house2", ""),
        "famcode": voter.get("famcode", ""),
        "is_head": voter.get("is_head", "No"),
        "party_support": voter.get("party_support", ""),
        "section": voter.get("section", ""),
        "booth": voter.get("booth", ""),
        "ward": voter.get("ward", ""),
    }
    if include_masked_phone:
        _field_labels = [
            ("phone_sr_enc", "Phone 1"),
            ("phone_enc",    "Phone 2"),
            ("whatsapp_enc", "WhatsApp"),
            ("phone3_enc",   "Phone 3"),
        ]
        seen: set = set()
        phone_labels: list = []
        phone_nums: list = []   # kept server-side for duplicate detection, stripped before response
        for enc_field, label in _field_labels:
            dec = storage.decrypt_phone(voter.get(enc_field, ""))
            if dec and dec not in seen:
                phone_labels.append(label)
                phone_nums.append(dec)
                seen.add(dec)
        result["has_phone"]        = len(phone_labels) > 0
        result["phone_count"]      = len(phone_labels)
        result["phone_labels"]     = phone_labels
        result["_phone_nums"]      = phone_nums   # stripped after family duplicate check
        result["has_duplicate_phone"] = False     # set by family post-processor
    return result


def mark_duplicate_phones(family_list: list) -> None:
    """Within each family, mark members whose phone also appears on an earlier member.

    Only the 2nd+ occurrence gets has_duplicate_phone=True.
    Strips the private _phone_nums field from all members.
    """
    for fam in family_list:
        seen: dict = {}   # phone_number -> first voter_id that had it
        for m in fam.get("members", []):
            nums = m.pop("_phone_nums", [])
            is_dup = any(n in seen for n in nums)
            for n in nums:
                if n not in seen:
                    seen[n] = m.get("voter_id", "")
            m["has_duplicate_phone"] = is_dup


@router.get("/streets")
async def get_streets(request: Request, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    log_page_view(request.state.user["phone"], "streets", get_client_ip(request))
    sections = storage.get_sections_for_booth(ward, booth)
    return {"streets": sections}


@router.get("/families")
async def get_families(request: Request, ward: str, booth: str, street: str = "", tab: str = "not_called"):
    user = require_booth_access(request, ward, booth)
    log_page_view(user["phone"], f"families_{tab}", get_client_ip(request))

    voters = storage.get_voters_by_booth(ward, booth)
    statuses = storage.get_all_call_statuses(ward, booth)

    if street:
        voters = [v for v in voters if v.get("section", "") == street]

    families = {}
    for v in voters:
        vid = v.get("RowKey", "")
        status_record = statuses.get(vid, {})
        voter_status = status_record.get("status", "not_called")

        if tab == "not_called" and voter_status not in ("not_called", "in_progress"):
            continue
        elif tab == "called" and voter_status != "called":
            continue
        elif tab == "other" and voter_status not in ("didnt_answer", "skipped"):
            continue

        famcode = v.get("famcode", vid)
        if famcode not in families:
            families[famcode] = {
                "famcode": famcode,
                "members": [],
                "house": v.get("house", ""),
                "section": v.get("section", ""),
                "booth_name": v.get("booth_name", ""),
                "booth_name_tamil": v.get("booth_name_tamil", ""),
                "booth_number": v.get("booth_number", ""),
                "head_name": "",
                "head_name_ta": "",
            }

        member = sanitize_voter(v)
        member["status"] = voter_status
        member["notes"] = status_record.get("notes", "")
        families[famcode]["members"].append(member)

        if v.get("is_head", "No") == "Yes":
            families[famcode]["head_name"] = v.get("name", "")
            families[famcode]["head_name_ta"] = v.get("name_ta", "")

    family_list = list(families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"] = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])

    family_list.sort(key=lambda x: (x.get("section", ""), x.get("house", "")))
    mark_duplicate_phones(family_list)

    return {"families": family_list, "total": len(family_list)}


@router.get("/voter/{voter_id}")
async def get_voter(request: Request, voter_id: str, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    log_page_view(user["phone"], "voter_detail", get_client_ip(request))

    voter = storage.get_voter_by_id(ward, booth, voter_id)
    if not voter:
        return {"error": "Voter not found"}, 404

    result = sanitize_voter(voter)
    status_record = storage.get_call_status(ward, booth, voter_id)
    result["status"] = status_record.get("status", "not_called") if status_record else "not_called"
    result["notes"] = status_record.get("notes", "") if status_record else ""
    return result


@router.post("/voter/{voter_id}/reveal-phone")
async def reveal_phone(request: Request, voter_id: str, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    ip = get_client_ip(request)
    log_phone_reveal(user["phone"], voter_id, ip)

    voter = storage.get_voter_by_id(ward, booth, voter_id)
    if not voter:
        return {"error": "Voter not found"}, 404

    # Mark voter as in_progress so user must update status
    existing = storage.get_call_status(ward, booth, voter_id)
    if not existing or existing.get("status") == "not_called":
        storage.upsert_call_status(ward, booth, voter_id, status="in_progress", called_by=user["phone"])

    _field_labels = [
        ("phone_sr_enc", "Phone 1"),
        ("phone_enc",    "Phone 2"),
        ("whatsapp_enc", "WhatsApp"),
        ("phone3_enc",   "Phone 3"),
    ]
    seen: set = set()
    phones: list = []
    for enc_field, label in _field_labels:
        dec = storage.decrypt_phone(voter.get(enc_field, ""))
        if dec and dec not in seen:
            phones.append({"label": label, "number": dec})
            seen.add(dec)

    return {"phones": phones, "voter_id": voter_id}


@router.post("/voter/{voter_id}/status")
async def update_status(request: Request, voter_id: str, body: UpdateCallStatus, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    ip = get_client_ip(request)

    voter = storage.get_voter_by_id(ward, booth, voter_id)
    if not voter:
        return {"error": "Voter not found"}, 404

    storage.upsert_call_status(
        ward=ward,
        booth=booth,
        voter_id=voter_id,
        status=body.status,
        notes=body.notes or "",
        called_by=user["phone"],
    )
    log_call_status_change(user["phone"], voter_id, body.status, ip)

    return {"success": True, "status": body.status}


@router.get("/pending-status")
async def get_pending_status(request: Request, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    pending = storage.get_pending_voters(ward, booth, user["phone"])
    voters_info = []
    for p in pending:
        voter_id = p.get("RowKey", "")
        voter = storage.get_voter_by_id(ward, booth, voter_id)
        if voter:
            voters_info.append({
                "voter_id": voter_id,
                "name": voter.get("name", ""),
                "famcode": voter.get("famcode", voter_id),
                "section": voter.get("section", ""),
                "house": voter.get("house", ""),
            })
    return {"pending": voters_info, "has_pending": len(voters_info) > 0}


@router.get("/stats")
async def get_stats(request: Request, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    log_page_view(user["phone"], "booth_stats", get_client_ip(request))

    stats = storage.get_call_stats(ward, booth)
    sections = storage.get_sections_for_booth(ward, booth)

    section_stats = []
    voters = storage.get_voters_by_booth(ward, booth)
    statuses = storage.get_all_call_statuses(ward, booth)

    for section in sections:
        sec_voters = [v for v in voters if v.get("section") == section]
        sec_total = len(sec_voters)
        sec_called = 0
        sec_other = 0
        for v in sec_voters:
            vid = v.get("RowKey", "")
            s = statuses.get(vid, {}).get("status", "not_called")
            if s == "called":
                sec_called += 1
            elif s in ("didnt_answer", "skipped"):
                sec_other += 1
        section_stats.append({
            "section": section,
            "total": sec_total,
            "called": sec_called,
            "not_called": sec_total - sec_called - sec_other,
            "other": sec_other,
            "pct": round((sec_called / sec_total * 100) if sec_total > 0 else 0, 1),
        })

    stats["sections"] = section_stats
    return stats
