"""
Script to import/update booth workers from 'Userphone.xlsx' into Azure Table Storage.

Usage:
    python bulk_import_users.py

- Reads all rows from the Excel file
- New phone numbers are added as role 'booth'
- Existing phone numbers get their ward and booth updated
- Prints a summary at the end
"""

import os
import sys

import openpyxl

# Add project root to path so we can import backend modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.storage import upsert_user, get_user


def clean_phone(raw_phone: str) -> str:
    """Strip +91 prefix and whitespace to get 10-digit phone."""
    phone = raw_phone.strip().replace(" ", "")
    if phone.startswith("+91"):
        phone = phone[3:]
    elif phone.startswith("91") and len(phone) == 12:
        phone = phone[2:]
    return phone


def main():
    excel_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Userphone.xlsx")
    if not os.path.exists(excel_path):
        print(f"ERROR: Excel file not found at {excel_path}")
        sys.exit(1)

    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = wb["Sheet1"]

    # Columns: A=Booth, B=Phone, C=Ward, D=Name, E=Ward, F=Booth
    rows = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue  # skip header
        raw_phone = str(row[1]).strip() if row[1] else ""
        name = str(row[3]).strip() if row[3] else ""
        ward = str(row[4]).strip() if row[4] else ""
        booth = str(row[5]).strip() if row[5] else ""

        if not raw_phone or not name:
            print(f"  SKIP row {i+1}: missing phone or name")
            continue

        phone = clean_phone(raw_phone)
        if len(phone) != 10 or not phone.isdigit():
            print(f"  SKIP row {i+1}: invalid phone '{raw_phone}' -> '{phone}'")
            continue

        rows.append({"phone": phone, "name": name, "ward": ward, "booth": booth})

    wb.close()

    print(f"Total valid rows parsed: {len(rows)}")
    print()

    added = 0
    updated = 0
    errors = 0

    for r in rows:
        try:
            existing = get_user(r["phone"])
            upsert_user(
                phone=r["phone"],
                name=r["name"],
                role="booth",
                ward=r["ward"],
                booth=r["booth"],
            )
            if existing:
                updated += 1
                print(f"  UPDATED: {r['name']} ({r['phone']}) -> {r['ward']}, {r['booth']}")
            else:
                added += 1
                print(f"  ADDED:   {r['name']} ({r['phone']}) -> {r['ward']}, {r['booth']}")
        except Exception as e:
            print(f"  ERROR:   {r['name']} ({r['phone']}) - {e}")
            errors += 1

    print()
    print(f"Done. Added: {added}, Updated: {updated}, Errors: {errors}")


if __name__ == "__main__":
    main()
