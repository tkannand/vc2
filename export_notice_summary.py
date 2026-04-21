"""
Export notice distribution summary by street as CSV.

Columns: ward, booth, street, total_voters, notice_delivered

Usage:
    python export_notice_summary.py
    python export_notice_summary.py --ward 24
"""

import csv
import sys
import asyncio
from collections import defaultdict
from backend import storage


def export(ward_filter: str = ""):
    wards = storage.get_all_wards()
    if ward_filter:
        wards = [w for w in wards if w == ward_filter]

    if not wards:
        print(f"No wards found{' matching ' + ward_filter if ward_filter else ''}.")
        return

    rows = []

    for ward in sorted(wards):
        booths = storage.get_booths_for_ward(ward)
        print(f"Ward {ward}: {len(booths)} booths")

        for booth in sorted(booths):
            voters = storage.get_voters_by_booth(ward, booth)
            statuses = storage.get_all_notice_statuses(ward, booth)

            # Group by street
            street_stats = defaultdict(lambda: {"total": 0, "delivered": 0})

            for v in voters:
                street = storage.street_key(v) or "(No Street)"
                vid = v.get("RowKey", "")
                street_stats[street]["total"] += 1

                status_rec = statuses.get(vid, {})
                if status_rec.get("status") == "delivered":
                    street_stats[street]["delivered"] += 1

            for street in sorted(street_stats.keys()):
                s = street_stats[street]
                rows.append({
                    "ward": ward,
                    "booth": booth,
                    "street": street,
                    "total_voters": s["total"],
                    "notice_delivered": s["delivered"],
                })

    filename = f"notice_summary_ward_{ward_filter}.csv" if ward_filter else "notice_summary.csv"
    with open(filename, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["ward", "booth", "street", "total_voters", "notice_delivered"])
        writer.writeheader()
        writer.writerows(rows)

    total_voters = sum(r["total_voters"] for r in rows)
    total_delivered = sum(r["notice_delivered"] for r in rows)
    print(f"\nExported {len(rows)} rows to {filename}")
    print(f"Total voters: {total_voters}, Notice delivered: {total_delivered}")


if __name__ == "__main__":
    ward = ""
    for i, arg in enumerate(sys.argv):
        if arg == "--ward" and i + 1 < len(sys.argv):
            ward = sys.argv[i + 1]
    export(ward)
