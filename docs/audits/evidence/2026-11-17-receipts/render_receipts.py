# Renders synthetic receipt images from packages/finance-core/fixtures/receipts/parse-cases.json
# (cases with a merchant and total) in five conditions, for the OCR evaluation (ocr_eval.rb).
#   python3 -I render_receipts.py <fixtures.json> <output dir>
# Fonts: macOS system fonts (Menlo; Hiragino Sans GB for CJK). Deterministic: no randomness.
import json, sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

fixtures, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
cases = json.load(open(fixtures))["cases"]
MENLO = "/System/Library/Fonts/Menlo.ttc"
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"

def text_of(case):
    if "text" in case: return case["text"].split("\n")
    return [l if isinstance(l, str) else l["text"] for l in case["lines"]]

def render(lines, cjk):
    font = ImageFont.truetype(CJK if cjk else MENLO, 30)
    width = 40 + max(int(font.getlength(l)) for l in lines)
    img = Image.new("L", (max(width, 520), 60 + 44 * len(lines)), 250)
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        d.text((20, 30 + 44 * i), l, fill=25, font=font)
    return img

manifest = []
for index, case in enumerate(cases):
    exp = case["expect"]
    if exp.get("total") is None or exp.get("merchant") is None: continue
    lines = text_of(case)
    cjk = any(ord(ch) > 0x2E80 for l in lines for ch in l)
    base = render(lines, cjk)
    variants = {
        "clean": base,
        "rotated": base.rotate(2.5, expand=True, fillcolor=250),
        "blurred": base.filter(ImageFilter.GaussianBlur(1.6)),
        "low_contrast": ImageEnhance.Contrast(base).enhance(0.35),
        "cropped": base.crop((0, 0, base.width, int(base.height * 0.7))),
    }
    for name, img in variants.items():
        path = os.path.join(out, f"case{index:02d}_{name}.png")
        img.convert("RGB").save(path)
        manifest.append({"case": index, "name": case["name"], "variant": name, "path": path, "options": case.get("options", {}), "expect": exp})
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), ensure_ascii=False, indent=1)
print(len(manifest), "images")
