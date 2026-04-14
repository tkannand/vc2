"""Delete all cache/sync flags from Settings table so the app does a full re-sync.

Run: python reset_settings.py
"""
import os
from dotenv import load_dotenv
from azure.data.tables import TableServiceClient
from azure.core.exceptions import ResourceNotFoundError

load_dotenv()

CONN = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
PREFIX = os.getenv("TABLE_PREFIX", "VC2029")
TABLE = f"{PREFIX}Settings"

print(f"Using table: {TABLE}")

svc = TableServiceClient.from_connection_string(CONN)
table = svc.get_table_client(TABLE)

# Prefixes/keys that are cache or sync flags — safe to delete
CACHE_PREFIXES = (
    "cached_wards", "cached_booths_", "cached_seg_",
    "voter_count_", "seg_count_", "stats_universe",
    "voter_data_loaded", "booth_meta_stored",
)

deleted = 0
for entity in table.list_entities():
    pk = entity.get("PartitionKey", "")
    rk = entity.get("RowKey", "")

    # Delete booth_meta_ partitions (old booth metadata)
    if pk.startswith("booth_meta_"):
        table.delete_entity(pk, rk)
        deleted += 1
        continue

    # Delete cache/flag rows from the settings partition
    if pk == "settings":
        for prefix in CACHE_PREFIXES:
            if rk.startswith(prefix):
                table.delete_entity(pk, rk)
                deleted += 1
                print(f"  Deleted: {rk}")
                break

print(f"\nTotal deleted: {deleted}")
print(f"Done. Now delete the {PREFIX}Voters table from Azure Portal, then restart the app.")
