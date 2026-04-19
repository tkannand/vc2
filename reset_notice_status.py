"""One-off script to delete ALL entities from the NoticeStatus table,
resetting notice delivery counts to zero across all wards and booths."""

import os
import time
from collections import defaultdict
from dotenv import load_dotenv
from azure.data.tables import TableServiceClient

load_dotenv()

CONN_STR = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
PREFIX = os.getenv("TABLE_PREFIX", "VC2029")
TABLE = f"{PREFIX}NoticeStatus"

def main():
    print(f"Connecting to table: {TABLE}")
    svc = TableServiceClient.from_connection_string(CONN_STR)
    table = svc.get_table_client(TABLE)

    # Step 1: Load all entities (only need PK + RK for deletion)
    print("Querying all NoticeStatus entities...")
    entities = []
    for e in table.query_entities("", select=["PartitionKey", "RowKey"]):
        entities.append((e["PartitionKey"], e["RowKey"]))

    total = len(entities)
    print(f"Found {total} entities to delete.")

    if total == 0:
        print("Nothing to delete. Table is already empty.")
        return

    # Step 2: Group by PartitionKey (Azure transactions require same PK)
    partitions = defaultdict(list)
    for pk, rk in entities:
        partitions[pk].append(rk)

    # Step 3: Delete in batches of 100 per partition
    deleted = 0
    start = time.time()

    for pk, row_keys in partitions.items():
        for i in range(0, len(row_keys), 100):
            chunk = row_keys[i : i + 100]
            ops = [("delete", {"PartitionKey": pk, "RowKey": rk}) for rk in chunk]
            try:
                table.submit_transaction(ops)
                deleted += len(chunk)
                print(f"  Deleted {deleted}/{total} (partition: {pk[:30]}...)")
            except Exception as exc:
                print(f"  Batch failed for {pk}: {exc}")
                # Fallback: delete one by one
                for rk in chunk:
                    try:
                        table.delete_entity(pk, rk)
                        deleted += 1
                    except Exception:
                        pass

    elapsed = time.time() - start
    print(f"\nDone. Deleted {deleted}/{total} entities in {elapsed:.1f}s.")


if __name__ == "__main__":
    main()
