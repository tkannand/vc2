import asyncio
import structlog
from fastapi import APIRouter, Request, HTTPException
from typing import Optional
from backend.middleware import require_role, get_client_ip
from backend.models import AddUserRequest, UpdateUserSecurityRequest, BulkRemoveRequest
from backend import storage
from backend.activity import log_page_view, log_user_management

logger = structlog.get_logger()
router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/dashboard")
async def get_dashboard(request: Request, ward: Optional[str] = None, booths: Optional[str] = None):
    user = require_role(request, "superadmin")
    log_page_view(user["phone"], "admin_dashboard", get_client_ip(request))

    all_wards = storage.get_all_wards()
    booth_filter = [b.strip() for b in booths.split(",") if b.strip()] if booths else []

    # Determine which wards/booths to include
    target_wards = [ward] if ward else all_wards
    ward_data = []
    booth_data = []
    grand_total = grand_called = grand_didnt = grand_skipped = grand_pending = 0
    all_statuses_for_trend = []

    # Collect all (ward, booth) pairs to query in parallel
    ward_booth_pairs = []
    ward_bi_maps = {}
    for w in target_wards:
        w_booths = storage.get_booths_for_ward(w)
        bi_map = storage.get_booth_info_map(w)
        ward_bi_maps[w] = bi_map
        if booth_filter:
            w_booths = [b for b in w_booths if b in booth_filter]
        for b in w_booths:
            ward_booth_pairs.append((w, b))

    # Fetch call stats + statuses for all booths in parallel
    async def fetch_booth(w: str, b: str):
        stats = await asyncio.to_thread(storage.get_call_stats, w, b)
        statuses = await asyncio.to_thread(storage.get_all_call_statuses, w, b)
        return w, b, stats, statuses

    results = await asyncio.gather(*[fetch_booth(w, b) for w, b in ward_booth_pairs])

    # Aggregate results
    ward_totals: dict = {}
    for w, b, stats, statuses in results:
        info = ward_bi_maps[w].get(b, {})
        booth_data.append({
            "ward": w, "booth": b,
            "booth_number": info.get("booth_number", ""),
            "booth_name": info.get("booth_name", ""),
            **stats,
        })
        all_statuses_for_trend.extend(statuses.values())

        if w not in ward_totals:
            ward_totals[w] = {"total": 0, "called": 0, "didnt_answer": 0, "skipped": 0, "not_called": 0, "booths": 0}
        ward_totals[w]["total"] += stats["total"]
        ward_totals[w]["called"] += stats["called"]
        ward_totals[w]["didnt_answer"] += stats["didnt_answer"]
        ward_totals[w]["skipped"] += stats["skipped"]
        ward_totals[w]["not_called"] += stats["not_called"]
        ward_totals[w]["booths"] += 1

    for w, t in ward_totals.items():
        ward_data.append({
            "ward": w,
            "booth_count": t["booths"],
            "total": t["total"],
            "called": t["called"],
            "didnt_answer": t["didnt_answer"],
            "skipped": t["skipped"],
            "not_called": t["not_called"],
            "completion_pct": round((t["called"] / t["total"] * 100) if t["total"] > 0 else 0, 1),
        })
        grand_total += t["total"]
        grand_called += t["called"]
        grand_didnt += t["didnt_answer"]
        grand_skipped += t["skipped"]
        grand_pending += t["not_called"]

    # Daily trend from call statuses
    daily_trend = {}
    for s in all_statuses_for_trend:
        updated = s.get("updated_at", "")
        if not updated:
            continue
        day = updated[:10]  # YYYY-MM-DD
        if day not in daily_trend:
            daily_trend[day] = {"date": day, "called": 0, "didnt_answer": 0, "skipped": 0, "total": 0}
        status = s.get("status", "")
        if status == "called":
            daily_trend[day]["called"] += 1
        elif status == "didnt_answer":
            daily_trend[day]["didnt_answer"] += 1
        elif status == "skipped":
            daily_trend[day]["skipped"] += 1
        daily_trend[day]["total"] += 1

    trend_list = sorted(daily_trend.values(), key=lambda x: x["date"])

    # Worker performance
    all_users = storage.get_all_users()
    target_workers = storage.get_worker_activity_summary(
        ward=ward if ward else "",
        booth=booth_filter[0] if len(booth_filter) == 1 else ""
    )
    for w_stat in target_workers:
        matched = next((u for u in all_users if u["RowKey"] == w_stat["phone"]), None)
        if matched:
            w_stat["name"] = matched.get("name", w_stat["phone"][-4:])
        else:
            w_stat["name"] = w_stat["phone"][-4:]

    # User counts
    user_count = {"superadmin": 0, "ward": 0, "booth": 0, "telecaller": 0}
    for u in all_users:
        role = u.get("PartitionKey", "")
        if role in user_count:
            user_count[role] += 1

    return {
        "grand_total": grand_total,
        "grand_called": grand_called,
        "grand_didnt_answer": grand_didnt,
        "grand_skipped": grand_skipped,
        "grand_not_called": grand_pending,
        "grand_completion_pct": round((grand_called / grand_total * 100) if grand_total > 0 else 0, 1),
        "wards": ward_data,
        "booths": booth_data,
        "daily_trend": trend_list,
        "workers": target_workers[:20],
        "user_count": user_count,
        "all_wards": all_wards,
    }


@router.get("/ward-detail")
async def get_ward_detail(request: Request, ward: str):
    user = require_role(request, "superadmin")
    log_page_view(user["phone"], f"admin_ward_{ward}", get_client_ip(request))

    booths = storage.get_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)
    booth_data = []
    for b in booths:
        stats = storage.get_call_stats(ward, b)
        info = bi_map.get(b, {})
        booth_data.append({"booth": b, "booth_number": info.get("booth_number", ""), "booth_name": info.get("booth_name", ""), "booth_name_tamil": info.get("booth_name_tamil", ""), **stats})

    workers = storage.get_worker_activity_summary(ward=ward)
    all_users = storage.get_all_users()
    for w in workers:
        matched = next((u for u in all_users if u["RowKey"] == w["phone"]), None)
        if matched:
            w["name"] = matched.get("name", w["phone"][-4:])
        else:
            w["name"] = w["phone"][-4:]

    return {"ward": ward, "booths": booth_data, "workers": workers}


@router.get("/users")
async def get_users(request: Request):
    user = require_role(request, "superadmin")
    log_page_view(user["phone"], "admin_users", get_client_ip(request))

    users = storage.get_all_users()
    # Batch-fetch which phones have a PIN set (single query on Settings table)
    phones_with_pin = storage.get_all_pin_phones()
    # Build booth info lookup per ward
    bi_cache = {}
    result = []
    for u in users:
        ward = u.get("ward", "")
        booth = u.get("booth", "")
        booth_number = ""
        booth_name = ""
        booth_name_tamil = ""
        if ward and booth:
            if ward not in bi_cache:
                bi_cache[ward] = storage.get_booth_info_map(ward)
            info = bi_cache[ward].get(booth, {})
            booth_number = info.get("booth_number", "")
            booth_name = info.get("booth_name", "")
            booth_name_tamil = info.get("booth_name_tamil", "")
        result.append({
            "phone": u["RowKey"],
            "name": u.get("name", ""),
            "role": u["PartitionKey"],
            "ward": u.get("ward", ""),
            "booth": u.get("booth", ""),
            "booth_number": booth_number,
            "booth_name": booth_name,
            "booth_name_tamil": booth_name_tamil,
            "language": u.get("language", "en"),
            # Security fields
            "active": bool(u.get("active", True)),
            "geo_tracking": bool(u.get("geo_tracking", True)),
            "schedule": u.get("schedule", ""),
            "last_lat": u.get("last_lat"),
            "last_lng": u.get("last_lng"),
            "last_location_at": u.get("last_location_at", ""),
            # Login tracking
            "login_count": u.get("login_count", 0),
            "last_login_at": u.get("last_login_at", ""),
            "has_pin": u["RowKey"] in phones_with_pin,
        })
    return {"users": result}


@router.post("/users")
async def add_user(request: Request, body: AddUserRequest):
    admin = require_role(request, "superadmin")
    ip = get_client_ip(request)

    existing_roles = storage.get_user_roles(body.phone)
    if any(u["PartitionKey"] == body.role for u in existing_roles):
        raise HTTPException(status_code=400, detail="User already has this role")

    if body.role in ("ward", "telecaller") and not body.ward:
        raise HTTPException(status_code=400, detail="Ward is required for this role")
    if body.role == "booth" and (not body.ward or not body.booth):
        raise HTTPException(status_code=400, detail="Ward and booth are required for booth role")

    storage.upsert_user(
        phone=body.phone,
        name=body.name,
        role=body.role,
        ward=body.ward or "",
        booth=body.booth or "",
    )
    log_user_management(admin["phone"], "add", body.phone, ip)
    return {"success": True, "message": "User added"}


@router.put("/users/{phone}")
async def update_user(request: Request, phone: str, body: AddUserRequest):
    admin = require_role(request, "superadmin")
    ip = get_client_ip(request)

    # Use get_user_roles so we detect superadmin even on multi-role users
    existing_roles = storage.get_user_roles(phone)
    if not existing_roles:
        raise HTTPException(status_code=404, detail="User not found")

    # Block if the user has ANY superadmin role, or if trying to assign superadmin
    if any(u["PartitionKey"] == "superadmin" for u in existing_roles):
        raise HTTPException(status_code=400, detail="Cannot edit superadmin")
    if body.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot assign superadmin role via edit; use Add User instead")

    if body.role in ("ward", "telecaller") and not body.ward:
        raise HTTPException(status_code=400, detail="Ward is required for this role")
    if body.role == "booth" and (not body.ward or not body.booth):
        raise HTTPException(status_code=400, detail="Ward and booth are required for booth role")

    # Determine current stored role (PartitionKey) for role-change detection
    current_role = existing_roles[0]["PartitionKey"]
    if current_role != body.role:
        storage.delete_user(phone, current_role)

    storage.upsert_user(phone=phone, name=body.name, role=body.role,
                        ward=body.ward or "", booth=body.booth or "")
    log_user_management(admin["phone"], "update", phone, ip)
    return {"success": True, "message": "User updated"}


@router.delete("/users/{phone}")
async def remove_user(request: Request, phone: str):
    admin = require_role(request, "superadmin")
    ip = get_client_ip(request)

    if phone == admin["phone"]:
        raise HTTPException(status_code=400, detail="Cannot remove yourself")

    target = storage.get_user(phone)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if target.get("PartitionKey") == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot remove superadmin")

    storage.delete_user(phone, target["PartitionKey"])
    log_user_management(admin["phone"], "remove", phone, ip)
    return {"success": True, "message": "User removed"}


@router.post("/users/bulk-remove")
async def bulk_remove_users(request: Request, body: BulkRemoveRequest):
    admin = require_role(request, "superadmin")
    ip = get_client_ip(request)
    admin_phone = admin["phone"]

    removed = 0
    skipped = 0
    for phone in body.phones:
        if phone == admin_phone:
            skipped += 1
            continue
        user_roles = storage.get_user_roles(phone)
        if not user_roles:
            skipped += 1
            continue
        if any(u["PartitionKey"] == "superadmin" for u in user_roles):
            skipped += 1
            continue
        for u in user_roles:
            storage.delete_user(phone, u["PartitionKey"])
        removed += 1

    log_user_management(admin_phone, "bulk_remove", f"{removed}_users", ip)
    logger.info("bulk_remove_completed", removed=removed, skipped=skipped, by=admin_phone[-4:])
    return {"success": True, "removed": removed, "skipped": skipped}


@router.patch("/users/{phone}/settings")
async def update_user_settings(request: Request, phone: str, body: UpdateUserSecurityRequest):
    """Update per-user security settings: active, schedule, geo_tracking."""
    admin = require_role(request, "superadmin")
    ip = get_client_ip(request)

    target = storage.get_user(phone)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.get("PartitionKey") == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot edit superadmin security settings")

    storage.update_user_security(
        phone=phone,
        active=body.active,
        schedule=body.schedule,
        geo_tracking=body.geo_tracking,
    )
    log_user_management(admin["phone"], "update_settings", phone, ip)
    return {"success": True, "message": "Settings updated"}


@router.get("/wards")
async def get_wards(request: Request):
    require_role(request, "superadmin")
    wards = storage.get_all_wards()
    return {"wards": wards}


@router.get("/ward-booths")
async def get_ward_booths(request: Request, ward: str):
    require_role(request, "superadmin")
    booths = storage.get_booths_for_ward(ward)
    bi_map = storage.get_booth_info_map(ward)
    return {"booths": [{
        "booth": b,
        "booth_number": bi_map.get(b, {}).get("booth_number", ""),
        "booth_name": bi_map.get(b, {}).get("booth_name", ""),
        "booth_name_tamil": bi_map.get(b, {}).get("booth_name_tamil", ""),
    } for b in booths]}


@router.get("/user-locations")
async def get_user_locations(request: Request):
    """Return all users with their last known GPS location and geo_tracking status."""
    require_role(request, "superadmin")
    all_users = storage.get_all_users()
    result = []
    seen = set()  # deduplicate by phone (multi-role users appear once)
    for u in all_users:
        phone = u["RowKey"]
        if phone in seen:
            continue
        seen.add(phone)
        last_lat = u.get("last_lat")
        last_lng = u.get("last_lng")
        result.append({
            "phone": phone,
            "name": u.get("name", ""),
            "role": u["PartitionKey"],
            "ward": u.get("ward", ""),
            "geo_tracking": bool(u.get("geo_tracking", True)),
            "last_lat": float(last_lat) if last_lat is not None else None,
            "last_lng": float(last_lng) if last_lng is not None else None,
            "last_location_at": u.get("last_location_at", ""),
        })
    # Sort: users with location first, then by last_location_at descending
    result.sort(key=lambda x: x["last_location_at"] or "", reverse=True)
    return {"users": result}


@router.get("/user-activity-stats")
async def get_user_activity_stats(request: Request):
    """Logged-in-today and active-now counts derived from today's ActivityLogs."""
    require_role(request, "superadmin")
    from datetime import datetime, timezone, timedelta
    now   = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    cutoff = (now - timedelta(minutes=30)).isoformat()

    logs = storage.get_activity_logs(date_from=today, date_to=today, limit=5000)

    logged_in_today: set = set()
    active_now: set      = set()
    for log in logs:
        phone = log.get("phone", "")
        if not phone or phone == "anonymous":
            continue
        logged_in_today.add(phone)
        if log.get("timestamp", "") >= cutoff:
            active_now.add(phone)

    return {
        "logged_in_today": len(logged_in_today),
        "active_now":      len(active_now),
    }


@router.get("/notice/sync-failures")
async def get_notice_sync_failures(request: Request):
    """Return recent notice sync failures for superadmin review."""
    require_role(request, "superadmin")
    failures = storage.get_sync_failures(limit=200)
    return {"failures": failures}


@router.get("/universe")
async def get_universe(request: Request):
    """Instant return of cached voter universe stats (no Azure scan)."""
    require_role(request, "superadmin", "ward", "booth")
    return {"universe": storage.get_universe_stats(), "all_wards": storage.get_all_wards()}


@router.get("/summary")
async def get_summary(
    request: Request,
    ward:  Optional[str] = None,
    booth: Optional[str] = None,
):
    """Single-call dashboard summary: scheme totals + ward breakdown + trend + workers.
    Optional ward/booth params filter the computation to a specific scope.
    """
    user = require_role(request, "superadmin", "ward", "booth")
    log_page_view(user["phone"], "admin_dashboard", get_client_ip(request))

    # Non-superadmin: ALWAYS override with their account assignment — ignore any query params
    role = user.get("role", "superadmin")
    if role == "ward":
        ward  = user.get("ward", "")   # force their ward regardless of query param
        # booth param allowed — filters within their assigned ward
        # validate booth belongs to this ward (empty = all booths)
        if booth:
            valid_booths = storage.get_booths_for_ward(ward)
            if booth not in valid_booths:
                booth = ""
    elif role == "booth":
        ward  = user.get("ward", "")   # force their ward
        booth = user.get("booth", "")  # force their booth

    all_wards       = storage.get_all_wards()
    universe        = storage.get_universe_stats()
    notice_enabled  = storage.get_notice_enabled()
    coupon_enabled  = storage.get_coupon_enabled()
    custom_schemes  = storage.get_custom_schemes()

    # Build ward-booth pairs based on optional filter
    if ward and booth:
        all_wb_pairs = [(ward, booth)]
    elif ward:
        all_wb_pairs = [(ward, b) for b in storage.get_booths_for_ward(ward)]
    else:
        ward_booths: dict = {w: storage.get_booths_for_ward(w) for w in all_wards}
        all_wb_pairs      = [(w, b) for w, blist in ward_booths.items() for b in blist]

    async def fetch_booth_all(w: str, b: str):
        raw_statuses = await asyncio.to_thread(storage.get_all_call_statuses, w, b)
        pk = f"{storage.normalize_key(w)}__{storage.normalize_key(b)}"
        cached_total = storage.get_setting(f"seg_count_{pk}") or storage.get_setting(f"voter_count_{pk}")
        total   = int(cached_total) if cached_total else 0
        called  = sum(1 for s in raw_statuses.values() if s.get("status") == "called")
        didnt   = sum(1 for s in raw_statuses.values() if s.get("status") == "didnt_answer")
        skipped = sum(1 for s in raw_statuses.values() if s.get("status") == "skipped")
        calling = {
            "total": total, "called": called, "didnt_answer": didnt,
            "skipped": skipped, "not_called": max(0, total - called - didnt - skipped),
            "completion_pct": round(called / total * 100 if total else 0, 1),
        }
        notice = (await asyncio.to_thread(storage.get_notice_stats, w, b)
                  if notice_enabled else {"total": 0, "delivered": 0, "pending": 0})
        coupon = (await asyncio.to_thread(storage.get_coupon_stats, w, b)
                  if coupon_enabled else {"total": 0, "delivered": 0})
        scheme_stats = {}
        if custom_schemes:
            scheme_results = await asyncio.gather(*[
                asyncio.to_thread(storage.get_scheme_stats, w, b, sc["id"])
                for sc in custom_schemes
            ])
            scheme_stats = {sc["id"]: sr for sc, sr in zip(custom_schemes, scheme_results)}
        return w, b, calling, list(raw_statuses.values()), notice, coupon, scheme_stats

    # Filtered views: one ward/booth-level scan runs in parallel with booth stats.
    # One range query covers all booths — no per-booth famcode queries needed.
    async def _scope_famcodes():
        if booth and ward:
            return await asyncio.to_thread(storage.get_voter_famcodes_for_booth, ward, booth)
        if ward:
            return await asyncio.to_thread(storage.get_voter_famcodes_for_ward, ward)
        return []

    booth_results, scope_famcodes = await asyncio.gather(
        asyncio.gather(*[fetch_booth_all(w, b) for w, b in all_wb_pairs]),
        _scope_famcodes(),
    )
    results = booth_results

    # Aggregate per ward
    ward_map: dict = {}
    all_statuses   = []
    grand_custom   = {sc["id"]: {"total": 0, "delivered": 0} for sc in custom_schemes}

    for w, b, calling, statuses, notice, coupon, scheme_stats in results:
        if w not in ward_map:
            ward_map[w] = {
                "ward": w,
                "total": 0, "called": 0, "didnt_answer": 0, "skipped": 0, "not_called": 0,
                "notice_total": 0, "notice_delivered": 0,
                "coupon_total": 0, "coupon_delivered": 0,
                "booths": 0,
            }
        wt = ward_map[w]
        wt["total"]            += calling["total"]
        wt["called"]           += calling["called"]
        wt["didnt_answer"]     += calling["didnt_answer"]
        wt["skipped"]          += calling["skipped"]
        wt["not_called"]       += calling["not_called"]
        wt["notice_total"]     += notice["total"]
        wt["notice_delivered"] += notice["delivered"]
        wt["coupon_total"]     += coupon["total"]
        wt["coupon_delivered"] += coupon["delivered"]
        wt["booths"]           += 1
        for sc_id, sc_stats in scheme_stats.items():
            if sc_id in grand_custom:
                grand_custom[sc_id]["total"]     += sc_stats["total"]
                grand_custom[sc_id]["delivered"] += sc_stats["delivered"]
        all_statuses.extend(statuses)

    ward_data = []
    grand_calling = {"total": 0, "called": 0, "didnt_answer": 0, "skipped": 0}
    grand_notice  = {"total": 0, "delivered": 0}
    grand_coupon  = {"total": 0, "delivered": 0}

    for wt in ward_map.values():
        wt["completion_pct"] = round(wt["called"] / wt["total"] * 100 if wt["total"] else 0, 1)
        ward_data.append(wt)
        grand_calling["total"]       += wt["total"]
        grand_calling["called"]      += wt["called"]
        grand_calling["didnt_answer"] += wt["didnt_answer"]
        grand_calling["skipped"]     += wt["skipped"]
        grand_notice["total"]        += wt["notice_total"]
        grand_notice["delivered"]    += wt["notice_delivered"]
        grand_coupon["total"]        += wt["coupon_total"]
        grand_coupon["delivered"]    += wt["coupon_delivered"]

    # Daily trend from call statuses
    daily_trend: dict = {}
    for s in all_statuses:
        updated = s.get("updated_at", "")
        if not updated:
            continue
        day    = updated[:10]
        status = s.get("status", "")
        if day not in daily_trend:
            daily_trend[day] = {"date": day, "called": 0, "didnt_answer": 0, "skipped": 0}
        if status == "called":
            daily_trend[day]["called"] += 1
        elif status == "didnt_answer":
            daily_trend[day]["didnt_answer"] += 1
        elif status == "skipped":
            daily_trend[day]["skipped"] += 1
    trend_list = sorted(daily_trend.values(), key=lambda x: x["date"])

    # Workers (filtered by scope if ward/booth provided)
    workers   = storage.get_worker_activity_summary(ward=ward or "", booth=booth or "")
    all_users = storage.get_all_users()
    for ws in workers:
        matched  = next((u for u in all_users if u["RowKey"] == ws["phone"]), None)
        ws["name"] = matched.get("name", ws["phone"][-4:]) if matched else ws["phone"][-4:]

    user_count = {"superadmin": 0, "ward": 0, "booth": 0, "telecaller": 0}
    for u in all_users:
        role = u.get("PartitionKey", "")
        if role in user_count:
            user_count[role] += 1

    gt = grand_calling["total"]
    nt = grand_notice["total"]
    ct = grand_coupon["total"]

    # universe_scope: voter+family breakdown scoped to the filter (None for global view)
    # scope_famcodes came from a single ward/booth query — compute stats directly from it
    universe_scope = None
    if scope_famcodes:
        sif  = sum(1 for v in scope_famcodes if v["party_support"] and v["famcode"])
        nsif = sum(1 for v in scope_famcodes if not v["party_support"] and v["famcode"])
        sug  = sum(1 for v in scope_famcodes if v["party_support"] and not v["famcode"])
        nsug = sum(1 for v in scope_famcodes if not v["party_support"] and not v["famcode"])
        total_fams = len(set(v["famcode"] for v in scope_famcodes if v["famcode"]))
        # Gender and age from the same projection query
        gm = sum(1 for v in scope_famcodes if v.get("gender") in ("M", "MALE"))
        gf = sum(1 for v in scope_famcodes if v.get("gender") in ("F", "FEMALE"))
        go = len(scope_famcodes) - gm - gf
        age_bkts = {"18_25": 0, "26_35": 0, "36_45": 0, "46_60": 0, "61_plus": 0}
        for v in scope_famcodes:
            try: a = int(v.get("age") or 0)
            except (ValueError, TypeError): a = 0
            if a < 18: continue
            if a <= 25: age_bkts["18_25"] += 1
            elif a <= 35: age_bkts["26_35"] += 1
            elif a <= 45: age_bkts["36_45"] += 1
            elif a <= 60: age_bkts["46_60"] += 1
            else: age_bkts["61_plus"] += 1
        # Streets and booths from the same projection data
        total_streets = len(set(
            v.get("section", "") for v in scope_famcodes if v.get("section", "")
        ))
        # Unique booth values exist only in ward-level scans (not single-booth scans)
        total_booths = len(set(
            v.get("booth", "") for v in scope_famcodes if v.get("booth", "")
        )) or (1 if (booth or booth == "") else 0)

        universe_scope = {
            "total_voters":       len(scope_famcodes),
            "surveyed_voters":    sif + sug,
            "total_families":     total_fams,
            "surveyed_in_family": sif,
            "not_surv_in_family": nsif,
            "surveyed_ungrouped": sug,
            "not_surv_ungrouped": nsug,
            "ungrouped_voters":   sug + nsug,
            "total_streets":      total_streets,
            "total_booths":       total_booths if not (ward and booth) else None,
            "gender":             {"M": gm, "F": gf, "O": go},
            "age_distribution": [
                {"bucket": "18-25", "count": age_bkts["18_25"]},
                {"bucket": "26-35", "count": age_bkts["26_35"]},
                {"bucket": "36-45", "count": age_bkts["36_45"]},
                {"bucket": "46-60", "count": age_bkts["46_60"]},
                {"bucket": "61+",   "count": age_bkts["61_plus"]},
            ],
        }

    return {
        "universe": universe,
        "universe_scope": universe_scope,
        "schemes": {
            "calling": {
                "total":        gt,
                "done":         grand_calling["called"],
                "didnt_answer": grand_calling["didnt_answer"],
                "skipped":      grand_calling["skipped"],
                "not_called":   gt - grand_calling["called"] - grand_calling["didnt_answer"] - grand_calling["skipped"],
                "pct":          round(grand_calling["called"] / gt * 100 if gt else 0, 1),
            },
            "notice": {
                "total":   nt,
                "done":    grand_notice["delivered"],
                "pending": nt - grand_notice["delivered"],
                "pct":     round(grand_notice["delivered"] / nt * 100 if nt else 0, 1),
                "enabled": notice_enabled,
            },
            "coupon": {
                "total":   ct,
                "done":    grand_coupon["delivered"],
                "pending": ct - grand_coupon["delivered"],
                "pct":     round(grand_coupon["delivered"] / ct * 100 if ct else 0, 1),
                "enabled": coupon_enabled,
            },
            "custom": [
                {
                    "id":      sc["id"],
                    "name":    sc["name"],
                    "total":   grand_custom[sc["id"]]["total"],
                    "done":    grand_custom[sc["id"]]["delivered"],
                    "pending": grand_custom[sc["id"]]["total"] - grand_custom[sc["id"]]["delivered"],
                    "pct":     round(grand_custom[sc["id"]]["delivered"] / grand_custom[sc["id"]]["total"] * 100
                                     if grand_custom[sc["id"]]["total"] else 0, 1),
                }
                for sc in custom_schemes
            ],
        },
        "wards":       ward_data,
        "daily_trend": trend_list,
        "workers":     workers[:20],
        "user_count":  user_count,
        "all_wards":   all_wards,
    }


@router.get("/drill")
async def get_drill(request: Request, ward: str, booth: str = ""):
    """Drill-down: ward→booths or ward+booth→streets, with calling+notice+coupon stats."""
    user = require_role(request, "superadmin", "ward", "booth")
    role = user.get("role", "superadmin")
    # Non-superadmin: override params with their assignment — never trust query params
    if role == "ward":
        ward = user.get("ward", "")    # force their ward
        # booth param left as-is (ward users can drill into any booth in their ward)
    elif role == "booth":
        ward  = user.get("ward", "")   # force their ward
        booth = user.get("booth", "")  # force their booth (street-level only)

    notice_enabled = storage.get_notice_enabled()
    coupon_enabled = storage.get_coupon_enabled()
    custom_schemes = storage.get_custom_schemes()

    if booth:
        # Street-level breakdown for a single booth
        voters, call_statuses = await asyncio.gather(
            asyncio.to_thread(storage.get_voters_by_booth, ward, booth),
            asyncio.to_thread(storage.get_all_call_statuses, ward, booth),
        )
        notice_statuses: dict = {}
        coupon_statuses: dict = {}
        if notice_enabled:
            notice_statuses = await asyncio.to_thread(storage.get_all_notice_statuses, ward, booth)
        if coupon_enabled:
            coupon_statuses = await asyncio.to_thread(storage.get_all_coupon_statuses, ward, booth)
        scheme_statuses: dict = {}
        if custom_schemes:
            scheme_status_results = await asyncio.gather(*[
                asyncio.to_thread(storage.get_all_scheme_statuses, ward, booth, sc["id"])
                for sc in custom_schemes
            ])
            scheme_statuses = {sc["id"]: sr for sc, sr in zip(custom_schemes, scheme_status_results)}

        calling_by_sec: dict = {}
        notice_by_sec: dict  = {}
        coupon_by_sec: dict  = {}
        scheme_by_sec: dict  = {sc["id"]: {} for sc in custom_schemes}
        section_ta_map: dict = {}  # section -> section_name_ta
        demo_by_sec: dict    = {}  # per-section demographics

        for v in voters:
            section = (v.get("section") or v.get("section_name") or "Unknown").strip()
            if section not in section_ta_map:
                section_ta_map[section] = (v.get("section_name_ta") or "").strip()
            vid     = v.get("voter_id") or v.get("RowKey", "")

            # Demographics: gender, age, surveyed, families — all voters
            if section not in demo_by_sec:
                demo_by_sec[section] = {
                    "all_voters": 0, "surveyed": 0,
                    "gm": 0, "gf": 0, "go": 0,
                    "age_18_25": 0, "age_26_35": 0, "age_36_45": 0,
                    "age_46_60": 0, "age_61_plus": 0,
                    "famcodes": set(),
                }
            d = demo_by_sec[section]
            d["all_voters"] += 1
            if (v.get("party_support") or "").strip():
                d["surveyed"] += 1
            gender = (v.get("gender") or "").upper()
            if gender in ("M", "MALE"):
                d["gm"] += 1
            elif gender in ("F", "FEMALE"):
                d["gf"] += 1
            else:
                d["go"] += 1
            try:
                age = int(v.get("age") or 0)
            except (ValueError, TypeError):
                age = 0
            if age >= 18:
                if age <= 25: d["age_18_25"] += 1
                elif age <= 35: d["age_26_35"] += 1
                elif age <= 45: d["age_36_45"] += 1
                elif age <= 60: d["age_46_60"] += 1
                else: d["age_61_plus"] += 1
            fc = (v.get("famcode") or "").strip()
            if fc:
                d["famcodes"].add(fc)

            # Notice counts all voters
            if section not in notice_by_sec:
                notice_by_sec[section] = {"total": 0, "delivered": 0}
            notice_by_sec[section]["total"] += 1
            if (notice_statuses.get(vid) or {}).get("status") == "delivered":
                notice_by_sec[section]["delivered"] += 1

            # Coupon counts all voters
            if section not in coupon_by_sec:
                coupon_by_sec[section] = {"total": 0, "delivered": 0}
            coupon_by_sec[section]["total"] += 1
            if (coupon_statuses.get(vid) or {}).get("status") == "delivered":
                coupon_by_sec[section]["delivered"] += 1

            # Custom schemes count all voters
            for sc in custom_schemes:
                sc_id = sc["id"]
                if section not in scheme_by_sec[sc_id]:
                    scheme_by_sec[sc_id][section] = {"total": 0, "delivered": 0}
                scheme_by_sec[sc_id][section]["total"] += 1
                if (scheme_statuses.get(sc_id, {}).get(vid) or {}).get("status") == "delivered":
                    scheme_by_sec[sc_id][section]["delivered"] += 1

            # Calling counts only seg_synced voters
            if v.get("seg_synced") != "true":
                continue
            if section not in calling_by_sec:
                calling_by_sec[section] = {"total": 0, "called": 0, "didnt_answer": 0, "skipped": 0}
            calling_by_sec[section]["total"] += 1
            cs = (call_statuses.get(vid) or {}).get("status", "")
            if cs == "called":
                calling_by_sec[section]["called"] += 1
            elif cs == "didnt_answer":
                calling_by_sec[section]["didnt_answer"] += 1
            elif cs == "skipped":
                calling_by_sec[section]["skipped"] += 1

        all_secs = sorted(set(calling_by_sec) | set(notice_by_sec) | set(coupon_by_sec) | set(demo_by_sec))
        street_data = []
        for s in all_secs:
            c = calling_by_sec.get(s, {"total": 0, "called": 0, "didnt_answer": 0, "skipped": 0})
            n = notice_by_sec.get(s, {"total": 0, "delivered": 0})
            cp = coupon_by_sec.get(s, {"total": 0, "delivered": 0})
            d = demo_by_sec.get(s, {"all_voters": 0, "surveyed": 0, "gm": 0, "gf": 0, "go": 0,
                                     "age_18_25": 0, "age_26_35": 0, "age_36_45": 0,
                                     "age_46_60": 0, "age_61_plus": 0, "famcodes": set()})
            c["not_called"] = c["total"] - c["called"] - c["didnt_answer"] - c["skipped"]
            c["completion_pct"] = round(c["called"] / c["total"] * 100 if c["total"] else 0, 1)
            item = {
                "section":          s,
                "section_ta":       section_ta_map.get(s, ""),
                **c,
                "notice_total":     n["total"],
                "notice_delivered": n["delivered"],
                "coupon_total":     cp["total"],
                "coupon_delivered": cp["delivered"],
                # Demographics
                "all_voters":       d["all_voters"],
                "surveyed":         d["surveyed"],
                "families":         len(d["famcodes"]),
                "gender_m":         d["gm"],
                "gender_f":         d["gf"],
                "gender_o":         d["go"],
                "age_18_25":        d["age_18_25"],
                "age_26_35":        d["age_26_35"],
                "age_36_45":        d["age_36_45"],
                "age_46_60":        d["age_46_60"],
                "age_61_plus":      d["age_61_plus"],
            }
            for sc in custom_schemes:
                sc_sec = scheme_by_sec[sc["id"]].get(s, {"total": 0, "delivered": 0})
                item[f"scheme_{sc['id']}_total"]     = sc_sec["total"]
                item[f"scheme_{sc['id']}_delivered"] = sc_sec["delivered"]
            street_data.append(item)

        return {"level": "street", "ward": ward, "booth": booth, "items": street_data,
                "custom_schemes": [{"id": sc["id"], "name": sc["name"]} for sc in custom_schemes]}

    else:
        # Booth-level breakdown for a ward
        booths = storage.get_booths_for_ward(ward)
        bi_map = storage.get_booth_info_map(ward)

        async def fetch_booth_drill(b: str):
            calling = await asyncio.to_thread(storage.get_call_stats, ward, b)
            notice  = (await asyncio.to_thread(storage.get_notice_stats, ward, b)
                       if notice_enabled else {"total": 0, "delivered": 0})
            coupon  = (await asyncio.to_thread(storage.get_coupon_stats, ward, b)
                       if coupon_enabled else {"total": 0, "delivered": 0})
            scheme_stats = {}
            if custom_schemes:
                scheme_results = await asyncio.gather(*[
                    asyncio.to_thread(storage.get_scheme_stats, ward, b, sc["id"])
                    for sc in custom_schemes
                ])
                scheme_stats = {sc["id"]: sr for sc, sr in zip(custom_schemes, scheme_results)}
            return b, calling, notice, coupon, scheme_stats

        results = await asyncio.gather(*[fetch_booth_drill(b) for b in booths])
        booth_data = []
        for b, calling, notice, coupon, scheme_stats in results:
            info = bi_map.get(b, {})
            item = {
                "booth":            b,
                "booth_number":     info.get("booth_number", ""),
                "booth_name":       info.get("booth_name", ""),
                **calling,
                "notice_total":     notice["total"],
                "notice_delivered": notice["delivered"],
                "coupon_total":     coupon["total"],
                "coupon_delivered": coupon["delivered"],
            }
            for sc_id, sc_stats in scheme_stats.items():
                item[f"scheme_{sc_id}_total"]     = sc_stats["total"]
                item[f"scheme_{sc_id}_delivered"] = sc_stats["delivered"]
            booth_data.append(item)

        return {"level": "booth", "ward": ward, "items": booth_data,
                "custom_schemes": [{"id": sc["id"], "name": sc["name"]} for sc in custom_schemes]}


# ── Shared coroutine helper ───────────────────────────────────────────────────
async def _empty() -> dict:
    return {}


@router.get("/family-stats")
async def get_family_stats(
    request: Request,
    ward:  Optional[str] = None,
    booth: Optional[str] = None,
):
    """Family-level completion stats for Notice and Coupon (Telecalling excluded).

    ward + booth optional — when omitted computes global stats across all wards.

    Returns:
        schemes.notice / coupon — family totals + done counts
        items — per-booth (ward scope) or per-street (booth scope) family breakdown
    """
    require_role(request, "superadmin")
    notice_enabled = storage.get_notice_enabled()
    coupon_enabled = storage.get_coupon_enabled()

    if booth and ward:
        # ── Booth scope → 1 booth query + statuses → street breakdown ─────
        level = "booth"
        voter_meta, notice_st, coupon_st = await asyncio.gather(
            asyncio.to_thread(storage.get_voter_famcodes_for_booth, ward, booth),
            asyncio.to_thread(storage.get_all_notice_statuses, ward, booth) if notice_enabled else _empty(),
            asyncio.to_thread(storage.get_all_coupon_statuses, ward, booth) if coupon_enabled else _empty(),
        )
        sec_agg: dict = {}
        for v in voter_meta:
            fc = v["famcode"]; sec = v["section"] or "Unknown"; vid = v["voter_id"]
            if not fc: continue
            if sec not in sec_agg:
                sec_agg[sec] = {"nft": set(), "nfd": set(), "cft": set(), "cfd": set()}
            agg = sec_agg[sec]
            agg["nft"].add(fc); agg["cft"].add(fc)
            if (notice_st.get(vid) or {}).get("status") == "delivered": agg["nfd"].add(fc)
            if (coupon_st.get(vid) or {}).get("status") == "delivered": agg["cfd"].add(fc)

        all_nft: set = set(); all_nfd: set = set()
        all_cft: set = set(); all_cfd: set = set()
        items = []
        for sec in sorted(sec_agg):
            agg = sec_agg[sec]
            items.append({
                "section":          sec,
                "notice_fam_total": len(agg["nft"]),
                "notice_fam_done":  len(agg["nfd"]),
                "coupon_fam_total": len(agg["cft"]),
                "coupon_fam_done":  len(agg["cfd"]),
            })
            all_nft |= agg["nft"]; all_nfd |= agg["nfd"]
            all_cft |= agg["cft"]; all_cfd |= agg["cfd"]

    else:
        # ── Ward/global: 1 range scan per ward + N per-booth status queries ─
        # Ward   → 1 famcode scan + N status queries → booth-level items
        # Global → W famcode scans + N status queries → ward-level items  (W << N)
        level = "ward"
        target_wards = [ward] if ward else storage.get_all_wards()

        async def _ward_family(w: str):
            """1 ward range scan for famcodes + N booth status queries, all parallel."""
            booths = storage.get_booths_for_ward(w)
            # Build coroutines: first is the ward scan, rest are per-booth statuses
            status_coros = (
                [asyncio.to_thread(storage.get_all_notice_statuses, w, b) for b in booths]
                + [asyncio.to_thread(storage.get_all_coupon_statuses, w, b) for b in booths]
            ) if (notice_enabled and coupon_enabled) else (
                [asyncio.to_thread(storage.get_all_notice_statuses, w, b) for b in booths]
                if notice_enabled else
                [asyncio.to_thread(storage.get_all_coupon_statuses, w, b) for b in booths]
                if coupon_enabled else []
            )
            all_results = await asyncio.gather(
                asyncio.to_thread(storage.get_voter_famcodes_for_ward, w),
                *status_coros,
            )
            voter_meta  = all_results[0]
            status_rest = all_results[1:]

            nb = len(booths)
            # Merge per-booth status dicts into combined lookup {voter_id: status_dict}
            notice_all: dict = {}
            coupon_all: dict = {}
            if notice_enabled and coupon_enabled:
                for d in status_rest[:nb]: notice_all.update(d)
                for d in status_rest[nb:]: coupon_all.update(d)
            elif notice_enabled:
                for d in status_rest: notice_all.update(d)
            elif coupon_enabled:
                for d in status_rest: coupon_all.update(d)

            # Group voter famcodes by booth (booth field is included in ward scan)
            bi_map       = storage.get_booth_info_map(w)
            booth_agg: dict = {b: {"nft": set(), "nfd": set(), "cft": set(), "cfd": set()}
                               for b in booths}
            w_nft: set = set(); w_nfd: set = set()
            w_cft: set = set(); w_cfd: set = set()

            for v in voter_meta:
                fc = v["famcode"]; vid = v["voter_id"]; b = v.get("booth", "")
                if not fc: continue
                agg = booth_agg.get(b)
                if agg:
                    agg["nft"].add(fc); agg["cft"].add(fc)
                    if (notice_all.get(vid) or {}).get("status") == "delivered": agg["nfd"].add(fc)
                    if (coupon_all.get(vid) or {}).get("status") == "delivered": agg["cfd"].add(fc)
                w_nft.add(fc); w_cft.add(fc)
                if (notice_all.get(vid) or {}).get("status") == "delivered": w_nfd.add(fc)
                if (coupon_all.get(vid) or {}).get("status") == "delivered": w_cfd.add(fc)

            booth_items = []
            for b in booths:
                agg  = booth_agg[b]
                info = bi_map.get(b, {})
                booth_items.append({
                    "booth":            b,
                    "booth_number":     info.get("booth_number", ""),
                    "booth_name":       info.get("booth_name", ""),
                    "notice_fam_total": len(agg["nft"]),
                    "notice_fam_done":  len(agg["nfd"]),
                    "coupon_fam_total": len(agg["cft"]),
                    "coupon_fam_done":  len(agg["cfd"]),
                })

            return w, w_nft, w_nfd, w_cft, w_cfd, booth_items

        ward_results_raw = await asyncio.gather(*[_ward_family(w) for w in target_wards])

        all_nft: set = set(); all_nfd: set = set()
        all_cft: set = set(); all_cfd: set = set()
        items = []

        if ward:
            # Single ward → expose booth-level items for geo chart
            _, w_nft, w_nfd, w_cft, w_cfd, booth_items = ward_results_raw[0]
            all_nft |= w_nft; all_nfd |= w_nfd; all_cft |= w_cft; all_cfd |= w_cfd
            items = booth_items
        else:
            # Global → ward-level items
            for w, w_nft, w_nfd, w_cft, w_cfd, _ in ward_results_raw:
                items.append({
                    "ward": w,
                    "notice_fam_total": len(w_nft), "notice_fam_done": len(w_nfd),
                    "coupon_fam_total": len(w_cft), "coupon_fam_done": len(w_cfd),
                })
                all_nft |= w_nft; all_nfd |= w_nfd; all_cft |= w_cft; all_cfd |= w_cfd

    nt = len(all_nft); nd = len(all_nfd)
    ct = len(all_cft); cd = len(all_cfd)
    return {
        "level":  level,
        "ward":   ward or "",
        "booth":  booth or "",
        "schemes": {
            "notice": {
                "total":   nt, "done": nd, "pending": nt - nd,
                "pct":     round(nd / nt * 100 if nt else 0, 1),
                "enabled": notice_enabled,
            },
            "coupon": {
                "total":   ct, "done": cd, "pending": ct - cd,
                "pct":     round(cd / ct * 100 if ct else 0, 1),
                "enabled": coupon_enabled,
            },
        },
        "items": items,
    }
