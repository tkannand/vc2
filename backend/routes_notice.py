import asyncio
import structlog
from fastapi import APIRouter, Request, HTTPException
from typing import Optional
from pydantic import BaseModel
from backend.middleware import require_role, require_ward_access, require_booth_access, get_client_ip
from backend.models import NoticeDeliverRequest, NoticeToggleRequest
from backend import storage
from backend.activity import log_page_view

logger = structlog.get_logger()
router = APIRouter(prefix="/api/notice", tags=["notice"])


def _user_name(user: dict) -> str:
    """Return user's display name — from JWT if present, else look up in Users table."""
    name = user.get("name", "")
    if not name:
        rec = storage.get_user(user["phone"])
        name = rec.get("name", "") if rec else ""
    return name


def check_notice_enabled():
    if not storage.get_notice_enabled():
        raise HTTPException(status_code=403, detail="Notice distribution is currently disabled")


def sanitize_notice_voter(voter: dict) -> dict:
    return {
        "voter_id":        voter.get("RowKey", ""),
        "name":            voter.get("name", ""),
        "name_en":         voter.get("name_en", ""),
        "name_ta":         voter.get("name_ta", ""),
        "name_seg":        voter.get("name_seg", ""),
        "relation_type":   voter.get("relation_type", "") or voter.get("relationship", ""),
        "relation_name":   voter.get("relation_name", ""),
        "relation_name_ta": voter.get("relation_name_ta", ""),
        "age":             voter.get("age", 0),
        "gender":          voter.get("gender", ""),
        "famcode":         voter.get("famcode", ""),
        "is_head":         voter.get("is_head", "No"),
        "house":           voter.get("house", ""),
        "section":         voter.get("section", ""),
        "sl":              voter.get("sl", ""),
        "booth":           voter.get("booth", ""),
    }


# ---- Common ----

@router.get("/enabled")
async def is_notice_enabled(request: Request):
    return {"enabled": storage.get_notice_enabled()}


# ---- Booth-level endpoints ----

@router.get("/streets")
async def get_notice_streets(request: Request, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    check_notice_enabled()
    sections = storage.get_notice_streets(ward, booth)
    return {"streets": sections}


@router.get("/voters")
async def get_notice_voters(request: Request, ward: str, booth: str, street: str = ""):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()
    log_page_view(user["phone"], "notice_voters", get_client_ip(request))

    voters = storage.get_notice_voters_by_booth(ward, booth)
    statuses = storage.get_all_notice_statuses(ward, booth)

    if street:
        voters = [v for v in voters if v.get("section", "") == street]

    # Group by family
    families = {}
    ungrouped = []

    for v in voters:
        vid = v.get("RowKey", "")
        status_rec = statuses.get(vid, {})
        voter_status = status_rec.get("status", "not_delivered")

        member = sanitize_notice_voter(v)
        member["status"]            = status_rec.get("status", "not_delivered")
        member["delivered_by"]      = status_rec.get("delivered_by", "")
        member["delivered_by_name"] = status_rec.get("delivered_by_name", "")
        member["delivered_at"]      = status_rec.get("updated_at", "")

        famcode = v.get("famcode", "")
        if famcode:
            if famcode not in families:
                families[famcode] = {
                    "famcode": famcode,
                    "members": [],
                    "house": v.get("house", ""),
                    "head_name": "",
                    "head_name_ta": "",
                }
            families[famcode]["members"].append(member)
            if v.get("is_head", "No") == "Yes":
                families[famcode]["head_name"] = v.get("name", "")
                families[famcode]["head_name_ta"] = v.get("name_ta", "")
        else:
            ungrouped.append(member)

    family_list = list(families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"] = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])

    family_list.sort(key=lambda x: (x.get("house", ""), x.get("head_name", "")))

    # Stats for this street
    total = len(voters)
    delivered = sum(1 for v in voters if statuses.get(v.get("RowKey", ""), {}).get("status") == "delivered")

    return {
        "families": family_list,
        "ungrouped": ungrouped,
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
    }


@router.post("/deliver")
async def deliver_notice(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()

    for vid in body.voter_ids:
        voter = storage.get_notice_voter(ward, booth, vid)
        if voter:
            storage.upsert_notice_status(ward, booth, vid, "delivered", user["phone"], _user_name(user))

    logger.info("notice_delivered", count=len(body.voter_ids), by=user["phone"][-4:])
    return {"success": True, "count": len(body.voter_ids)}


@router.post("/undeliver")
async def undeliver_notice(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()

    for vid in body.voter_ids:
        voter = storage.get_notice_voter(ward, booth, vid)
        if voter:
            storage.upsert_notice_status(ward, booth, vid, "not_delivered", user["phone"], _user_name(user))

    logger.info("notice_undelivered", count=len(body.voter_ids), by=user["phone"][-4:])
    return {"success": True, "count": len(body.voter_ids)}


@router.get("/stats")
async def get_notice_stats(request: Request, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()
    log_page_view(user["phone"], "notice_stats", get_client_ip(request))

    # Fetch voters and statuses in parallel — single round-trip each
    voters, statuses = await asyncio.gather(
        asyncio.to_thread(storage.get_notice_voters_by_booth, ward, booth),
        asyncio.to_thread(storage.get_all_notice_statuses, ward, booth),
    )

    total = len(voters)
    delivered = sum(1 for s in statuses.values() if s.get("status") == "delivered")
    pending = total - delivered

    # Section breakdown — derived from already-fetched voters, no extra queries
    sections_set: dict = {}
    for v in voters:
        sec = v.get("section", "")
        if sec:
            sections_set.setdefault(sec, []).append(v)

    section_stats = []
    for section in sorted(sections_set.keys()):
        sec_voters = sections_set[section]
        sec_total = len(sec_voters)
        sec_delivered = sum(
            1 for v in sec_voters
            if statuses.get(v.get("RowKey", ""), {}).get("status") == "delivered"
        )
        section_stats.append({
            "section": section,
            "total": sec_total,
            "delivered": sec_delivered,
            "pending": sec_total - sec_delivered,
            "pct": round((sec_delivered / sec_total * 100) if sec_total > 0 else 0, 1),
        })

    return {
        "total": total,
        "delivered": delivered,
        "pending": pending,
        "completion_pct": round((delivered / total * 100) if total > 0 else 0, 1),
        "sections": section_stats,
    }


# ---- Ward-level endpoints ----

@router.get("/ward/all-voters")
async def get_ward_all_notice_voters(request: Request, ward: str):
    """Load all notice voters for every booth in the ward in parallel.

    Used by the ward supervisor notice page on initial load so the user can
    search across the entire ward without selecting a booth first.
    """
    user = require_ward_access(request, ward)
    log_page_view(user["phone"], "notice_ward_all_voters", get_client_ip(request))

    booths = storage.get_booths_for_ward(ward)

    voters_per_booth, statuses_per_booth = await asyncio.gather(
        asyncio.gather(*[asyncio.to_thread(storage.get_notice_voters_by_booth, ward, b) for b in booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_all_notice_statuses, ward, b) for b in booths]),
    )

    all_statuses: dict = {}
    for s in statuses_per_booth:
        all_statuses.update(s)

    families: dict = {}
    ungrouped: list = []

    for voters in voters_per_booth:
        for v in voters:
            vid = v.get("RowKey", "")
            status_rec = all_statuses.get(vid, {})
            member = sanitize_notice_voter(v)
            member["status"]            = status_rec.get("status", "not_delivered")
            member["delivered_by"]      = status_rec.get("delivered_by", "")
            member["delivered_by_name"] = status_rec.get("delivered_by_name", "")
            member["delivered_at"]      = status_rec.get("updated_at", "")

            famcode = v.get("famcode", "")
            if famcode:
                if famcode not in families:
                    families[famcode] = {
                        "famcode": famcode, "members": [],
                        "house": v.get("house", ""), "head_name": "",
                        "head_name_ta": "", "booth": v.get("booth", ""),
                    }
                families[famcode]["members"].append(member)
                if v.get("is_head", "No") == "Yes":
                    families[famcode]["head_name"]    = v.get("name", "")
                    families[famcode]["head_name_ta"] = v.get("name_ta", "")
            else:
                ungrouped.append(member)

    family_list = list(families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"]    = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])

    family_list.sort(key=lambda x: (x.get("booth", ""), x.get("house", ""), x.get("head_name", "")))

    all_voters_flat = [m for f in family_list for m in f["members"]] + ungrouped
    total     = len(all_voters_flat)
    delivered = sum(1 for m in all_voters_flat if m.get("status") == "delivered")

    return {"families": family_list, "ungrouped": ungrouped,
            "total": total, "delivered": delivered, "pending": total - delivered}


@router.get("/ward/booths")
async def get_ward_notice_booths(request: Request, ward: str):
    user = require_ward_access(request, ward)
    check_notice_enabled()
    log_page_view(user["phone"], "notice_ward_booths", get_client_ip(request))

    booths, booth_info_map = storage.get_notice_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)

    results = await asyncio.gather(*[
        asyncio.to_thread(storage.get_notice_stats, ward, b) for b in booths
    ])

    booth_stats = []
    for b, stats in zip(booths, results):
        info = bi_map.get(b, {}) or booth_info_map.get(b, {})
        booth_stats.append({
            "booth": b,
            "booth_number": info.get("booth_number", ""),
            "booth_name": info.get("booth_name", ""),
            "booth_name_tamil": info.get("booth_name_tamil", ""),
            **stats,
        })

    return {"booths": booth_stats, "ward": ward}


@router.get("/ward/booth-streets")
async def get_ward_notice_booth_streets(request: Request, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    check_notice_enabled()
    sections = storage.get_notice_streets(ward, booth)
    return {"streets": sections}


@router.get("/ward/booth-voters")
async def get_ward_notice_booth_voters(request: Request, ward: str, booth: str, street: str = ""):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()
    log_page_view(user["phone"], "notice_ward_drill_voters", get_client_ip(request))

    voters = storage.get_notice_voters_by_booth(ward, booth)
    statuses = storage.get_all_notice_statuses(ward, booth)

    if street:
        voters = [v for v in voters if v.get("section", "") == street]

    families = {}
    ungrouped = []

    for v in voters:
        vid = v.get("RowKey", "")
        status_rec = statuses.get(vid, {})
        voter_status = status_rec.get("status", "not_delivered")

        member = sanitize_notice_voter(v)
        member["status"]            = status_rec.get("status", "not_delivered")
        member["delivered_by"]      = status_rec.get("delivered_by", "")
        member["delivered_by_name"] = status_rec.get("delivered_by_name", "")
        member["delivered_at"]      = status_rec.get("updated_at", "")

        famcode = v.get("famcode", "")
        if famcode:
            if famcode not in families:
                families[famcode] = {
                    "famcode": famcode,
                    "members": [],
                    "house": v.get("house", ""),
                    "head_name": "",
                    "head_name_ta": "",
                }
            families[famcode]["members"].append(member)
            if v.get("is_head", "No") == "Yes":
                families[famcode]["head_name"] = v.get("name", "")
                families[famcode]["head_name_ta"] = v.get("name_ta", "")
        else:
            ungrouped.append(member)

    family_list = list(families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"] = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])

    family_list.sort(key=lambda x: (x.get("house", ""), x.get("head_name", "")))

    total = len(voters)
    delivered = sum(1 for v in voters if statuses.get(v.get("RowKey", ""), {}).get("status") == "delivered")

    return {
        "families": family_list,
        "ungrouped": ungrouped,
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
    }


@router.post("/ward/deliver")
async def ward_deliver_notice(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()

    for vid in body.voter_ids:
        voter = storage.get_notice_voter(ward, booth, vid)
        if voter:
            storage.upsert_notice_status(ward, booth, vid, "delivered", user["phone"], _user_name(user))

    logger.info("notice_ward_delivered", count=len(body.voter_ids), by=user["phone"][-4:])
    return {"success": True, "count": len(body.voter_ids)}


@router.post("/ward/undeliver")
async def ward_undeliver_notice(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    check_notice_enabled()

    for vid in body.voter_ids:
        voter = storage.get_notice_voter(ward, booth, vid)
        if voter:
            storage.upsert_notice_status(ward, booth, vid, "not_delivered", user["phone"], _user_name(user))

    logger.info("notice_ward_undelivered", count=len(body.voter_ids), by=user["phone"][-4:])
    return {"success": True, "count": len(body.voter_ids)}


@router.get("/ward/stats")
async def get_ward_notice_stats(request: Request, ward: str):
    user = require_ward_access(request, ward)
    check_notice_enabled()
    log_page_view(user["phone"], "notice_ward_stats", get_client_ip(request))

    booths, booth_info_map = storage.get_notice_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)

    results = await asyncio.gather(*[
        asyncio.to_thread(storage.get_notice_stats, ward, b) for b in booths
    ])

    total = delivered = pending = 0
    booth_data = []
    for b, stats in zip(booths, results):
        total += stats["total"]
        delivered += stats["delivered"]
        pending += stats["pending"]
        info = bi_map.get(b, {}) or booth_info_map.get(b, {})
        booth_data.append({
            "booth": b,
            "booth_number": info.get("booth_number", ""),
            "booth_name": info.get("booth_name", ""),
            "booth_name_tamil": info.get("booth_name_tamil", ""),
            **stats,
        })

    return {
        "ward": ward,
        "total": total,
        "delivered": delivered,
        "pending": pending,
        "completion_pct": round((delivered / total * 100) if total > 0 else 0, 1),
        "booths": booth_data,
    }


# ---- Admin-level endpoints ----

@router.get("/admin/stats")
async def get_admin_notice_stats(request: Request, ward: Optional[str] = None, booths: Optional[str] = None):
    user = require_role(request, "superadmin")
    log_page_view(user["phone"], "notice_admin_stats", get_client_ip(request))

    all_wards = storage.get_notice_all_wards()
    booth_filter = [b.strip() for b in booths.split(",") if b.strip()] if booths else []
    target_wards = [ward] if ward else all_wards

    # Build per-ward booth lists + metadata, then fire all stats queries in parallel
    ward_meta = {}
    all_wb_pairs = []  # [(ward, booth), ...]
    for w in target_wards:
        w_booths, bi_map_nv = storage.get_notice_booths_for_ward(w)
        bi_map = storage.get_booth_info_map(w) or bi_map_nv
        if booth_filter:
            w_booths = [b for b in w_booths if b in booth_filter]
        ward_display = w
        for b_info in bi_map.values():
            if b_info.get("ward_name"):
                ward_display = b_info["ward_name"]
                break
        ward_meta[w] = {"booths": w_booths, "bi_map": bi_map, "ward_name": ward_display}
        for b in w_booths:
            all_wb_pairs.append((w, b))

    # All booth stats in parallel
    all_stats = await asyncio.gather(*[
        asyncio.to_thread(storage.get_notice_stats, w, b) for w, b in all_wb_pairs
    ])

    stats_by_wb = dict(zip(all_wb_pairs, all_stats))

    grand_total = grand_delivered = grand_pending = 0
    ward_data = []
    booth_data = []

    for w in target_wards:
        meta = ward_meta[w]
        bi_map = meta["bi_map"]
        w_booths = meta["booths"]
        w_total = w_delivered = w_pending = 0
        for b in w_booths:
            stats = stats_by_wb[(w, b)]
            info = bi_map.get(b, {})
            booth_data.append({
                "ward": w, "booth": b,
                "booth_number": info.get("booth_number", ""),
                "booth_name": info.get("booth_name", ""),
                "booth_name_tamil": info.get("booth_name_tamil", ""),
                **stats,
            })
            w_total += stats["total"]
            w_delivered += stats["delivered"]
            w_pending += stats["pending"]

        ward_data.append({
            "ward": w,
            "ward_name": meta["ward_name"],
            "booth_count": len(w_booths),
            "total": w_total,
            "delivered": w_delivered,
            "pending": w_pending,
            "completion_pct": round((w_delivered / w_total * 100) if w_total > 0 else 0, 1),
        })
        grand_total += w_total
        grand_delivered += w_delivered
        grand_pending += w_pending

    # Build all_wards list with display names for dropdown
    all_wards_with_names = []
    for w in all_wards:
        bi = storage.get_booth_meta_map(w)
        display = w
        for b_info in bi.values():
            if b_info.get("ward_name"):
                display = b_info["ward_name"]
                break
        all_wards_with_names.append({"ward": w, "ward_name": display})

    return {
        "grand_total": grand_total,
        "grand_delivered": grand_delivered,
        "grand_pending": grand_pending,
        "grand_completion_pct": round((grand_delivered / grand_total * 100) if grand_total > 0 else 0, 1),
        "wards": ward_data,
        "booths": booth_data if ward else [],
        "all_wards": all_wards_with_names,
    }


@router.post("/admin/toggle")
async def toggle_notice(request: Request, body: NoticeToggleRequest):
    user = require_role(request, "superadmin")
    storage.set_notice_enabled(body.enabled, user["phone"])
    logger.info("notice_feature_toggled", enabled=body.enabled, by=user["phone"][-4:])
    return {"success": True, "enabled": body.enabled}


@router.get("/admin/settings")
async def get_notice_settings(request: Request):
    require_role(request, "superadmin")

    def _meta(key: str) -> dict:
        try:
            e = storage.get_table(storage.table_name("Settings")).get_entity("settings", key)
            return {"updated_by": e.get("updated_by", ""), "updated_at": e.get("updated_at", "")}
        except Exception:
            return {"updated_by": "", "updated_at": ""}

    tm = _meta("telecalling_enabled")
    nm = _meta("notice_enabled")
    am = _meta("app_access_enabled")
    cm = _meta("coupon_enabled")

    return {
        "telecalling_enabled":          storage.get_telecalling_enabled(),
        "telecalling_enabled_updated_by": tm["updated_by"],
        "telecalling_enabled_updated_at": tm["updated_at"],
        "notice_enabled":               storage.get_notice_enabled(),
        "notice_enabled_updated_by":    nm["updated_by"],
        "notice_enabled_updated_at":    nm["updated_at"],
        "coupon_enabled":               storage.get_coupon_enabled(),
        "coupon_enabled_updated_by":    cm["updated_by"],
        "coupon_enabled_updated_at":    cm["updated_at"],
        "app_access_enabled":           storage.get_app_access_enabled(),
        "app_access_enabled_updated_by": am["updated_by"],
        "app_access_enabled_updated_at": am["updated_at"],
        "custom_schemes":               storage.get_all_custom_schemes_for_settings(),
    }


@router.post("/admin/toggle-telecalling")
async def toggle_telecalling(request: Request, body: NoticeToggleRequest):
    user = require_role(request, "superadmin")
    storage.set_telecalling_enabled(body.enabled, user["phone"])
    logger.info("telecalling_toggled", enabled=body.enabled, by=user["phone"][-4:])
    return {"success": True, "enabled": body.enabled}


@router.post("/admin/toggle-app-access")
async def toggle_app_access(request: Request, body: NoticeToggleRequest):
    user = require_role(request, "superadmin")
    storage.set_app_access_enabled(body.enabled, user["phone"])
    logger.info("app_access_toggled", enabled=body.enabled, by=user["phone"][-4:])
    return {"success": True, "enabled": body.enabled}


# ---- Sync Failure Logging ----

class SyncFailuresRequest(BaseModel):
    failures: list

@router.post("/sync-failures")
async def log_sync_failures(request: Request, body: SyncFailuresRequest):
    """Called by booth/ward workers when offline queue items permanently fail."""
    require_role(request, "booth", "ward", "telecaller", "superadmin")
    storage.store_sync_failures(body.failures)
    return {"success": True}
