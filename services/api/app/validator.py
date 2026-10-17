"""Deterministic validator (python Decimal). Validator facts always override agent-supplied numbers.

Public functions (per CONTRACT): normalize_ref, ref_variants, compute_billable, find_duplicates, check_proposal.
Plus derive_facts / build_timeline used by the orchestrator to turn evidence fields into exact facts.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable

TWO = Decimal("0.01")


def D(value: Any) -> Decimal:
    """Strict Decimal conversion. Accepts '1,00,000', '₹70,000.00', 70000, 7e4."""
    if value is None:
        raise InvalidOperation("None is not a number")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(repr(value))
    if isinstance(value, int):
        return Decimal(value)
    s = str(value).strip().replace("₹", "").replace("Rs.", "").replace("Rs", "").replace("INR", "").replace(",", "").strip()
    if not s:
        raise InvalidOperation("empty")
    return Decimal(s)


def money(value: Any) -> Decimal:
    return D(value).quantize(TWO, rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------- references
_REF_RE = re.compile(r"^\s*([A-Za-z]+)?[\s.#:/_\-]*0*(\d+)\s*([A-Za-z]*)\s*$")


def normalize_ref(ref: str | None) -> str | None:
    """'PO-184' -> 'PO184'; 'P.O. #0184' -> 'PO184'; 'po 184' -> 'PO184'."""
    if ref is None:
        return None
    s = str(ref).strip().upper().replace("P.O.", "PO").replace("P.O", "PO")
    m = _REF_RE.match(s)
    if m:
        prefix, num, suffix = m.group(1) or "", m.group(2), m.group(3) or ""
        return f"{prefix}{int(num)}{suffix}"
    cleaned = re.sub(r"[^A-Z0-9]", "", s)
    return cleaned or None


def ref_variants(ref: str) -> list[str]:
    """Spellings a human might have used for the same reference, for alternate-ID searches."""
    norm = normalize_ref(ref)
    if not norm:
        return []
    m = re.match(r"^([A-Z]*)(\d+)([A-Z]*)$", norm)
    if not m:
        return [ref, norm]
    prefix, num, suffix = m.groups()
    out: list[str] = []
    seps = ["-", "", " ", "/", "#", "_", ". "]
    prefixes = [prefix] if prefix else [""]
    if prefix == "PO":
        prefixes += ["P.O.", "PO NO", "ORDER", "SO"]
    for p in prefixes:
        for sep in seps if p else [""]:
            for n in (num, num.zfill(4), num.zfill(5)):
                out.append(f"{p}{sep}{n}{suffix}")
    out.append(num)
    seen: set[str] = set()
    uniq = []
    for v in [ref] + out:
        if v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


def refs_match(a: str | None, b: str | None) -> bool:
    na, nb = normalize_ref(a), normalize_ref(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    # 'PO184' vs '184': numeric core equal and one side has no prefix
    da, db = re.sub(r"\D", "", na), re.sub(r"\D", "", nb)
    return bool(da) and da == db and (na.isdigit() or nb.isdigit())


def text_mentions_ref(text: str | None, ref: str) -> bool:
    if not text:
        return False
    norm = normalize_ref(ref)
    if not norm:
        return False
    for m in re.finditer(r"(?i)\b(P\.?O\.?|SO|ORDER|INV|PO)\s*(?:NO\.?|NUMBER)?\s*[\s.#:/_\-]*\s*(\d{1,7})\b", text):
        if normalize_ref(m.group(1) + m.group(2)) == norm:
            return True
    return False


# ---------------------------------------------------------------- billing
@dataclass
class BillingRule:
    mode: str = "on_delivery"  # on_delivery | on_full_delivery | on_order
    delay_days: int = 0  # invoice may only be raised N days after the delivery event
    allow_partial: bool = True

    @classmethod
    def from_any(cls, rule: Any) -> "BillingRule":
        if isinstance(rule, BillingRule):
            return rule
        if isinstance(rule, str):
            return cls(mode=rule)
        rule = rule or {}
        return cls(
            mode=rule.get("mode", "on_delivery"),
            delay_days=int(rule.get("delay_days", 0) or 0),
            allow_partial=bool(rule.get("allow_partial", True)),
        )


def compute_billable(
    order_qty: Any,
    delivered_qty: Any,
    rate: Any,
    rule: Any = "on_delivery",
    already_invoiced_qty: Any = 0,
    delivered_at: datetime | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Exact billable quantity/amount under a billing rule. Never negative, never above the order."""
    r = BillingRule.from_any(rule)
    oq, dq, rt, inv = D(order_qty), D(delivered_qty), money(rate), D(already_invoiced_qty or 0)
    if oq < 0 or dq < 0 or rt < 0 or inv < 0:
        raise ValueError("quantities and rate must be non-negative")
    reasons: list[str] = []
    if dq > oq:
        reasons.append(f"delivered {dq} exceeds ordered {oq}; capped at order quantity")
        dq = oq
    if r.mode == "on_order":
        base = oq
    elif r.mode == "on_full_delivery":
        base = oq if dq >= oq else Decimal(0)
        if dq < oq:
            reasons.append("rule on_full_delivery: order not fully delivered")
    else:
        base = dq if (r.allow_partial or dq >= oq) else Decimal(0)
        if not r.allow_partial and dq < oq:
            reasons.append("partial billing not allowed")
    due_at = None
    not_due = False
    if r.delay_days and delivered_at is not None:
        due_at = delivered_at + timedelta(days=r.delay_days)
        now = now or datetime.now(timezone.utc)
        if now < due_at:
            not_due = True
            reasons.append(f"billing not due until {due_at.date().isoformat()} (delay {r.delay_days}d)")
    billable_qty = max(Decimal(0), base - inv)
    if inv > 0:
        reasons.append(f"{inv} units already invoiced")
    amount = (billable_qty * rt).quantize(TWO, rounding=ROUND_HALF_UP)
    return {
        "billable_qty": billable_qty,
        "invoiced_qty": inv,
        "rate": rt,
        "amount": amount if not not_due else Decimal("0.00"),
        "amount_when_due": amount,
        "rule": r.mode,
        "not_due": not_due,
        "due_at": due_at.isoformat() if due_at else None,
        "reasons": reasons,
    }


# ---------------------------------------------------------------- duplicates
def find_duplicates(invoices: Iterable[dict[str, Any]], ref: str, amount: Any = None, customer_id: str | None = None) -> list[dict[str, Any]]:
    """Invoices that already cover this reference. exact=True when the amount also matches."""
    out = []
    amt = money(amount) if amount is not None else None
    for inv in invoices:
        if inv.get("status") in ("void",):
            continue
        refs = [inv.get("reference_number"), inv.get("po_ref"), inv.get("salesorder_number")]
        text_fields = " ".join(str(inv.get(k) or "") for k in ("notes", "subject", "terms"))
        matched_ref = any(refs_match(x, ref) for x in refs if x) or text_mentions_ref(text_fields, ref)
        if not matched_ref:
            continue
        if customer_id and inv.get("customer_id") and inv["customer_id"] != customer_id:
            continue
        total = money(inv.get("total", 0))
        out.append(
            {
                "invoice_id": inv.get("invoice_id"),
                "invoice_number": inv.get("invoice_number"),
                "total": total,
                "exact": amt is not None and total == amt,
                "matched_on": "reference",
            }
        )
    return out


# ---------------------------------------------------------------- proposal check
def check_proposal(proposal: dict[str, Any], facts: dict[str, Any]) -> dict[str, Any]:
    """Validate an agent proposal against validator facts.

    - amount must equal the deterministic billable amount (and Σ qty×rate)
    - every claim must cite >= 1 existing, non-quarantined evidence node
    - no write when an invoice for the reference already exists (duplicate)
    Returns {ok, errors, warnings, corrected_action}; corrected_action carries validator numbers.
    """
    errors: list[str] = []
    warnings: list[str] = []
    action = dict(proposal.get("action") or {})
    a_type = action.get("type", "none")
    valid_nodes = set(facts.get("evidence_node_ids") or [])
    quarantined = set(facts.get("quarantined_node_ids") or [])

    claims = proposal.get("claims") or []
    if a_type != "none" and not claims:
        errors.append("no_claims: a proposal must cite evidence")
    for i, c in enumerate(claims):
        cited = c.get("evidence_node_ids") or []
        if not cited:
            errors.append(f"claim[{i}] cites no evidence")
            continue
        bad = [n for n in cited if n not in valid_nodes]
        if any(n in quarantined for n in cited):
            errors.append(f"claim[{i}] cites quarantined evidence")
        elif bad:
            errors.append(f"claim[{i}] cites unknown evidence {bad}")

    corrected = dict(action)
    if a_type == "create_invoice":
        billable = facts.get("billable") or {}
        if facts.get("duplicates") and not billable.get("top_up_ok"):
            errors.append("duplicate_invoice_exists")
        dup_numbers = sorted(d.get("invoice_number") or "" for d in (facts.get("duplicates") or []))
        if (action.get("top_up_of") or facts.get("duplicates")) and sorted(action.get("top_up_of") or []) != dup_numbers:
            errors.append("duplicate_invoice_exists")  # top_up_of must name exactly the existing invoices
        try:
            expected = money(billable.get("amount", 0))
            proposed = money(action.get("amount", 0))
        except InvalidOperation:
            errors.append("amount_not_numeric")
            expected = proposed = Decimal(0)
        if expected <= 0:
            errors.append("nothing_billable")
        line_total = Decimal(0)
        try:
            for li in action.get("line_items") or []:
                line_total += D(li.get("qty", 0)) * money(li.get("rate", 0))
        except InvalidOperation:
            errors.append("line_items_not_numeric")
        line_total = line_total.quantize(TWO)
        if proposed != expected:
            warnings.append(f"amount_overridden: agent {proposed} -> validator {expected}")
        if line_total != expected:
            warnings.append(f"line_items_overridden: agent Σ {line_total} -> validator {expected}")
        if expected > 0:
            corrected["amount"] = float(expected)
            corrected["line_items"] = [
                {
                    "item": (action.get("line_items") or [{}])[0].get("item") or facts.get("item") or "Item",
                    "qty": float(billable.get("billable_qty", 0)),
                    "rate": float(money(billable.get("rate", 0))),
                }
            ]
        for key in ("customer_id", "customer_name", "reference"):
            fv = facts.get(key)
            if fv and action.get(key) and str(action.get(key)) != str(fv):
                warnings.append(f"{key}_overridden: {action.get(key)} -> {fv}")
            if fv:
                corrected[key] = fv
        if not corrected.get("customer_id"):
            errors.append("customer_unresolved")
    elif a_type == "send_reminder":
        if not action.get("message"):
            errors.append("reminder_without_message")
        if action.get("channel") not in ("whatsapp", "gmail"):
            errors.append("reminder_channel_invalid")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "corrected_action": corrected}


# ---------------------------------------------------------------- fact derivation
def _ts(n: dict[str, Any]) -> datetime:
    t = n.get("ts")
    if isinstance(t, datetime):
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    if isinstance(t, str):
        try:
            dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


@dataclass
class Facts:
    po_ref: str | None = None
    customer_id: str | None = None
    customer_name: str | None = None
    item: str | None = None
    order_qty: Decimal | None = None
    rate: Decimal | None = None
    order_amount: Decimal | None = None
    delivered_qty: Decimal | None = None
    delivered_at: datetime | None = None
    delivery_sources: list[dict[str, Any]] = field(default_factory=list)
    superseded_sources: list[dict[str, Any]] = field(default_factory=list)  # counts that were right before a newer challan
    invoices: list[dict[str, Any]] = field(default_factory=list)
    duplicates: list[dict[str, Any]] = field(default_factory=list)
    payments: list[dict[str, Any]] = field(default_factory=list)
    paid_amount: Decimal = Decimal(0)
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    billable: dict[str, Any] = field(default_factory=dict)
    evidence_node_ids: list[str] = field(default_factory=list)
    quarantined_node_ids: list[str] = field(default_factory=list)
    stage_nodes: dict[str, list[str]] = field(default_factory=lambda: {"order": [], "delivery": [], "invoice": [], "payment": []})
    rule: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        def conv(v: Any) -> Any:
            if isinstance(v, Decimal):
                return float(v)
            if isinstance(v, datetime):
                return v.isoformat()
            if isinstance(v, dict):
                return {k: conv(x) for k, x in v.items()}
            if isinstance(v, list):
                return [conv(x) for x in v]
            return v

        return {k: conv(v) for k, v in self.__dict__.items()}


def derive_facts(nodes: list[dict[str, Any]], ref: str | None, rule: Any = None, now: datetime | None = None) -> Facts:
    """Exact facts from evidence node fields. Quarantined nodes are never used."""
    f = Facts(po_ref=ref, rule=(rule if isinstance(rule, dict) else {"mode": rule or "on_delivery"}))
    usable = []
    for n in nodes:
        if n.get("kind") == "note" or (n.get("fields") or {}).get("agent_note"):
            continue  # agent notes never carry facts
        if n.get("quarantined"):
            f.quarantined_node_ids.append(n["id"])
            continue
        f.evidence_node_ids.append(n["id"])
        usable.append(n)

    orders, deliveries = [], []
    # a person moved the case to the right PO ("This is wrong" on the PO): evidence filed under the old number still belongs here
    old_refs = {normalize_ref(n["fields"]["po_ref_from"]) for n in usable if (n.get("fields") or {}).get("is_correction") and (n.get("fields") or {}).get("po_ref_from")}
    for n in usable:
        flds = n.get("fields") or {}
        nref = flds.get("po_ref")
        related = ref is None or nref is None or refs_match(nref, ref) or normalize_ref(nref) in old_refs
        if flds.get("customer_id") and not f.customer_id and related:
            f.customer_id = flds["customer_id"]
        if flds.get("customer") and not f.customer_name and related:
            f.customer_name = flds["customer"]
        if not related:
            continue
        if flds.get("qty_ordered") is not None:
            orders.append(n)
        if flds.get("qty_delivered") is not None:
            deliveries.append(n)
        if n.get("kind") == "invoice":
            f.invoices.append({**flds, "node_id": n["id"]})
        if n.get("kind") in ("payment", "bank_txn") and flds.get("payment_amount") is not None:
            f.payments.append({**flds, "node_id": n["id"]})

    corr_cust = sorted([n for n in usable if (n.get("fields") or {}).get("is_correction") and (n.get("fields") or {}).get("customer")], key=_ts)
    if corr_cust:  # a person's correction of the customer name wins
        f.customer_name = corr_cust[-1]["fields"]["customer"]
        if corr_cust[-1]["fields"].get("customer_id"):
            f.customer_id = corr_cust[-1]["fields"]["customer_id"]

    # ---- order
    qtys = {}
    for n in orders:
        flds = n["fields"]
        try:
            qtys[n["id"]] = D(flds["qty_ordered"])
        except InvalidOperation:
            continue
        f.stage_nodes["order"].append(n["id"])
        if flds.get("rate") is not None and f.rate is None:
            f.rate = money(flds["rate"])
        if flds.get("item") and not f.item:
            f.item = flds["item"]
        if flds.get("amount") is not None and f.order_amount is None:
            f.order_amount = money(flds["amount"])
    if qtys:
        distinct = set(qtys.values())
        f.order_qty = max(distinct, key=lambda q: sum(1 for v in qtys.values() if v == q))
        if len(distinct) > 1:
            f.conflicts.append({"field": "order_qty", "values": sorted(float(x) for x in distinct), "node_ids": list(qtys)})
    # manual "This is wrong" corrections of the order (qty / rate) supersede the documents
    corr_orders = sorted([n for n in orders if (n.get("fields") or {}).get("is_correction")], key=_ts)
    corr_rate = sorted([n for n in usable if (n.get("fields") or {}).get("is_correction") and (n.get("fields") or {}).get("rate") is not None
                        and (ref is None or (n.get("fields") or {}).get("po_ref") is None or refs_match(n["fields"].get("po_ref"), ref)
                             or normalize_ref(n["fields"].get("po_ref")) in old_refs)], key=_ts)
    if corr_orders:
        try:
            f.order_qty = D(corr_orders[-1]["fields"]["qty_ordered"])
            f.conflicts = [c for c in f.conflicts if c["field"] != "order_qty"]
            f.order_amount = None
        except InvalidOperation:
            pass
    if corr_rate:
        try:
            f.rate = money(corr_rate[-1]["fields"]["rate"])
            f.order_amount = None
        except InvalidOperation:
            pass
    if f.rate is None and f.order_amount is not None and f.order_qty:
        f.rate = money(f.order_amount / f.order_qty)
    if f.order_amount is None and f.rate is not None and f.order_qty is not None:
        f.order_amount = money(f.order_qty * f.rate)
    if f.order_amount is not None and f.rate is not None and f.order_qty is not None and money(f.order_qty * f.rate) != f.order_amount:
        f.conflicts.append({"field": "order_amount", "values": [float(f.order_amount), float(f.order_qty * f.rate)], "node_ids": f.stage_nodes["order"]})

    # ---- delivery: a reading the LLM itself was unsure of (confidence < 0.7) is never used as a fact; it asks a person
    unsure = [n for n in deliveries if (n.get("fields") or {}).get("confidence") is not None and float(n["fields"]["confidence"]) < 0.7]
    deliveries = [n for n in deliveries if n not in unsure]
    corr_ts = [_ts(n) for n in deliveries if (n.get("fields") or {}).get("is_correction")]
    for n in unsure:
        if corr_ts and max(corr_ts) >= _ts(n):
            continue  # a person (or a later clear correction) already settled it
        f.conflicts.append({"field": "delivered_qty", "values": {"unclear message": float(D(n["fields"]["qty_delivered"]))}, "node_ids": [n["id"]],
                            "reason": n["fields"].get("meaning") or "the AI was not sure how to read this message"})
    # ---- delivery: corrections supersede everything older; remaining disagreement is a conflict
    deliveries.sort(key=_ts)
    if deliveries:
        last_corr = None
        for n in deliveries:
            if (n.get("fields") or {}).get("is_correction"):
                last_corr = n
        live = [n for n in deliveries if last_corr is None or _ts(n) >= _ts(last_corr)]
        # "40 more delivered" messages add to the latest full count instead of replacing it
        increments = [n for n in live if (n.get("fields") or {}).get("is_incremental") and not (n.get("fields") or {}).get("is_correction")]
        live = [n for n in live if n not in increments]
        # numbered delivery challans: each challan number is its own delivery (CH-101 60 + CH-102 40 = 100);
        # the same challan number seen twice is one delivery (the latest reading of it wins), never a second one.
        numbered = [n for n in live if (n.get("fields") or {}).get("challan_number") and not (n.get("fields") or {}).get("is_correction")]
        live = [n for n in live if n not in numbered]
        by_no: dict[str, dict[str, Any]] = {}
        for n in numbered:
            by_no[normalize_ref(str(n["fields"]["challan_number"])) or str(n["fields"]["challan_number"])] = n
        # latest value per source channel
        per_source: dict[str, dict[str, Any]] = {}
        for n in live:
            per_source[n.get("source", "?")] = n
        vals = {}
        for src, n in per_source.items():
            try:
                vals[src] = D(n["fields"]["qty_delivered"])
            except InvalidOperation:
                continue
        if by_no:
            # another source's count that matched the challans at the time is not a conflict once a newer challan adds
            # more (sheet "60" after CH-1 60, then CH-2 40 arrives: total 100, the sheet is just behind)
            newest = max(_ts(n) for n in by_no.values())
            for src in list(vals):
                n0 = per_source[src]
                if _ts(n0) >= newest:
                    continue
                upto = Decimal(0)
                for c in by_no.values():
                    if _ts(c) <= _ts(n0):
                        try:
                            upto += D(c["fields"]["qty_delivered"])
                        except InvalidOperation:
                            pass
                if upto and vals[src] == upto:
                    f.superseded_sources.append({"source": src, "qty": float(vals[src]), "node_id": n0["id"]})
                    vals.pop(src)
                    per_source.pop(src)
            tot = Decimal(0)
            for n in by_no.values():
                try:
                    tot += D(n["fields"]["qty_delivered"])
                except InvalidOperation:
                    continue
            vals["challans"] = tot
            per_source["challans"] = max(by_no.values(), key=_ts)
        f.delivery_sources = [
            {"source": s, "qty": float(v), "node_id": per_source[s]["id"], "ts": _ts(per_source[s]).isoformat(), "correction": bool(per_source[s]["fields"].get("is_correction")),
             **({"challans": {str(n["fields"]["challan_number"]): float(D(n["fields"]["qty_delivered"])) for n in by_no.values()}} if s == "challans" else {})}
            for s, v in vals.items()
        ]
        f.stage_nodes["delivery"] = [n["id"] for n in deliveries]
        if vals:
            if len(set(vals.values())) > 1:
                f.conflicts.append({"field": "delivered_qty", "values": {k: float(v) for k, v in vals.items()}, "node_ids": [per_source[s]["id"] for s in vals]})
            latest = last_corr or max((per_source[s] for s in vals), key=_ts)
            src_of = next((k for k in vals if per_source[k] is latest), None)
            f.delivered_qty = vals[src_of] if src_of is not None else D(latest["fields"]["qty_delivered"])
            f.delivered_at = _ts(latest)
        else:
            latest = None
        base_ts = _ts(latest) if latest is not None else None
        added = Decimal(0)
        for n in increments:
            if base_ts is not None and _ts(n) < base_ts:
                continue  # already counted in a later full count
            try:
                added += D(n["fields"]["qty_delivered"])
            except InvalidOperation:
                continue
            f.delivered_at = max(f.delivered_at, _ts(n)) if f.delivered_at else _ts(n)
            f.delivery_sources.append({"source": n.get("source", "?"), "qty": float(D(n["fields"]["qty_delivered"])), "node_id": n["id"], "ts": _ts(n).isoformat(),
                                       "correction": False, "incremental": True})
        if added:
            f.delivered_qty = (f.delivered_qty or Decimal(0)) + added

    # ---- invoices / duplicates / payments
    f.stage_nodes["invoice"] = [i["node_id"] for i in f.invoices]
    if ref:
        f.duplicates = find_duplicates(f.invoices, ref, None, None)
    for p in f.payments:
        try:
            f.paid_amount += money(p["payment_amount"])
        except InvalidOperation:
            continue
    f.stage_nodes["payment"] = [p["node_id"] for p in f.payments]
    finish_billable(f, now)
    return f


def finish_billable(f: Facts, now: datetime | None = None) -> None:
    """Billable amount from the facts (also re-run after the timeline agent's verified total replaces delivered_qty)."""
    invoiced_qty = Decimal(0)
    qty_known = True
    for inv in f.duplicates:
        src = next((i for i in f.invoices if i.get("invoice_id") == inv["invoice_id"]), {})
        try:
            q = D(src.get("qty") or 0)
        except InvalidOperation:
            q = Decimal(0)
        if q <= 0:
            qty_known = False
        invoiced_qty += q
    f.billable = {}
    if f.order_qty is not None and f.delivered_qty is not None and f.rate is not None:
        f.billable = compute_billable(f.order_qty, f.delivered_qty, f.rate, f.rule, invoiced_qty, f.delivered_at, now)
        # top-up billing ("40 more delivered" after an invoice) is only safe when every existing invoice's quantity is known
        f.billable["top_up_ok"] = bool(f.duplicates) and qty_known and invoiced_qty > 0


def build_timeline(f: Facts) -> list[dict[str, Any]]:
    conflict_fields = {c["field"] for c in f.conflicts}
    tl = []
    tl.append({"stage": "order", "status": "conflict" if conflict_fields & {"order_qty", "order_amount"} else ("found" if f.order_qty is not None else "missing"), "evidence_node_ids": f.stage_nodes["order"]})
    if "delivered_qty" in conflict_fields:
        ds = "conflict"
    elif f.delivered_qty is None:
        ds = "missing"
    elif f.order_qty is not None and f.delivered_qty < f.order_qty:
        ds = "partial"
    else:
        ds = "found"
    tl.append({"stage": "delivery", "status": ds, "evidence_node_ids": f.stage_nodes["delivery"]})
    if len(f.duplicates) > 1:
        ist = "conflict"
    elif f.duplicates:
        tot = sum((d["total"] for d in f.duplicates), Decimal(0))
        ist = "found" if f.order_amount is not None and tot >= f.order_amount else "partial"
    else:
        ist = "missing"
    tl.append({"stage": "invoice", "status": ist, "evidence_node_ids": [d.get("node_id") for d in f.invoices if any(d.get("invoice_id") == x["invoice_id"] for x in f.duplicates)]})
    if f.paid_amount > 0:
        inv_total = sum((d["total"] for d in f.duplicates), Decimal(0))
        pst = "found" if inv_total and f.paid_amount >= inv_total else "partial"
    else:
        pst = "missing"
    tl.append({"stage": "payment", "status": pst, "evidence_node_ids": f.stage_nodes["payment"]})
    return tl
