"""
Diagnose broken coupon families.

Scans all wards/booths for natural-family override rows in CouponFamilies
(rows where famcode is NOT CPN_ prefix). Reports which ones have voters
that were removed from the family but whose famcode was never cleared
(the bug — they show up as ghost duplicate families).

Usage:
    python diagnose_families.py            # dry run — report only
    python diagnose_families.py --fix      # fix: clear famcode for affected voters
                                           #       and delete the stale override rows
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

load_dotenv()

# Import storage after dotenv so connection string is available
sys.path.insert(0, os.path.dirname(__file__))
from backend import storage

storage.init_tables()


def run(fix: bool = False):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=5)
    print(f"Only checking overrides created after: {cutoff.isoformat()}")
    print()

    wards = storage.get_all_wards()
    total_natural_overrides = 0
    total_broken_voters = 0
    total_ejected_voters = 0
    fixed_voters = 0
    deleted_overrides = 0

    for ward in wards:
        booths = storage.get_booths_for_ward(ward)
        for booth in booths:
            custom_families = storage.get_coupon_families(ward, booth)
            ejected_ids = storage.get_ejected_coupon_voters(ward, booth)

            # Only natural overrides created in the last 5 hours
            nat_overrides = []
            for cf in custom_families:
                if cf["famcode"].startswith("CPN_"):
                    continue
                if cf["famcode"] in ("__ejected__", "__cross_claimed__"):
                    continue
                created = cf.get("created_at", "")
                if created:
                    try:
                        ts = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        if ts < cutoff:
                            continue
                    except ValueError:
                        pass
                nat_overrides.append(cf)

            if not nat_overrides and not ejected_ids:
                continue

            voters = storage.get_voters_by_booth(ward, booth)
            voter_by_fam = {}
            for v in voters:
                fc = v.get("famcode", "")
                if fc:
                    voter_by_fam.setdefault(fc, set()).add(v.get("RowKey", ""))

            for cf in nat_overrides:
                fc = cf["famcode"]
                total_natural_overrides += 1
                override_ids = set(cf["voter_ids"])
                natural_ids = voter_by_fam.get(fc, set())
                removed = natural_ids - override_ids

                # Voters removed from override but still have the same famcode = broken
                if removed:
                    total_broken_voters += len(removed)
                    print(f"  Ward={ward} Booth={booth} Famcode={fc}")
                    print(f"    Natural: {len(natural_ids)} members, Override: {len(override_ids)} members")
                    print(f"    Broken voters (removed but famcode not cleared): {sorted(removed)}")

                    if fix:
                        for vid in removed:
                            storage.clear_voter_famcode(ward, booth, vid)
                            fixed_voters += 1
                        print(f"    FIXED: cleared famcode for {len(removed)} voters")

                        # If the override has the same members as natural, it's redundant — delete it
                        if override_ids == (natural_ids - removed):
                            storage.delete_coupon_family(ward, booth, fc)
                            deleted_overrides += 1
                            print(f"    FIXED: deleted redundant override row")

            if ejected_ids:
                total_ejected_voters += len(ejected_ids)
                print(f"  Ward={ward} Booth={booth} has {len(ejected_ids)} ejected voters: {sorted(ejected_ids)}")

    print()
    print("=" * 60)
    print(f"Natural family overrides found:  {total_natural_overrides}")
    print(f"Broken voters (ghost dupes):     {total_broken_voters}")
    print(f"Ejected voters (stale list):     {total_ejected_voters}")
    if fix:
        print(f"Voters fixed (famcode cleared):  {fixed_voters}")
        print(f"Redundant overrides deleted:     {deleted_overrides}")
    else:
        if total_broken_voters or total_ejected_voters:
            print()
            print("Run with --fix to clean up:")
            print("  python diagnose_families.py --fix")


if __name__ == "__main__":
    do_fix = "--fix" in sys.argv
    if do_fix:
        print("MODE: FIX (will clear famcodes and delete stale rows)")
    else:
        print("MODE: DRY RUN (report only)")
    print("=" * 60)
    run(fix=do_fix)
