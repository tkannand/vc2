import structlog
from fastapi import APIRouter, Request
from backend.middleware import require_ward_access, require_booth_access, get_client_ip
from backend.models import UpdateCallStatus, UpdatePersonRequest
from backend import storage
from backend.activity import log_page_view, log_phone_reveal, log_call_status_change
from backend.routes_booth import sanitize_voter

logger = structlog.get_logger()
router = APIRouter(prefix="/api/ward", tags=["ward"])


@router.get("/booths")
async def get_booths(request: Request, ward: str):
    user = require_ward_access(request, ward)
    log_page_view(user["phone"], "ward_booths", get_client_ip(request))

    booths = storage.get_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)
    booth_stats = []
    for b in booths:
        stats = storage.get_call_stats(ward, b)
        info = bi_map.get(b, {})
        booth_stats.append({"booth": b, "booth_number": info.get("booth_number", ""), "booth_name": info.get("booth_name", ""), "booth_name_tamil": info.get("booth_name_tamil", ""), **stats})

    return {"booths": booth_stats, "ward": ward}


@router.get("/stats")
async def get_ward_stats(request: Request, ward: str):
    user = require_ward_access(request, ward)
    log_page_view(user["phone"], "ward_stats", get_client_ip(request))

    booths = storage.get_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)
    total = called = didnt_answer = skipped = not_called = 0
    booth_data = []

    for b in booths:
        stats = storage.get_call_stats(ward, b)
        total += stats["total"]
        called += stats["called"]
        didnt_answer += stats["didnt_answer"]
        skipped += stats["skipped"]
        not_called += stats["not_called"]
        info = bi_map.get(b, {})
        booth_data.append({"booth": b, "booth_number": info.get("booth_number", ""), "booth_name": info.get("booth_name", ""), "booth_name_tamil": info.get("booth_name_tamil", ""), **stats})

    workers = storage.get_worker_activity_summary(ward=ward)
    users = storage.get_users_for_ward(ward)
    user_map = {u["RowKey"]: u.get("name", u["RowKey"]) for u in users}
    for w in workers:
        w["name"] = user_map.get(w["phone"], w["phone"][-4:])

    return {
        "ward": ward,
        "total": total,
        "called": called,
        "didnt_answer": didnt_answer,
        "skipped": skipped,
        "not_called": not_called,
        "completion_pct": round((called / total * 100) if total > 0 else 0, 1),
        "booths": booth_data,
        "workers": workers,
    }


@router.get("/leaderboard")
async def get_leaderboard(request: Request, ward: str):
    user = require_ward_access(request, ward)
    log_page_view(user["phone"], "ward_leaderboard", get_client_ip(request))

    workers = storage.get_worker_activity_summary(ward=ward)
    users = storage.get_users_for_ward(ward)
    user_map = {u["RowKey"]: u.get("name", u["RowKey"]) for u in users}
    for w in workers:
        w["name"] = user_map.get(w["phone"], w["phone"][-4:])

    return {"workers": workers, "ward": ward}


# --- Ward user can drill down to booth+street level to see voters ---

@router.get("/booth-streets")
async def get_booth_streets(request: Request, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    sections = storage.get_sections_for_booth(ward, booth)
    return {"streets": sections}


@router.get("/booth-families")
async def get_booth_families(request: Request, ward: str, booth: str, street: str = "", tab: str = "not_called"):
    user = require_booth_access(request, ward, booth)
    log_page_view(user["phone"], f"ward_drill_families_{tab}", get_client_ip(request))

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
    return {"families": family_list, "total": len(family_list)}


@router.post("/booth-voter/{voter_id}/reveal-phone")
async def ward_reveal_phone(request: Request, voter_id: str, ward: str, booth: str):
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


@router.post("/booth-voter/{voter_id}/update-person")
async def ward_update_person(request: Request, voter_id: str, body: UpdatePersonRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    ip = get_client_ip(request)

    voter = storage.get_voter_by_id(ward, booth, voter_id)
    if not voter:
        return {"error": "Voter not found"}, 404

    storage.update_voter_person_data(
        ward=ward,
        booth=booth,
        voter_id=voter_id,
        phones=body.phones,
        party_support=body.party_support,
    )
    storage.log_activity(
        phone=user["phone"],
        action="update_person",
        screen="scheme",
        details=f"voter={voter_id}",
        ip=ip,
        voter_id=voter_id,
    )
    logger.info("person_updated", voter_id=voter_id, by=user["phone"][-4:])
    return {"success": True}


@router.post("/booth-voter/{voter_id}/status")
async def ward_update_status(request: Request, voter_id: str, body: UpdateCallStatus, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    ip = get_client_ip(request)

    voter = storage.get_voter_by_id(ward, booth, voter_id)
    if not voter:
        return {"error": "Voter not found"}, 404

    storage.upsert_call_status(
        ward=ward, booth=booth, voter_id=voter_id,
        status=body.status, notes=body.notes or "", called_by=user["phone"],
    )
    log_call_status_change(user["phone"], voter_id, body.status, ip)
    return {"success": True, "status": body.status}


@router.get("/pending-status")
async def get_ward_pending_status(request: Request, ward: str, booth: str):
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
                "booth": booth,
            })
    return {"pending": voters_info, "has_pending": len(voters_info) > 0}
