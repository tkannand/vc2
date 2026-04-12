import structlog
from fastapi import APIRouter, Request, HTTPException
from backend.middleware import require_role, get_client_ip
from backend import storage
from backend.activity import log_page_view
from backend.routes_booth import sanitize_voter

logger = structlog.get_logger()
router = APIRouter(prefix="/api/telecaller", tags=["telecaller"])


def _check_ward_access(user: dict, ward: str):
    if user.get("role") == "telecaller" and user.get("ward") != ward:
        raise HTTPException(status_code=403, detail="Access denied to this ward")


def check_telecalling_enabled():
    if not storage.get_telecalling_enabled():
        raise HTTPException(status_code=403, detail="Telecalling is currently disabled")


@router.get("/booths")
async def get_telecaller_booths(request: Request, ward: str):
    user = require_role(request, "telecaller", "superadmin")
    _check_ward_access(user, ward)
    if user.get("role") == "telecaller": check_telecalling_enabled()

    booths = storage.get_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)
    return {
        "booths": [
            {
                "booth": b,
                "booth_number": bi_map.get(b, {}).get("booth_number", ""),
                "booth_name": bi_map.get(b, {}).get("booth_name", ""),
                "booth_name_tamil": bi_map.get(b, {}).get("booth_name_tamil", ""),
            }
            for b in booths
        ]
    }


@router.get("/streets")
async def get_telecaller_streets(request: Request, ward: str, booth: str = ""):
    user = require_role(request, "telecaller", "superadmin")
    _check_ward_access(user, ward)

    target_booths = [booth] if booth else storage.get_booths_for_ward(ward)
    sections_set = set()
    for b in target_booths:
        voters = storage.get_voters_by_booth(ward, b)
        for v in voters:
            if v.get("seg_synced") == "true" and v.get("section"):
                sections_set.add(v["section"])
    return {"streets": sorted(list(sections_set))}


def _get_scheme_statuses(ward: str, booth: str, scheme_id: str) -> dict:
    """Return {voter_id: status_record} for a single scheme in a booth."""
    if scheme_id == "notice":
        return storage.get_all_notice_statuses(ward, booth)
    elif scheme_id == "coupon":
        return storage.get_all_coupon_statuses(ward, booth)
    else:
        return storage.get_all_scheme_statuses(ward, booth, scheme_id)


@router.get("/families")
async def get_telecaller_families(
    request: Request, ward: str, booth: str = "", street: str = "", tab: str = "not_called",
    scheme_ids: str = ""
):
    user = require_role(request, "telecaller", "superadmin")
    _check_ward_access(user, ward)
    log_page_view(user["phone"], f"telecaller_families_{tab}", get_client_ip(request))

    sid_list = [s.strip() for s in scheme_ids.split(",") if s.strip()]
    target_booths = [booth] if booth else storage.get_booths_for_ward(ward)

    families = {}
    for b in target_booths:
        voters = storage.get_voters_by_booth(ward, b)
        statuses = storage.get_all_call_statuses(ward, b)

        # Fetch delivery statuses for every requested scheme
        all_scheme_statuses = {sid: _get_scheme_statuses(ward, b, sid) for sid in sid_list}

        # Telecaller only calls seg-synced voters (140K with phones/party data)
        voters = [v for v in voters if v.get("seg_synced") == "true"]

        if street:
            voters = [v for v in voters if v.get("section", "") == street]

        for v in voters:
            vid = v.get("RowKey", "")
            status_record = statuses.get(vid, {})
            voter_status = status_record.get("status", "not_called")

            # Filter by tab
            if tab == "not_called" and voter_status not in ("not_called", "in_progress"):
                continue
            elif tab == "other" and voter_status not in ("didnt_answer", "skipped"):
                continue
            elif tab not in ("not_called", "other"):
                continue

            famcode = v.get("famcode", vid)
            fam_key = f"{b}__{famcode}"
            if fam_key not in families:
                families[fam_key] = {
                    "famcode": famcode,
                    "booth": b,
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
            # Per-scheme delivery status for this voter
            member["scheme_statuses"] = {
                sid: all_scheme_statuses[sid].get(vid, {}).get("status", "not_delivered")
                for sid in sid_list
            }
            families[fam_key]["members"].append(member)

            if v.get("is_head", "No") == "Yes":
                families[fam_key]["head_name"] = v.get("name", "")
                families[fam_key]["head_name_ta"] = v.get("name_ta", "")

    family_list = list(families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"] = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])
        f["scheme_total"] = len(f["members"])
        # Per-scheme delivered count: {scheme_id: count}
        f["scheme_deliveries"] = {
            sid: sum(1 for m in f["members"] if m.get("scheme_statuses", {}).get(sid) == "delivered")
            for sid in sid_list
        }

    family_list.sort(key=lambda x: (x.get("booth", ""), x.get("section", ""), x.get("house", "")))
    from backend.routes_booth import mark_duplicate_phones
    mark_duplicate_phones(family_list)
    return {"families": family_list, "total": len(family_list)}
