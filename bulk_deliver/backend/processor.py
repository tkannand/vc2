import asyncio
import time
import structlog
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncGenerator
from bulk_deliver.backend import storage

logger = structlog.get_logger()

BATCH_SIZE = 100
MAX_WORKERS = 10
MAX_RETRIES = 5
RETRY_PAUSE_SECONDS = 60


async def process_deliveries(
    voters: list[dict],
    scheme_type: str,
    scheme_id: str,
    scheme_name: str,
    operator_name: str,
    batch_id: str,
    source_filename: str,
) -> AsyncGenerator[dict, None]:
    """Process delivery marking with round-based retries.

    Round 1: Try all voters.  Collect failures.
    Round 2-5: Wait 1 min, retry only failures.

    Yields SSE-friendly dicts:
      {type: "progress",    processed, total, success, failed}
      {type: "retry_wait",  attempt, remaining, countdown}
      {type: "batch_start", batch_num, batch_total}
      {type: "complete",    total, success, failed, failures, failure_report?}
    """
    total = len(voters)
    succeeded = set()
    pending = list(voters)
    all_failures = {}  # voter_id -> last error info

    for attempt in range(1, MAX_RETRIES + 1):
        if not pending:
            break

        # Wait before retry rounds
        if attempt > 1:
            for remaining_sec in range(RETRY_PAUSE_SECONDS, 0, -5):
                yield {
                    "type": "retry_wait",
                    "attempt": attempt,
                    "remaining": len(pending),
                    "countdown": remaining_sec,
                }
                await asyncio.sleep(5)

        round_failures = []
        num_batches = (len(pending) + BATCH_SIZE - 1) // BATCH_SIZE

        for batch_idx in range(0, len(pending), BATCH_SIZE):
            batch = pending[batch_idx:batch_idx + BATCH_SIZE]
            batch_num = (batch_idx // BATCH_SIZE) + 1

            yield {
                "type": "batch_start",
                "batch_num": batch_num,
                "batch_total": num_batches,
                "attempt": attempt,
            }

            loop = asyncio.get_event_loop()
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                futures = []
                for voter in batch:
                    fut = loop.run_in_executor(
                        pool,
                        _mark_one,
                        voter, scheme_type, scheme_id, scheme_name,
                        operator_name, batch_id, source_filename, attempt,
                    )
                    futures.append((voter, fut))

                for voter, fut in futures:
                    try:
                        result = await fut
                        if result["ok"]:
                            succeeded.add(voter["voter_id"])
                            all_failures.pop(voter["voter_id"], None)
                        else:
                            round_failures.append(voter)
                            all_failures[voter["voter_id"]] = result
                    except Exception as exc:
                        round_failures.append(voter)
                        all_failures[voter["voter_id"]] = {
                            "ok": False,
                            "voter_id": voter["voter_id"],
                            "ward": voter.get("ward", ""),
                            "booth": voter.get("booth", ""),
                            "sl": voter.get("sl", ""),
                            "name": voter.get("name", ""),
                            "error": str(exc),
                        }

                    yield {
                        "type": "progress",
                        "processed": len(succeeded) + len(all_failures),
                        "total": total,
                        "success": len(succeeded),
                        "failed": len(all_failures),
                        "attempt": attempt,
                    }

        pending = round_failures
        logger.info("retry_round_done", attempt=attempt,
                    success=len(succeeded), remaining=len(pending))

    # Save audit records for final failures
    for vid, info in all_failures.items():
        try:
            storage.save_audit_record(
                batch_id=batch_id, voter_id=vid,
                scheme_type=scheme_type, scheme_id=scheme_id,
                scheme_name=scheme_name,
                ward=info.get("ward", ""), booth=info.get("booth", ""),
                sl=info.get("sl", ""), voter_name=info.get("name", ""),
                status="failed", operator_name=operator_name,
                source_filename=source_filename,
                error_message=info.get("error", ""),
            )
        except Exception as exc:
            logger.error("audit_save_failed", voter_id=vid, error=str(exc))

    final_failures = list(all_failures.values())
    yield {
        "type": "complete",
        "total": total,
        "success": len(succeeded),
        "failed": len(final_failures),
        "failures": final_failures,
    }


def _mark_one(voter: dict, scheme_type: str, scheme_id: str,
              scheme_name: str, operator_name: str,
              batch_id: str, source_filename: str,
              attempt: int) -> dict:
    """Mark a single voter as delivered + save audit. Runs in thread pool."""
    vid = voter["voter_id"]
    ward = voter.get("ward", "")
    booth = voter.get("booth", "")
    try:
        storage.mark_delivered(
            scheme_type=scheme_type,
            scheme_id=scheme_id,
            ward=ward, booth=booth,
            voter_id=vid,
            delivered_by="BULK_UPLOAD",
            delivered_by_name=f"Bulk: {operator_name}",
        )
        storage.save_audit_record(
            batch_id=batch_id, voter_id=vid,
            scheme_type=scheme_type, scheme_id=scheme_id,
            scheme_name=scheme_name,
            ward=ward, booth=booth,
            sl=voter.get("sl", ""),
            voter_name=voter.get("name", ""),
            status="delivered",
            operator_name=operator_name,
            source_filename=source_filename,
        )
        logger.info("bulk_delivered", voter_id=vid, attempt=attempt)
        return {"ok": True, "voter_id": vid}
    except Exception as exc:
        logger.warning("bulk_deliver_error", voter_id=vid,
                       attempt=attempt, error=str(exc))
        return {
            "ok": False,
            "voter_id": vid,
            "ward": ward,
            "booth": booth,
            "sl": voter.get("sl", ""),
            "name": voter.get("name", ""),
            "error": str(exc),
        }
