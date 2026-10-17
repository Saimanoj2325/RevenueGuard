"""Code verifier for the timeline agent (CONTRACT_V3 §1). The agent decides what the messages mean; this file only
checks its answer. Deterministic, no model calls. Any failed check -> the case goes to "Needs a check" with the
reason in plain words.

Checks:
 1. every node_id exists and belongs to the tenant; a counted node is not deleted / duplicate / quarantined;
 2. every qty is written in that node's own text, derived text or fields (same idea as extraction.ground);
 3. total == sum(qty where role == counts), exactly;
 4. the linked case / PO exists (or new_case with a PO written in the message);
 5. confidence >= 0.7.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from .extraction import _numbers_in
from .validator import normalize_ref, refs_match, text_mentions_ref

MIN_CONFIDENCE = 0.7
NOT_COUNTABLE = {"deleted": "was deleted by the sender", "duplicate": "is the same message or photo sent again"}
QTY_FIELDS = ("qty_delivered", "qty_ordered", "qty_pending", "qty")


def _dec(v: Any) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def node_text(n: dict[str, Any]) -> str:
    """Only the node's CURRENT words. Old versions of an edited message never ground a number."""
    return "\n".join(x for x in (n.get("title") if n.get("source") in ("sheets", "zoho") else None, n.get("excerpt"), n.get("derived_text")) if x)


def qty_grounded(qty: Any, n: dict[str, Any]) -> bool:
    q = _dec(qty)
    if q is None:
        return False
    nums = {Decimal(str(x)) for x in _numbers_in(node_text(n))}
    for k in QTY_FIELDS:
        fv = _dec((n.get("fields") or {}).get(k))
        if fv is not None:
            nums.add(fv)
    return q in nums


def _digits_in(po: str, text: str) -> bool:
    """'PO-184' is grounded by a bare '184' in the message too."""
    import re

    d = re.sub(r"\D", "", normalize_ref(po) or "")
    return bool(d) and bool(re.search(rf"(?<!\d)0*{d}(?!\d)", text or ""))


def short(n: dict[str, Any]) -> str:
    t = (n.get("excerpt") or n.get("derived_text") or n.get("title") or "").strip().replace("\n", " ")
    return f"\"{t[:40]}\"" if t else "the message"


def verify(decision: dict[str, Any], nodes: dict[str, dict[str, Any]], *, tenant_id: str,
           cases: dict[str, dict[str, Any]] | None = None, trigger_text: str = "") -> tuple[bool, list[str]]:
    """decision: TimelineDecision dict. nodes: node_id -> node dict (id, tenant_id, excerpt, derived_text, fields,
    quarantined). cases: case_ref (number or id) -> {case_number, po_ref} for this tenant. Returns (ok, failed_checks)."""
    failed: list[str] = []
    events = ((decision.get("delivered") or {}).get("events")) or []
    counted = Decimal(0)
    # 1 + 2: nodes exist, are countable, and every number is in the node's own words
    for ev in events:
        nid = ev.get("node_id")
        role = str(ev.get("role") or "")
        n = nodes.get(nid)
        if n is None or n.get("tenant_id") not in (None, tenant_id):
            failed.append(f"The agent used a message we do not have ({str(nid)[:12]}).")
            continue
        status = (n.get("fields") or {}).get("status") or "active"
        if role == "counts":
            if status in NOT_COUNTABLE:
                failed.append(f"The agent counted {short(n)}, but that message {NOT_COUNTABLE[status]}.")
            if n.get("quarantined"):
                failed.append(f"The agent counted {short(n)}, which was set aside as suspicious.")
        if role.startswith("duplicate_of:") and role.split(":", 1)[1] not in nodes:
            failed.append(f"The agent said {short(n)} repeats a message we do not have.")
        q = _dec(ev.get("qty"))
        if q is None:
            failed.append(f"The quantity for {short(n)} is not a number.")
            continue
        if q < 0:
            failed.append(f"The quantity for {short(n)} is negative.")
        if (role == "counts" or q != 0) and not qty_grounded(q, n):
            failed.append(f"The agent read {q:g} from {short(n)}, but that number is not in the message.")
        if role == "counts":
            counted += q
    # 3: total is exactly the sum of what counts
    total = _dec((decision.get("delivered") or {}).get("total"))
    has_counts = any(str(e.get("role")) == "counts" for e in events)
    if total is None and has_counts:
        failed.append("The agent counted deliveries but gave no total.")
    elif total is not None and total != counted:
        failed.append(f"The total {total:g} does not match the deliveries it counted ({counted:g}).")
    # 4: the case / PO it linked to is real
    link = decision.get("link") or {}
    action = link.get("action")
    cases = cases or {}
    if action == "existing_case":
        c = cases.get(str(link.get("case_ref") or ""))
        if c is None:
            failed.append(f"The agent linked this to case {link.get('case_ref') or '(none)'}, which we do not have.")
        elif link.get("po_ref") and c.get("po_ref") and not refs_match(link["po_ref"], c["po_ref"]):
            failed.append(f"The agent said {link['po_ref']}, but that case is for {c['po_ref']}.")
    elif action == "new_case":
        po = link.get("po_ref")
        if not po:
            failed.append("The agent wants a new case but gave no PO number.")
        elif not (text_mentions_ref(trigger_text, po) or _digits_in(po, trigger_text)):
            failed.append(f"The agent wants a new case for {po}, but that PO number is not in the message.")
    # 5: the agent itself must be sure enough
    try:
        conf = float(decision.get("confidence"))
    except (TypeError, ValueError):
        conf = 0.0
    if conf < MIN_CONFIDENCE:
        failed.append(f"The agent was not sure (confidence {conf:.2f}, needs {MIN_CONFIDENCE}).")
    return (not failed), failed
