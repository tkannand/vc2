"""
Emergency script to restore a superadmin account directly in Azure Table Storage.
Run from the project root (where .env lives):

    python restore_admin.py
    python restore_admin.py 8903429890 "Your Name"
"""
import sys
import os

# Make sure imports resolve from project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.config import settings
from backend import storage

def main():
    if len(sys.argv) == 3:
        phone = sys.argv[1].strip()
        name  = sys.argv[2].strip()
    else:
        print("=== Superadmin Restore ===")
        phone = input(f"Phone [{settings.INITIAL_SUPERADMIN_PHONE}]: ").strip()
        if not phone:
            phone = settings.INITIAL_SUPERADMIN_PHONE
        name = input(f"Name [{settings.INITIAL_SUPERADMIN_NAME}]: ").strip()
        if not name:
            name = settings.INITIAL_SUPERADMIN_NAME

    if not phone.isdigit() or len(phone) != 10:
        print("ERROR: Phone must be exactly 10 digits")
        sys.exit(1)

    existing = storage.get_user_roles(phone)
    already  = [u["PartitionKey"] for u in existing]

    if "superadmin" in already:
        print(f"OK: {phone[-4:]} already has a superadmin role — nothing to do.")
        return

    storage.upsert_user(phone=phone, name=name, role="superadmin", ward="", booth="")
    print(f"Done: superadmin entry created for ...{phone[-4:]} ({name})")
    print("You can now log in and set your PIN via the app.")

if __name__ == "__main__":
    main()
