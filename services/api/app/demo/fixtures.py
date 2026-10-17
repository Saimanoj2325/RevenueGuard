"""Programmatic demo fixtures: PO PDF (reportlab), delivery challan PNG (Pillow, with OCR-able text and an
rg_text sidecar chunk), Hinglish voice-note OGG placeholder (+ transcript sidecar)."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

SUPPLIER = "Demo Manufacturing Pvt Ltd"
CUSTOMER = "Example Customer Pvt Ltd"
VOICE_TRANSCRIPT = "60 boxes gaye, baaki next week"
CHALLAN_TEXT = (
    "DELIVERY CHALLAN\n"
    f"From: {SUPPLIER}\n"
    "Challan No: DC-5521\n"
    "Date: 12-10-2026\n"
    "PO Ref: PO-184\n"
    f"Customer: {CUSTOMER}\n"
    "Item: Model X\n"
    "Qty Dispatched: 60\n"
    "Vehicle: TS09 UB 4411\n"
    "Received by: ______"
)


def _po_pdf(path: Path, po: str, customer: str, item: str, qty: int, rate: int, date: str) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 18)
    c.drawString(50, h - 70, "PURCHASE ORDER")
    c.setFont("Helvetica", 11)
    lines = [
        f"PO Number: {po}",
        f"Date: {date}",
        f"Buyer: {customer}",
        f"Supplier: {SUPPLIER}",
        "",
        f"Item: {item}",
        f"Quantity: {qty} units",
        f"Rate: Rs. {rate:,} per unit",
        f"Total: Rs. {qty * rate:,}",
        "",
        "Terms: Invoice on delivered quantity. Payment 30 days from invoice.",
        "Delivery: Partial deliveries accepted.",
    ]
    y = h - 110
    for ln in lines:
        c.drawString(50, y, ln)
        y -= 18
    c.drawString(50, y - 30, f"Authorised signatory, {customer}")
    c.showPage()
    c.save()


def _challan_png(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont
    from PIL.PngImagePlugin import PngInfo

    img = Image.new("RGB", (900, 560), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 28)
        big = ImageFont.truetype("DejaVuSans-Bold.ttf", 38)
    except OSError:
        font = big = ImageFont.load_default()
    lines = CHALLAN_TEXT.split("\n")
    d.text((40, 30), lines[0], fill="black", font=big)
    y = 95
    for ln in lines[1:]:
        d.text((40, y), ln, fill="black", font=font)
        y += 48
    d.rectangle([20, 20, 880, 540], outline="black", width=3)
    meta = PngInfo()
    meta.add_text("rg_text", CHALLAN_TEXT)
    img.save(path, pnginfo=meta)


def _voice_ogg(path: Path) -> None:
    if shutil.which("ffmpeg"):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", "-b:a", "16k",
             "-metadata", f"comment={VOICE_TRANSCRIPT}", str(path)],
            check=False,
            timeout=30,
        )
    if not path.exists() or path.stat().st_size == 0:
        # minimal Ogg page header placeholder; mock mode reads the transcript sidecar
        path.write_bytes(b"OggS\x00\x02" + b"\x00" * 20 + b"RG-PLACEHOLDER-VOICE-NOTE")


def ensure_fixtures(force: bool = False) -> dict[str, str]:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "po_184_pdf": FIXTURE_DIR / "PO-184.pdf",
        "po_185_pdf": FIXTURE_DIR / "PO-185.pdf",
        "challan_png": FIXTURE_DIR / "challan_PO-184.png",
        "voice_ogg": FIXTURE_DIR / "voice_note_PO-184.ogg",
        "voice_txt": FIXTURE_DIR / "voice_note_PO-184.txt",
    }
    if force or not out["po_184_pdf"].exists():
        _po_pdf(out["po_184_pdf"], "PO-184", CUSTOMER, "Model X", 100, 1000, "05-10-2026")
    if force or not out["po_185_pdf"].exists():
        _po_pdf(out["po_185_pdf"], "PO-185", "Other Traders LLP", "Model Y", 250, 800, "08-10-2026")
    if force or not out["challan_png"].exists():
        _challan_png(out["challan_png"])
    if force or not out["voice_ogg"].exists():
        _voice_ogg(out["voice_ogg"])
    if force or not out["voice_txt"].exists():
        out["voice_txt"].write_text(VOICE_TRANSCRIPT + "\n")
    return {k: str(v) for k, v in out.items()}


if __name__ == "__main__":
    print(ensure_fixtures(force=True))
