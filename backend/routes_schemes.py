import asyncio
import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import List
from backend.middleware import require_role, require_booth_access, require_ward_access
from backend import storage

logger = structlog.get_logger()
router = APIRouter(prefix="/api/schemes", tags=["schemes"])


# ── Models ─────────────────────────────────────────────────────────────────

class CreateSchemeRequest(BaseModel):
    name: str
    type: str   # "individual" | "family"


class UpdateSchemeRequest(BaseModel):
    name: str
    type: str   # "individual" | "family"


class SchemeToggleRequest(BaseModel):
    enabled: bool


class SchemeDeliverRequest(BaseModel):
    voter_ids: List[str]


# ── Helpers ────────────────────────────────────────────────────────────────

def _user_name(user: dict) -> str:
    name = user.get("name", "")
    if not name:
        rec = storage.get_user(user["phone"])
        name = rec.get("name", "") if rec else ""
    return name


def _build_scheme_families(voters: list, custom_families: list,
                           scheme_statuses: dict, booth: str,
                           ejected_ids: set = None, cross_claimed_ids: set = None) -> list:
    """
    Build family list identical to coupon families but with 'scheme_status'
    field instead of 'coupon_status'. Reuses coupon family groupings so that
    family management (create/edit/group) is universal across all schemes.
    """
    from backend.routes_coupon import _build_coupon_families, sanitize_coupon_voter

    # _build_coupon_families expects status dict keyed by voter_id with 'status' field
    families = _build_coupon_families(
        voters, custom_families, scheme_statuses, booth,
        ejected_ids=ejected_ids, cross_claimed_ids=cross_claimed_ids,
    )

    # Rename coupon_status → scheme_status in every member
    for fam in families:
        for m in fam.get("members", []):
            m["scheme_status"] = m.pop("coupon_status", "not_delivered")

    return families


def _get_booth_families(ward: str, booth: str, scheme_id: str) -> list:
    voters         = storage.get_voters_by_booth(ward, booth)
    custom_fams    = storage.get_coupon_families(ward, booth)
    statuses       = storage.get_all_scheme_statuses(ward, booth, scheme_id)
    ejected        = storage.get_ejected_coupon_voters(ward, booth)
    cross_claimed  = storage.get_cross_claimed_voters(ward, booth)
    return _build_scheme_families(voters, custom_fams, statuses, booth,
                                  ejected_ids=ejected, cross_claimed_ids=cross_claimed)


# ── GET /api/schemes  (public — used by all roles) ─────────────────────────

@router.get("")
async def get_schemes(request: Request):
    """Return all enabled schemes: built-in (notice, coupon) + any custom ones."""
    schemes = []
    if storage.get_notice_enabled():
        schemes.append({"id": "notice", "name": "Notice", "type": "individual"})
    if storage.get_coupon_enabled():
        schemes.append({"id": "coupon", "name": "Coupon", "type": "family"})
    schemes.extend(storage.get_custom_schemes())
    return {"schemes": schemes}


# ── POST /api/schemes  (superadmin only) ───────────────────────────────────

@router.post("")
async def create_scheme(request: Request, body: CreateSchemeRequest):
    """Create a new custom scheme. Schemes cannot be deleted — inform the caller."""
    require_role(request, "superadmin")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scheme name is required")
    if body.type not in ("individual", "family"):
        raise HTTPException(status_code=400, detail="type must be 'individual' or 'family'")

    user = request.state.user
    scheme_id = storage.create_custom_scheme(name, body.type, user["phone"])
    logger.info("custom_scheme_created", scheme_id=scheme_id, name=name, by=user["phone"][-4:])
    return {
        "success": True,
        "scheme": {"id": scheme_id, "name": name, "type": body.type},
        "warning": "Schemes cannot be deleted once created.",
    }


# ── Admin: list all schemes (including disabled) ──────────────────────────

@router.get("/admin/all")
async def get_all_schemes_admin(request: Request):
    """Return all custom schemes (enabled + disabled) for admin management."""
    require_role(request, "superadmin")
    return {"schemes": storage.get_all_custom_schemes_for_settings()}


# ── Update custom scheme name / type (superadmin) ─────────────────────────

@router.put("/{scheme_id}")
async def update_scheme(request: Request, scheme_id: str, body: UpdateSchemeRequest):
    require_role(request, "superadmin")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scheme name is required")
    if body.type not in ("individual", "family"):
        raise HTTPException(status_code=400, detail="type must be 'individual' or 'family'")
    user = request.state.user
    storage.update_custom_scheme(scheme_id, name, body.type, user["phone"])
    logger.info("custom_scheme_updated", scheme_id=scheme_id, name=name, by=user["phone"][-4:])
    return {"success": True}


# ── Delete custom scheme (superadmin) ─────────────────────────────────────

@router.delete("/{scheme_id}")
async def delete_scheme(request: Request, scheme_id: str):
    require_role(request, "superadmin")
    storage.delete_custom_scheme(scheme_id)
    user = request.state.user
    logger.info("custom_scheme_deleted", scheme_id=scheme_id, by=user["phone"][-4:])
    return {"success": True}


# ── Toggle custom scheme (superadmin) ─────────────────────────────────────

@router.post("/{scheme_id}/toggle")
async def toggle_custom_scheme(request: Request, scheme_id: str, body: SchemeToggleRequest):
    """Enable or disable a custom scheme. Schemes cannot be deleted, only toggled."""
    user = require_role(request, "superadmin")
    storage.set_custom_scheme_enabled(scheme_id, body.enabled, user["phone"])
    logger.info("custom_scheme_toggled", scheme_id=scheme_id, enabled=body.enabled, by=user["phone"][-4:])
    return {"success": True, "enabled": body.enabled}


# ── Booth-level: families ─────────────────────────────────────────────────

@router.get("/{scheme_id}/families")
async def get_scheme_booth_families(request: Request, scheme_id: str, ward: str, booth: str):
    require_booth_access(request, ward, booth)
    families = _get_booth_families(ward, booth, scheme_id)
    return {"families": families}


# ── Booth-level: deliver / undeliver ──────────────────────────────────────

@router.post("/{scheme_id}/deliver")
async def scheme_deliver(request: Request, scheme_id: str,
                         body: SchemeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_scheme_status(ward, booth, scheme_id, vid,
                                     "delivered", user["phone"], name)
    return {"success": True}


@router.post("/{scheme_id}/undeliver")
async def scheme_undeliver(request: Request, scheme_id: str,
                           body: SchemeDeliverRequest, ward: str, booth: str):
    user = require_booth_access(request, ward, booth)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_scheme_status(ward, booth, scheme_id, vid,
                                     "not_delivered", user["phone"], name)
    return {"success": True}


# ── Ward-level: all families across booths ─────────────────────────────────

@router.get("/{scheme_id}/ward/families")
async def get_scheme_ward_families(request: Request, scheme_id: str, ward: str):
    require_ward_access(request, ward)
    booths = storage.get_booths_for_ward(ward)

    async def load_booth(booth: str):
        return await asyncio.to_thread(_get_booth_families, ward, booth, scheme_id)

    results = await asyncio.gather(*[load_booth(b) for b in booths])
    all_families = [fam for booth_fams in results for fam in booth_fams]
    return {"families": all_families}


# ── Ward-level: deliver / undeliver ───────────────────────────────────────

@router.post("/{scheme_id}/ward/deliver")
async def scheme_ward_deliver(request: Request, scheme_id: str,
                              body: SchemeDeliverRequest, ward: str, booth: str):
    user = require_ward_access(request, ward)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_scheme_status(ward, booth, scheme_id, vid,
                                     "delivered", user["phone"], name)
    return {"success": True}


@router.post("/{scheme_id}/ward/undeliver")
async def scheme_ward_undeliver(request: Request, scheme_id: str,
                                body: SchemeDeliverRequest, ward: str, booth: str):
    user = require_ward_access(request, ward)
    name = _user_name(user)
    for vid in body.voter_ids:
        storage.upsert_scheme_status(ward, booth, scheme_id, vid,
                                     "not_delivered", user["phone"], name)
    return {"success": True}
