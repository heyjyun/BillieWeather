#!/usr/bin/env python3
"""Generates synthetic bank-statement images (and an image-only "scanned" PDF) with known
ground truth for the real-engine OCR tests. Synthetic data only: no real bank, person or account.

    python3 -I test/ocr-fixtures/generate.py      # from clients/universal; needs Pillow + macOS fonts

Outputs PNG/JPEG/PDF files and truth.json next to this script. The generated files are
committed so the tests do not need Python.
"""
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
WIDTH, LINE = 1700, 54


def font(size):
    return ImageFont.truetype(FONT, size)


def money(cents, sign=""):
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{frac:02d}"


def render(statement, rows, first_row=0):
    """One page. Columns: date | description | debit | credit | balance (right-aligned amounts)."""
    cols = statement["columns"]
    lines = len(statement["preamble"]) + len(rows) + 4
    image = Image.new("RGB", (WIDTH, 120 + lines * LINE), "white")
    draw = ImageDraw.Draw(image)
    y = 60
    for text in statement["preamble"]:
        draw.text((80, y), text, fill="black", font=font(30))
        y += LINE
    y += LINE // 2
    header_font = font(30)
    for (x, align), title in zip(cols, statement["headers"]):
        width = draw.textlength(title, font=header_font)
        draw.text((x - width if align == "right" else x, y), title, fill="black", font=header_font)
    y += LINE
    draw.line((60, y - 8, WIDTH - 60, y - 8), fill="black", width=2)
    for row in rows:
        for (x, align), text in zip(statement.get("row_columns", cols), row["cells"]):
            if not text:
                continue
            width = draw.textlength(text, font=font(30))
            draw.text((x - width if align == "right" else x, y), text, fill="black", font=font(30))
        y += LINE
    return image


def build(statement):
    """Rows with debit/credit columns and a running balance; returns (rows, truth)."""
    balance = statement["opening"]
    rows, truth = [], []
    for date_text, description, iso, cents in statement["transactions"]:
        balance += cents
        if statement.get("signed"):
            amount = f"({money(cents)})" if cents < 0 and statement.get("parentheses") and len(rows) % 2 else money(cents, "-" if cents < 0 else "")
            cells = [date_text, description, amount, money(balance)]
        else:
            cells = [date_text, description, money(cents) if cents < 0 else "", money(cents) if cents > 0 else "", money(balance)]
        rows.append({"cells": cells})
        truth.append({"date": iso, "description": description, "amountMinor": cents, "balanceMinor": balance})
    return rows, truth


US = {
    "preamble": ["Synthetic Bank", "Account number: ****4821", "Checking account", "Currency: USD"],
    "headers": ["Date", "Description", "Debit", "Credit", "Balance"],
    "columns": [(80, "left"), (330, "left"), (1150, "right"), (1400, "right"), (1640, "right")],
    "opening": 100000,
    "transactions": [
        ("03/02/2026", "Payroll ACME", "2026-03-02", 250000),
        ("03/03/2026", "Coffee Corner", "2026-03-03", -575),
        ("03/05/2026", "Rent Oak Street", "2026-03-05", -165000),
        ("03/09/2026", "Grocery Mart", "2026-03-09", -8234),
        ("03/14/2026", "Refund Shoe Store", "2026-03-14", 4500),
        ("03/18/2026", "Electric Utility", "2026-03-18", -12099),
        ("03/22/2026", "Transfer to savings", "2026-03-22", -40000),
        ("03/27/2026", "Interest", "2026-03-27", 12),
    ],
}

SIGNED = {
    "preamble": ["Example Credit Union", "Account no: 00009137", "Currency: USD"],
    "headers": ["Date", "Description", "Amount", "Balance"],
    "columns": [(80, "left"), (330, "left"), (1300, "right"), (1640, "right")],
    "signed": True, "parentheses": True,
    "opening": 50000,
    "transactions": [
        ("2026-04-01", "Salary", "2026-04-01", 180000),
        ("2026-04-02", "Bookshop", "2026-04-02", -2399),
        ("2026-04-04", "Pharmacy", "2026-04-04", -1250),
        ("2026-04-06", "Gas Station", "2026-04-06", -4510),
        ("2026-04-11", "Restaurant", "2026-04-11", -6300),
        ("2026-04-15", "Phone bill", "2026-04-15", -3500),
    ],
}

CN = {
    "preamble": ["合成银行 对账单", "账号: 6222 **** **** 7731", "币种: CNY"],
    "headers": ["交易日期", "摘要", "支出", "收入", "余额"],
    "columns": [(80, "left"), (330, "left"), (1150, "right"), (1400, "right"), (1640, "right")],
    "opening": 300000,
    "transactions": [
        ("2026-03-01", "工资 代发", "2026-03-01", 850000),
        ("2026-03-02", "美团外卖", "2026-03-02", -3550),
        ("2026-03-04", "房租", "2026-03-04", -420000),
        ("2026-03-08", "超市购物", "2026-03-08", -18620),
        ("2026-03-12", "退款", "2026-03-12", 2990),
        ("2026-03-20", "电费", "2026-03-20", -21550),
    ],
}

TW = {
    "preamble": ["合成銀行 存款對帳單", "帳號: 012-345678-9900", "幣別: HKD"],
    "headers": ["交易日期", "摘要", "支出", "存入", "餘額"],
    "columns": [(80, "left"), (330, "left"), (1150, "right"), (1400, "right"), (1640, "right")],
    "opening": 120000,
    "transactions": [
        ("2026-05-02", "薪資轉入", "2026-05-02", 420000),
        ("2026-05-03", "便利商店", "2026-05-03", -8800),
        ("2026-05-06", "電話費", "2026-05-06", -19800),
        ("2026-05-10", "餐廳", "2026-05-10", -35600),
        ("2026-05-15", "退貨退款", "2026-05-15", 12000),
        ("2026-05-21", "保險費", "2026-05-21", -150000),
    ],
}


def main():
    truth = {}

    def save(name, image, statement, rows_truth, **extra):
        path = os.path.join(HERE, name)
        if name.endswith(".jpg"):
            image.save(path, quality=82)
        else:
            image.save(path, optimize=True)
        currency = [line.split(":")[-1].strip() for line in statement["preamble"] if ":" in line and len(line.split(":")[-1].strip()) == 3][0]
        truth[name] = {"currency": currency, "opening": statement["opening"], "rows": rows_truth, **extra}

    rows, rows_truth = build(US)
    us = render(US, rows)
    save("us-debit-credit.png", us, US, rows_truth)
    save("us-blurred.png", us.filter(ImageFilter.GaussianBlur(1.6)), US, rows_truth, variant="blur")
    save("us-rotated-90.png", us.rotate(90, expand=True, fillcolor="white"), US, rows_truth, variant="rotated 90")
    save("us-skew-3.png", us.rotate(3, expand=True, fillcolor="white", resample=Image.BICUBIC), US, rows_truth, variant="skew 3")

    rows, rows_truth = build(SIGNED)
    save("us-signed-amount.jpg", render(SIGNED, rows), SIGNED, rows_truth)

    rows, rows_truth = build(CN)
    save("zh-cn.png", render(CN, rows), CN, rows_truth)

    rows, rows_truth = build(TW)
    save("zh-tw.png", render(TW, rows), TW, rows_truth)

    # Two pages: the header is repeated on page 2; the preamble only on page 1.
    rows, rows_truth = build(US)
    page1 = render(US, rows[:5])
    page2 = render({**US, "preamble": []}, rows[5:])
    page1.save(os.path.join(HERE, "multipage-1.png"), optimize=True)
    page2.save(os.path.join(HERE, "multipage-2.png"), optimize=True)
    truth["multipage"] = {"currency": "USD", "opening": US["opening"], "rows": rows_truth, "pages": ["multipage-1.png", "multipage-2.png"]}
    # Image-only PDF (no text layer), like a scanner produces.
    page1.save(os.path.join(HERE, "scanned-statement.pdf"), save_all=True, append_images=[page2], resolution=200.0)
    truth["scanned-statement.pdf"] = truth["multipage"]

    # Amounts drawn half-way between the Debit and Credit columns: direction must not be guessed.
    rows, rows_truth = build(US)
    shifted = [{"cells": [r["cells"][0], r["cells"][1], r["cells"][2] or r["cells"][3], r["cells"][4]]} for r in rows]
    ambiguous = {**US, "row_columns": [(80, "left"), (330, "left"), (1275, "right"), (1640, "right")]}
    save("ambiguous-columns.png", render(ambiguous, shifted), US, rows_truth, variant="amounts between debit and credit")

    with open(os.path.join(HERE, "truth.json"), "w", encoding="utf-8") as handle:
        json.dump(truth, handle, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
