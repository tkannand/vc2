import asyncio
import structlog
from fastapi import APIRouter, Request, HTTPException
from backend.middleware import require_role, require_booth_access, get_client_ip
from backend import storage
from backend.activity import log_page_view
from backend.routes_booth import sanitize_voter

logger = structlog.get_logger()
router = APIRouter(prefix="/api/telecaller", tags=["telecaller"])

# Phone fields to check for having a number
_PHONE_FIELDS = ("phone_sr_enc", "phone_enc", "whatsapp_enc", "phone3_enc")

def _voter_has_phone(v: dict) -> bool:
    return any(v.get(f, "") for f in _PHONE_FIELDS)

# Alliance mappings
DMK_ALLIANCE = {"DMK", "Congress", "DMDK", "MDMK", "CPI", "CPM", "VCK", "IUML", "CPI(M)", "CPI(ML)", "INC"}
ADMK_ALLIANCE = {"AIADMK", "ADMK", "BJP", "PMK"}
NTK_PARTIES = {"NTK"}
TVK_PARTIES = {"TVK"}

def _get_alliance(party: str) -> str:
    if not party:
        return ""
    if party in DMK_ALLIANCE:
        return "DMK+"
    if party in ADMK_ALLIANCE:
        return "ADMK+"
    if party in NTK_PARTIES:
        return "NTK"
    if party in TVK_PARTIES:
        return "TVK"
    return "Others"

def _matches_party_filter(party: str, party_filter: str) -> bool:
    if not party_filter:
        return True
    alliance = _get_alliance(party)
    if party_filter == "dmk_alliance":
        return alliance == "DMK+"
    if party_filter == "admk_alliance":
        return alliance == "ADMK+"
    if party_filter == "ntk":
        return alliance == "NTK"
    if party_filter == "tvk":
        return alliance == "TVK"
    if party_filter == "others":
        return alliance == "Others"
    return True


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
    voters_per_booth = await asyncio.gather(
        *[asyncio.to_thread(storage.get_voters_by_booth, ward, b) for b in target_booths]
    )
    sections_set = set()
    for voters in voters_per_booth:
        for v in voters:
            k = storage.street_key(v)
            if v.get("seg_synced") == "true" and k:
                sections_set.add(k)
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
    scheme_ids: str = "", party_filter: str = ""
):
    user = require_role(request, "telecaller", "superadmin")
    _check_ward_access(user, ward)
    log_page_view(user["phone"], f"telecaller_families_{tab}", get_client_ip(request))

    sid_list = [s.strip() for s in scheme_ids.split(",") if s.strip()]
    target_booths = [booth] if booth else storage.get_booths_for_ward(ward)

    # Fetch voters and call statuses for all booths in parallel
    voters_per_booth, statuses_per_booth = await asyncio.gather(
        asyncio.gather(*[asyncio.to_thread(storage.get_voters_by_booth, ward, b) for b in target_booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_all_call_statuses, ward, b) for b in target_booths]),
    )

    # Fetch scheme statuses for all booths × schemes in parallel
    scheme_tasks = []
    scheme_keys = []
    for b in target_booths:
        for sid in sid_list:
            scheme_tasks.append(asyncio.to_thread(_get_scheme_statuses, ward, b, sid))
            scheme_keys.append((b, sid))
    scheme_results = await asyncio.gather(*scheme_tasks) if scheme_tasks else []
    scheme_map = {}
    for (b, sid), result in zip(scheme_keys, scheme_results):
        scheme_map.setdefault(b, {})[sid] = result

    families = {}
    for i, b in enumerate(target_booths):
        voters = voters_per_booth[i]
        statuses = statuses_per_booth[i]
        all_scheme_statuses = scheme_map.get(b, {})

        # Telecaller only calls seg-synced voters with party data and phone numbers
        voters = [
            v for v in voters
            if v.get("seg_synced") == "true"
            and v.get("party_support", "")
            and _voter_has_phone(v)
            and _matches_party_filter(v.get("party_support", ""), party_filter)
        ]

        if street:
            voters = [v for v in voters if storage.street_key(v) == street]

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
                    "section": storage.street_key(v),
                    "booth_name": v.get("booth_name", ""),
                    "booth_name_tamil": v.get("booth_name_tamil", ""),
                    "booth_number": v.get("booth_number", ""),
                    "head_name": "",
                    "head_name_ta": "",
                }

            member = sanitize_voter(v)
            member["status"] = voter_status
            member["notes"] = status_record.get("notes", "")
            member["alliance"] = _get_alliance(v.get("party_support", ""))
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


@router.get("/pending-status")
async def get_telecaller_pending_status(request: Request, ward: str):
    """Check all booths in a ward for pending (in_progress) voters in one call."""
    user = require_role(request, "telecaller", "superadmin")
    _check_ward_access(user, ward)
    phone = user["phone"]
    booths = storage.get_booths_for_ward(ward)

    # Query all booths for pending voters in parallel
    pending_per_booth = await asyncio.gather(
        *[asyncio.to_thread(storage.get_pending_voters, ward, b, phone) for b in booths]
    )

    for b, pending_list in zip(booths, pending_per_booth):
        if not pending_list:
            continue
        # Found pending — look up first voter's info
        p = pending_list[0]
        voter_id = p.get("RowKey", "")
        voter = storage.get_voter_by_id(ward, b, voter_id)
        if voter:
            return {
                "has_pending": True,
                "pending": [{
                    "voter_id": voter_id,
                    "name": voter.get("name", ""),
                    "famcode": voter.get("famcode", voter_id),
                    "section": storage.street_key(voter),
                    "house": voter.get("house", ""),
                    "booth": b,
                }],
            }

    return {"has_pending": False, "pending": []}
