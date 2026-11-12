#!/usr/bin/env python3
"""Render synthetic "school spelling sheet" images for the Tesseract.js OCR spike (Vikunja #3538).

Usage: python3 tools/ocr_wordlist_spike.py OUT_DIR      -> OUT_DIR/sheet{1..4}.png + truth.json
Then:  node tools/ocr_wordlist_spike.mjs OUT_DIR        (needs `npm i tesseract.js@5` in a scratch dir)

SYNTHETIC DATA ONLY (header text, noise, slight rotation, blur, JPEG-ish noise). No real photos, no
network upload: the OCR runs locally in Node/WASM, mirroring what the browser version would do.
Needs Pillow + macOS fonts.
"""
import json, os, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

WORDS = [
    ["because", "friend", "people", "beautiful", "necessary", "different", "though", "through", "thought", "enough", "answer", "build"],
    ["said", "they", "were", "where", "there", "their", "some", "come", "once", "any", "many", "most"],
    ["accident", "actual", "address", "appear", "bicycle", "breath", "calendar", "caught", "centre", "circle", "complete", "describe"],
    ["cat", "dog", "run", "sun", "hat", "big", "red", "pen", "sit", "top"],
]
FONTS = ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf", "/System/Library/Fonts/Supplemental/Georgia.ttf"]

def render(i, words, rng):
    W, H = 1200, 1600
    im = Image.new("L", (W, H), 245)
    d = ImageDraw.Draw(im)
    f_big = ImageFont.truetype(FONTS[i % len(FONTS)], 54)
    f = ImageFont.truetype(FONTS[i % len(FONTS)], 46)
    d.text((80, 70), f"Spelling words - Week {i + 5}", font=f_big, fill=30)
    d.text((80, 150), "Year 3  Mrs Patel   Test on Friday", font=f, fill=70)   # header noise, not words
    d.line((80, 230, W - 80, 230), fill=120, width=3)
    for n, w in enumerate(words):
        col, row = divmod(n, (len(words) + 1) // 2)
        d.text((100 + col * 560, 290 + row * 120), f"{n + 1}. {w}", font=f, fill=25)
    d.text((80, H - 140), "Please practise 10 minutes each night.", font=f, fill=90)
    im = im.rotate(rng.uniform(-2, 2), fillcolor=235, resample=Image.BICUBIC)
    im = im.filter(ImageFilter.GaussianBlur(0.9))
    px = im.load()
    for _ in range(40000):                                   # speckle like a phone photo
        x, y = rng.randrange(W), rng.randrange(H)
        px[x, y] = max(0, min(255, px[x, y] + rng.randint(-35, 35)))
    return im

if __name__ == "__main__":
    out = sys.argv[1]; os.makedirs(out, exist_ok=True); rng = random.Random(3538)
    truth = {}
    for i, words in enumerate(WORDS):
        name = f"sheet{i + 1}.png"; render(i, words, rng).save(os.path.join(out, name)); truth[name] = words
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
    print(f"wrote {len(truth)} sheets to {out}")
