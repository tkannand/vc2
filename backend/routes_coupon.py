import asyncio
import structlog
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from backend.middleware import require_role, require_ward_access, require_booth_access, get_client_ip
from backend.models import NoticeDeliverRequest
from backend import storage
from backend.activity import log_page_view

logger = structlog.get_logger()
router = APIRouter(prefix="/api/coupon", tags=["coupon"])


class CouponToggleRequest(BaseModel):
    enabled: bool


def _user_name(user: dict) -> str:
    name = user.get("name", "")
    if not name:
        rec = storage.get_user(user["phone"])
        name = rec.get("name", "") if rec else ""
    return name


@router.get("/enabled")
async def is_coupon_enabled(request: Request):
    return {"enabled": storage.get_coupon_enabled()}


@router.post("/admin/toggle")
async def toggle_coupon(request: Request, body: CouponToggleRequest):
    user = require_role(request, "superadmin")
    storage.set_coupon_enabled(body.enabled, user["phone"])
    return {"success": True, "enabled": body.enabled}


def _get_phone_last4(voter: dict) -> str:
    """Decrypt the first available phone field and return last 4 digits."""
    for field in ("phone_sr_enc", "phone_enc", "whatsapp_enc", "phone3_enc"):
        enc = voter.get(field, "")
        if enc:
            phone = storage.decrypt_phone(enc)
            if phone and len(phone) >= 4:
                return phone[-4:]
    return ""


def _get_phone_full(voter: dict) -> str:
    """Decrypt the first available phone field and return the full number."""
    for field in ("phone_sr_enc", "phone_enc", "whatsapp_enc", "phone3_enc"):
        enc = voter.get(field, "")
        if enc:
            phone = storage.decrypt_phone(enc)
            if phone and len(phone) >= 4:
                return phone
    return ""


def sanitize_coupon_voter(voter: dict) -> dict:
    return {
        "voter_id":         voter.get("RowKey", ""),
        "name":             voter.get("name", ""),
        "name_en":          voter.get("name_en", ""),
        "name_ta":          voter.get("name_ta", ""),
        "name_seg":         voter.get("name_seg", ""),
        "relation_type":    voter.get("relation_type", "") or voter.get("relationship", ""),
        "relation_name":    voter.get("relation_name", ""),
        "relation_name_ta": voter.get("relation_name_ta", ""),
        "age":              voter.get("age", 0),
        "gender":           voter.get("gender", ""),
        "famcode":          voter.get("famcode", ""),
        "is_head":          voter.get("is_head", "No"),
        "house":            voter.get("house", ""),
        "section":          storage.street_key(voter),
        "section_ta":       voter.get("section_name_ta", ""),
        "sl":               voter.get("sl", ""),
        "booth":            voter.get("booth", ""),
        "phone_last4":      _get_phone_last4(voter),
        "phone":            _get_phone_full(voter),
        "party_support":    voter.get("party_support", ""),
    }


def _build_coupon_families(voters: list, custom_families: list, coupon_statuses: dict, booth: str,
                           ejected_ids: set = None, cross_claimed_ids: set = None):
    """Build combined natural + custom family list with coupon statuses."""
    if ejected_ids is None:
        ejected_ids = set()
    if cross_claimed_ids is None:
        cross_claimed_ids = set()
    voter_lookup = {v.get("RowKey", ""): v for v in voters}

    # Voters in custom families, ejected, OR cross-claimed — excluded from natural families
    custom_voter_ids = set(ejected_ids) | cross_claimed_ids
    for cf in custom_families:
        custom_voter_ids.update(cf["voter_ids"])

    # Natural families (skip voters in custom families)
    nat_families = {}
    for v in voters:
        vid = v.get("RowKey", "")
        if vid in custom_voter_ids:
            continue
        famcode = v.get("famcode", "")
        if not famcode:
            famcode = vid  # ungrouped — single-member family
        if famcode not in nat_families:
            nat_families[famcode] = {
                "famcode": famcode, "members": [],
                "house": v.get("house", ""), "section": storage.street_key(v), "section_ta": v.get("section_name_ta", ""),
                "head_name": "", "head_name_ta": "",
                "is_custom": False,
            }
        member = sanitize_coupon_voter(v)
        member["coupon_status"]        = coupon_statuses.get(vid, {}).get("status", "not_delivered")
        member["delivered_by"]         = coupon_statuses.get(vid, {}).get("delivered_by", "")
        member["delivered_by_name"]    = coupon_statuses.get(vid, {}).get("delivered_by_name", "")
        member["delivered_at"]         = coupon_statuses.get(vid, {}).get("updated_at", "")
        nat_families[famcode]["members"].append(member)
        if v.get("is_head", "No") == "Yes":
            nat_families[famcode]["head_name"]    = v.get("name", "")
            nat_families[famcode]["head_name_ta"] = v.get("name_ta", "")

    family_list = list(nat_families.values())
    for f in family_list:
        if not f["head_name"] and f["members"]:
            f["head_name"]    = f["members"][0]["name"]
            f["head_name_ta"] = f["members"][0].get("name_ta", "")
        f["member_count"] = len(f["members"])

    # Custom families — use local voter_lookup first, fall back to stored inline data
    stored_by_vid = {}  # built once per custom family from members_data
    for cf in custom_families:
        members = []
        inline_map = {m.get("voter_id", ""): m for m in cf.get("members_data", [])}
        for vid in cf["voter_ids"]:
            v = voter_lookup.get(vid)
            if v:
                member = sanitize_coupon_voter(v)
            elif vid in inline_map:
                # Cross-booth voter — use stored inline data
                member = dict(inline_map[vid])
                member.setdefault("voter_id", vid)
            else:
                continue  # voter data unavailable
            member["coupon_status"]     = coupon_statuses.get(vid, {}).get("status", "not_delivered")
            member["delivered_by"]      = coupon_statuses.get(vid, {}).get("delivered_by", "")
            member["delivered_by_name"] = coupon_statuses.get(vid, {}).get("delivered_by_name", "")
            member["delivered_at"]      = coupon_statuses.get(vid, {}).get("updated_at", "")
            members.append(member)
        if not members:
            continue
        head = next((m for m in members if m.get("is_head") == "Yes"), members[0])
        family_list.append({
            "famcode":      cf["famcode"],
            "members":      members,
            "member_count": len(members),
            "house":        members[0].get("house", ""),
            "section":      members[0].get("section", ""),
            "head_name":    head.get("name_en") or head.get("name", ""),
            "head_name_ta": head.get("name_ta", ""),
            "is_custom":    True,
            "created_by":   cf.get("created_by", ""),
        })

    # Ejected voters — appear in Other tab UNLESS cross-claimed by another ward
    for vid in ejected_ids:
        if vid in cross_claimed_ids:
            continue  # owned by another ward — hidden completely from this ward
        if vid not in voter_lookup:
            continue  # voter no longer in this booth
        v = voter_lookup[vid]
        member = sanitize_coupon_voter(v)
        member["coupon_status"]     = coupon_statuses.get(vid, {}).get("status", "not_delivered")
        member["delivered_by"]      = coupon_statuses.get(vid, {}).get("delivered_by", "")
        member["delivered_by_name"] = coupon_statuses.get(vid, {}).get("delivered_by_name", "")
        member["delivered_at"]      = coupon_statuses.get(vid, {}).get("updated_at", "")
        family_list.append({
            "famcode":      vid,          # famcode = voter_id → appears in Other tab
            "members":      [member],
            "member_count": 1,
            "house":        v.get("house", ""),
            "section":      storage.street_key(v),
            "head_name":    v.get("name_en") or v.get("name", ""),
            "head_name_ta": v.get("name_ta", ""),
            "is_custom":    False,        # so Other tab logic catches it
            "is_ejected":   True,
        })

    family_list.sort(key=lambda x: (x.get("section", ""), x.get("house", "")))
    return family_list


# ── Booth-level ──────────────────────────────────────────────────────────────

@router.get("/families")
async def get_coupon_families(request: Request, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    log_page_view(user["phone"], "coupon_families", get_client_ip(request))

    voters, custom_families, coupon_statuses, ejected_ids, cross_claimed_ids = await asyncio.gather(
        asyncio.to_thread(storage.get_voters_by_booth, ward, booth),
        asyncio.to_thread(storage.get_coupon_families, ward, booth),
        asyncio.to_thread(storage.get_all_coupon_statuses, ward, booth),
        asyncio.to_thread(storage.get_ejected_coupon_voters, ward, booth),
        asyncio.to_thread(storage.get_cross_claimed_voters, ward, booth),
    )

    family_list = _build_coupon_families(voters, custom_families, coupon_statuses, booth,
                                         ejected_ids, cross_claimed_ids)

    # Streets for filter
    streets = sorted({m.get("section", "") for f in family_list for m in f["members"] if m.get("section")})

    all_members = [m for f in family_list for m in f["members"]]
    total     = len(all_members)
    delivered = sum(1 for m in all_members if m["coupon_status"] == "delivered")

    return {
        "families": family_list,
        "streets": streets,
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
    }


@router.get("/search")
async def search_coupon_voters(request: Request, q: str = ""):
    """Search voters by Voter ID (EPIC) across all wards using direct RowKey lookup."""
    require_role(request, "booth", "ward", "telecaller", "superadmin")
    if not q or len(q) < 3:
        return {"results": []}

    q_upper = q.upper().strip()
    table = storage.get_table(storage.table_name("Voters"))
    select_fields = ["RowKey", "PartitionKey", "name", "name_en", "name_ta", "sl",
                     "booth", "section", "house", "famcode", "is_head", "age",
                     "gender", "relation_type", "relation_name", "relation_name_ta"]
    results = []

    # Exact voter_id match (RowKey = voter_id, fastest path)
    for entity in table.query_entities(f"RowKey eq '{q_upper}'", select=select_fields):
        pk_parts = entity.get("PartitionKey", "__").split("__", 1)
        m = storage.sanitize_voter_for_coupon(entity)
        m["ward"] = pk_parts[0] if len(pk_parts) > 1 else ""
        results.append(m)

    # Prefix match if no exact result (RowKey ge 'ABC' and RowKey lt 'ABC~')
    if not results:
        for entity in table.query_entities(
            f"RowKey ge '{q_upper}' and RowKey lt '{q_upper}~'",
            select=select_fields
        ):
            pk_parts = entity.get("PartitionKey", "__").split("__", 1)
            m = storage.sanitize_voter_for_coupon(entity)
            m["ward"] = pk_parts[0] if len(pk_parts) > 1 else ""
            results.append(m)
            if len(results) >= 10:
                break

    return {"results": results[:10]}


class CouponFamilyRequest(BaseModel):
    ward: str
    booth: str
    voter_ids: List[str]
    members_data: List[dict] = []


def _get_voter_home_locations(voter_ids_set: set, members_data: list) -> dict:
    """Return {voter_id: (ward, booth)} for cross-ward voters using stored members_data."""
    home = {}
    for m in members_data:
        vid = m.get("voter_id", "")
        if vid in voter_ids_set and m.get("ward") and m.get("booth"):
            home[vid] = (m["ward"], m["booth"])
    return home


async def _evict_voters_globally(voter_ids_set: set, skip_famcode: str = "", skip_ward: str = "",
                                 home_locations: dict = None, target_ward: str = "",
                                 target_booth: str = ""):
    """Remove voters from coupon families in relevant booths only.
    Scans target booth + voter home booths instead of all wards/booths."""
    # Collect only the specific (ward, booth) pairs we need to check
    booth_pairs = set()
    if target_ward and target_booth:
        booth_pairs.add((target_ward, target_booth))
    if home_locations:
        for vid, (hw, hb) in home_locations.items():
            booth_pairs.add((hw, hb))

    if not booth_pairs:
        return

    pairs_list = list(booth_pairs)

    # Fetch families for only the relevant booths — all in parallel
    all_families = await asyncio.gather(
        *[asyncio.to_thread(storage.get_coupon_families, w, b) for w, b in pairs_list]
    )

    # Process: remove voters from families, clean up ejection/cross-claim — all in parallel
    cleanup_tasks = []
    for (ward, booth), families in zip(pairs_list, all_families):
        cleanup_tasks.append(asyncio.to_thread(
            storage.remove_from_ejected_coupon_voters, ward, booth, list(voter_ids_set)))
        cleanup_tasks.append(asyncio.to_thread(
            storage.remove_cross_claimed_voters, ward, booth, list(voter_ids_set)))
        for cf in families:
            if cf["famcode"] == skip_famcode and ward == skip_ward:
                continue
            updated = [v for v in cf["voter_ids"] if v not in voter_ids_set]
            if len(updated) != len(cf["voter_ids"]):
                if updated:
                    cleanup_tasks.append(asyncio.to_thread(
                        storage.update_coupon_family_members, ward, booth, cf["famcode"], updated))
                else:
                    cleanup_tasks.append(asyncio.to_thread(
                        storage.delete_coupon_family, ward, booth, cf["famcode"]))

    if cleanup_tasks:
        await asyncio.gather(*cleanup_tasks)

    # Cross-claim voters in their home ward so they're hidden there entirely
    if home_locations and target_ward:
        cross_tasks = []
        for vid, (home_ward, home_booth) in home_locations.items():
            if home_ward != target_ward:
                cross_tasks.append(asyncio.to_thread(
                    storage.add_ejected_coupon_voters, home_ward, home_booth, [vid]))
                cross_tasks.append(asyncio.to_thread(
                    storage.add_cross_claimed_voters, home_ward, home_booth, [vid]))
        if cross_tasks:
            await asyncio.gather(*cross_tasks)


async def _evict_voters_from_ward(ward: str, voter_ids_set: set, skip_famcode: str = "",
                                   members_data: list = None, target_booth: str = ""):
    """Evict voters from relevant booths, cross-claiming cross-ward voters in their home ward."""
    home_locs = _get_voter_home_locations(voter_ids_set, members_data or [])
    await _evict_voters_globally(voter_ids_set, skip_famcode=skip_famcode, skip_ward=ward,
                                  home_locations=home_locs, target_ward=ward,
                                  target_booth=target_booth)


@router.post("/families")
async def create_coupon_family(request: Request, body: CouponFamilyRequest):
    user = require_booth_access(request, body.ward, body.booth)
    if not body.voter_ids:
        raise HTTPException(status_code=400, detail="voter_ids required")

    # Move cross-ward voters into this ward/booth first, then evict from old families
    added_home = _get_voter_home_locations(set(body.voter_ids), body.members_data)
    cross_ward_vids = set()
    for vid in body.voter_ids:
        if vid in added_home and added_home[vid][0] != body.ward:
            cross_ward_vids.add(vid)

    # Evict from old families — exclude moved voters from members_data so they're treated as same-ward
    local_members_data = [m for m in body.members_data if m.get("voter_id") not in cross_ward_vids]
    await _evict_voters_from_ward(body.ward, set(body.voter_ids), members_data=local_members_data,
                                   target_booth=body.booth)

    famcode = storage.create_coupon_family(body.ward, body.booth, body.voter_ids, user["phone"],
                                           members_data=body.members_data)

    # Same-ward voters — set famcode so they join across all tabs
    # Cross-ward voters — move them into this ward/booth with the new famcode
    for vid in body.voter_ids:
        if vid in cross_ward_vids:
            storage.move_voter(added_home[vid][0], added_home[vid][1],
                               body.ward, body.booth, vid, famcode)
        else:
            storage.set_voter_famcode(body.ward, body.booth, vid, famcode)
    storage.log_coupon_action(body.ward, body.booth, "create", famcode,
                              body.voter_ids, [], user["phone"], _user_name(user))
    logger.info("coupon_family_created", famcode=famcode, by=user["phone"][-4:])
    return {"success": True, "famcode": famcode}


@router.put("/families/{famcode}")
async def update_coupon_family(request: Request, famcode: str, body: CouponFamilyRequest):
    user = require_booth_access(request, body.ward, body.booth)

    # Get old family data (voter_ids + members_data for home location lookup)
    old_cf = next((cf for cf in storage.get_coupon_families(body.ward, body.booth) if cf["famcode"] == famcode), {})
    old_ids = set(old_cf.get("voter_ids", []))
    old_members_data = old_cf.get("members_data", [])

    # First edit of a natural family — no CouponFamilies row exists yet.
    # Look up the natural members from voter data so we know who was removed.
    if not old_ids:
        nat_voters = storage.get_voters_by_booth(body.ward, body.booth)
        old_ids = {v.get("RowKey", "") for v in nat_voters if v.get("famcode", "") == famcode}
    new_ids = set(body.voter_ids)

    # Removed voters — clear famcode so they're permanently ungrouped
    # (cross-ward voters were already moved into this ward/booth, so they're all local now)
    removed = list(old_ids - new_ids)
    for vid in removed:
        storage.clear_voter_famcode(body.ward, body.booth, vid)

    # Newly added voters:
    # Same-ward — set famcode so they join across all tabs
    # Cross-ward — move them into this ward/booth with the family's famcode
    added = list(new_ids - old_ids)
    cross_ward_vids = set()
    if added:
        added_home = _get_voter_home_locations(set(added), body.members_data)
        for vid in added:
            if vid in added_home and added_home[vid][0] != body.ward:
                cross_ward_vids.add(vid)
                storage.move_voter(added_home[vid][0], added_home[vid][1],
                                   body.ward, body.booth, vid, famcode)
            else:
                storage.set_voter_famcode(body.ward, body.booth, vid, famcode)

    # Evict newly-added voters from other families — exclude moved voters from members_data
    if new_ids:
        local_members_data = [m for m in body.members_data if m.get("voter_id") not in cross_ward_vids]
        await _evict_voters_from_ward(body.ward, new_ids, skip_famcode=famcode,
                                       members_data=local_members_data, target_booth=body.booth)

    action = "update" if body.voter_ids else "delete"
    storage.log_coupon_action(body.ward, body.booth, action, famcode,
                              body.voter_ids, list(old_ids), user["phone"], _user_name(user))
    if body.voter_ids:
        storage.update_coupon_family_members(body.ward, body.booth, famcode, body.voter_ids,
                                             created_by=user["phone"], members_data=body.members_data)
    else:
        storage.delete_coupon_family(body.ward, body.booth, famcode)
    return {"success": True}


@router.delete("/families/{famcode}")
async def delete_coupon_family(request: Request, famcode: str, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    storage.delete_coupon_family(ward, booth, famcode)
    return {"success": True}


@router.post("/deliver")
async def deliver_coupon(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_coupon_status(ward, booth, vid, "delivered", user["phone"], name)
    return {"success": True, "count": len(body.voter_ids)}


@router.post("/undeliver")
async def undeliver_coupon(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_coupon_status(ward, booth, vid, "not_delivered", user["phone"], name)
    return {"success": True, "count": len(body.voter_ids)}


@router.get("/stats")
async def get_coupon_booth_stats(request: Request, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    return storage.get_coupon_stats(ward, booth)


# ── Ward-level ───────────────────────────────────────────────────────────────

@router.get("/ward/families")
async def get_ward_coupon_families(request: Request, ward: str, booth: str = ""):
    user = require_ward_access(request, ward)
    log_page_view(user["phone"], "coupon_ward_families", get_client_ip(request))

    target_booths = [booth] if booth else storage.get_booths_for_ward(ward)

    voters_all, custom_all, statuses_all, ejected_all, claimed_all = await asyncio.gather(
        asyncio.gather(*[asyncio.to_thread(storage.get_voters_by_booth, ward, b) for b in target_booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_coupon_families, ward, b) for b in target_booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_all_coupon_statuses, ward, b) for b in target_booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_ejected_coupon_voters, ward, b) for b in target_booths]),
        asyncio.gather(*[asyncio.to_thread(storage.get_cross_claimed_voters, ward, b) for b in target_booths]),
    )

    all_families = []
    total = delivered = 0
    streets_set = set()

    for i, b in enumerate(target_booths):
        fams = _build_coupon_families(voters_all[i], custom_all[i], statuses_all[i], b,
                                      ejected_all[i], claimed_all[i])
        for f in fams:
            f["booth"] = b
        all_families.extend(fams)
        for f in fams:
            for m in f["members"]:
                total += 1
                if m["coupon_status"] == "delivered":
                    delivered += 1
                if m.get("section"):
                    streets_set.add(m["section"])

    all_families.sort(key=lambda x: (x.get("booth", ""), x.get("section", ""), x.get("house", "")))
    return {
        "families": all_families,
        "streets": sorted(streets_set),
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
    }


@router.post("/ward/deliver")
async def ward_deliver_coupon(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_ward_access(request, ward)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_coupon_status(ward, booth, vid, "delivered", user["phone"], name)
    return {"success": True}


@router.post("/ward/undeliver")
async def ward_undeliver_coupon(request: Request, body: NoticeDeliverRequest, ward: str, booth: str):
    user = require_ward_access(request, ward)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_coupon_status(ward, booth, vid, "not_delivered", user["phone"], name)
    return {"success": True}


@router.get("/ward/stats")
async def get_ward_coupon_stats(request: Request, ward: str):
    require_ward_access(request, ward)
    booths = storage.get_booths_for_ward(ward)
    stats_list = await asyncio.gather(*[asyncio.to_thread(storage.get_coupon_stats, ward, b) for b in booths])
    total = sum(s["total"] for s in stats_list)
    delivered = sum(s["delivered"] for s in stats_list)
    return {
        "total": total,
        "delivered": delivered,
        "pending": total - delivered,
        "completion_pct": round(delivered / total * 100) if total else 0,
    }


# ── Admin-level ──────────────────────────────────────────────────────────────

@router.get("/admin/stats")
async def get_admin_coupon_stats(request: Request, ward: str = "", booths: str = ""):
    require_role(request, "superadmin")
    all_wards = storage.get_all_wards() if not ward else [ward]
    grand_total = grand_delivered = 0
    for w in all_wards:
        booth_list = storage.get_booths_for_ward(w)
        stats_list = await asyncio.gather(*[asyncio.to_thread(storage.get_coupon_stats, w, b) for b in booth_list])
        grand_total     += sum(s["total"]     for s in stats_list)
        grand_delivered += sum(s["delivered"] for s in stats_list)
    grand_pending = grand_total - grand_delivered
    return {
        "grand_total":          grand_total,
        "grand_delivered":      grand_delivered,
        "grand_pending":        grand_pending,
        "grand_completion_pct": round(grand_delivered / grand_total * 100) if grand_total else 0,
    }


# ── Audit Log ────────────────────────────────────────────────────────────────

@router.get("/admin/audit-log")
async def get_coupon_audit_log(request: Request, ward: str = "", booth: str = "", by_phone: str = ""):
    require_role(request, "superadmin")
    entries = storage.get_coupon_audit_log(ward=ward, booth=booth, by_phone=by_phone, limit=300)
    return {"entries": entries}


@router.post("/admin/undo/{log_id}")
async def undo_coupon_action(request: Request, log_id: str, ward: str):
    user = require_role(request, "superadmin")
    # Find the log entry
    entries = storage.get_coupon_audit_log(ward=ward, limit=500)
    entry = next((e for e in entries if e["log_id"] == log_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Log entry not found")

    action   = entry["action"]
    booth    = entry["booth"]
    famcode  = entry["famcode"]
    old_ids  = entry["old_voter_ids"]
    new_ids  = entry["voter_ids"]

    if action == "create":
        # Undo create → delete the family
        await _evict_voters_from_ward(ward, set(new_ids), skip_famcode="", target_booth=booth)
        storage.delete_coupon_family(ward, booth, famcode)
        storage.log_coupon_action(ward, booth, "undo_create", famcode, [], new_ids, user["phone"], _user_name(user))

    elif action == "update":
        # Undo update → restore old voter_ids
        if old_ids:
            await _evict_voters_from_ward(ward, set(old_ids), skip_famcode=famcode, target_booth=booth)
            storage.update_coupon_family_members(ward, booth, famcode, old_ids, created_by=user["phone"])
            storage.log_coupon_action(ward, booth, "undo_update", famcode, old_ids, new_ids, user["phone"], _user_name(user))
        else:
            storage.delete_coupon_family(ward, booth, famcode)

    elif action == "delete":
        # Undo delete → recreate family with old voter_ids
        if old_ids:
            await _evict_voters_from_ward(ward, set(old_ids), target_booth=booth)
            storage.update_coupon_family_members(ward, booth, famcode, old_ids, created_by=user["phone"])
            storage.log_coupon_action(ward, booth, "undo_delete", famcode, old_ids, [], user["phone"], _user_name(user))

    else:
        raise HTTPException(status_code=400, detail=f"Cannot undo action: {action}")

    return {"success": True}
