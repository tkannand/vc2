"""
One-time script to bulk import booth workers from 'app access.xlsx' into Azure Table Storage.

Usage:
    python bulk_import_users.py

- Reads all rows from the Excel file
- Strips +91 prefix from phone numbers
- Adds each user as role 'booth' with their ward and booth
- Skips the duplicate phone (8056762435)
- Prints a summary at the end
"""

import os
import sys
from collections import Counter

import openpyxl

# Add project root to path so we can import backend modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.storage import upsert_user

SKIP_PHONES = {"8056762435"}  # duplicate phone - skip both rows


def clean_phone(raw_phone: str) -> str:
    """Strip +91 prefix and whitespace to get 10-digit phone."""
    phone = raw_phone.strip().replace(" ", "")
    if phone.startswith("+91"):
        phone = phone[3:]
    elif phone.startswith("91") and len(phone) == 12:
        phone = phone[2:]
    return phone


def main():
    excel_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app access.xlsx")
    if not os.path.exists(excel_path):
        print(f"ERROR: Excel file not found at {excel_path}")
        sys.exit(1)

    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = wb["Sheet1"]

    rows = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue  # skip header
        name = str(row[1]).strip() if row[1] else ""
        raw_phone = str(row[2]).strip() if row[2] else ""
        ward = str(row[5]).strip() if row[5] else ""
        booth = str(row[6]).strip() if row[6] else ""

        if not raw_phone or not name:
            continue

        phone = clean_phone(raw_phone)
        if len(phone) != 10 or not phone.isdigit():
            print(f"  SKIP row {i+1}: invalid phone '{raw_phone}' -> '{phone}'")
            continue

        rows.append({"phone": phone, "name": name, "ward": ward, "booth": booth})

    wb.close()

    # Check for duplicates
    phone_counts = Counter(r["phone"] for r in rows)
    duplicates = {p for p, c in phone_counts.items() if c > 1}
    skip_all = SKIP_PHONES | duplicates

    print(f"Total rows parsed: {len(rows)}")
    print(f"Phones to skip (duplicates): {skip_all if skip_all else 'none'}")
    print()

    added = 0
    skipped = 0

    for r in rows:
        if r["phone"] in skip_all:
            print(f"  SKIP: {r['name']} ({r['phone']}) - duplicate phone")
            skipped += 1
            continue

        try:
            upsert_user(
                phone=r["phone"],
                name=r["name"],
                role="booth",
                ward=r["ward"],
                booth=r["booth"],
            )
            added += 1
            print(f"  ADDED: {r['name']} ({r['phone']}) -> {r['ward']}, {r['booth']}")
        except Exception as e:
            print(f"  ERROR: {r['name']} ({r['phone']}) - {e}")
            skipped += 1

    print()
    print(f"Done. Added: {added}, Skipped: {skipped}")


if __name__ == "__main__":
    main()
