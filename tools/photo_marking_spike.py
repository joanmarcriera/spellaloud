#!/usr/bin/env python3
"""Research spike (Vikunja #3544): can a local vision model transcribe a child's spelling
attempts EXACTLY (misspellings preserved, never auto-corrected)?

Usage: python3 tools/photo_marking_spike.py [--model qwen2.5vl:7b] [--endpoint URL] [--runs N]

Renders a synthetic "child's page" (numbered lines, marker-style font, slight rotation and noise)
containing deliberate misspellings, sends it to an Ollama vision model and scores exact line matches.
SYNTHETIC DATA ONLY: never feed real children's photos to a cloud model. Needs Pillow + macOS fonts.
"""
import argparse, base64, io, json, random, re, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# (target word, what the child wrote). Mix of correct, phonetic errors, reversals, near-misses.
ITEMS = [("because", "becos"), ("friend", "freind"), ("said", "sed"), ("they", "thay"),
         ("people", "peeple"), ("beautiful", "beutiful"), ("which", "which"), ("went", "went"),
         ("necessary", "neccesary"), ("because", "becuase")]
FONTS = ["/System/Library/Fonts/MarkerFelt.ttc", "/System/Library/Fonts/Supplemental/ChalkboardSE.ttc"]

def render(seed, font_path):
    rnd = random.Random(seed)
    img = Image.new("RGB", (900, 120 * len(ITEMS) + 60), (250, 248, 240))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font_path, 54)
    for i, (_, w) in enumerate(ITEMS):
        y = 40 + i * 120
        d.line([(30, y + 85), (870, y + 85)], fill=(150, 170, 220), width=2)
        d.text((40, y), f"{i+1}.", font=f, fill=(40, 40, 40))
        d.text((140 + rnd.randint(-6, 6), y + rnd.randint(-5, 5)), w, font=f, fill=(30, 30, 90))
    img = img.rotate(rnd.uniform(-2, 2), fillcolor=(250, 248, 240)).filter(ImageFilter.GaussianBlur(0.8))
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=70)
    return buf.getvalue()

PROMPT = ("This is a child's spelling test page. Transcribe each numbered line EXACTLY as written, letter by letter. "
          "Do NOT correct spelling mistakes. Output one line per number in the form `N: word`, nothing else.")

def ask(endpoint, model, jpg):
    body = json.dumps({"model": model, "stream": False, "options": {"temperature": 0},
                       "messages": [{"role": "user", "content": PROMPT, "images": [base64.b64encode(jpg).decode()]}]}).encode()
    req = urllib.request.Request(endpoint + "/api/chat", body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))["message"]["content"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen2.5vl:7b"); ap.add_argument("--endpoint", default="http://192.0.2.10:30068")
    ap.add_argument("--runs", type=int, default=3)
    a = ap.parse_args()
    exact = corrected = total = 0
    for run in range(a.runs):
        for fp in FONTS:
            out = ask(a.endpoint, a.model, render(run, fp))
            got = {int(m.group(1)): m.group(2).strip().lower() for m in re.finditer(r"^\s*(\d+)\s*[:.)]\s*(\S+)", out, re.M)}
            for i, (target, wrote) in enumerate(ITEMS, 1):
                total += 1
                g = got.get(i, "")
                if g == wrote: exact += 1
                elif g == target and wrote != target: corrected += 1
                print(f"run{run} {fp.split('/')[-1][:8]} #{i} wrote={wrote:10} got={g:10} {'OK' if g==wrote else ('AUTOCORRECTED' if g==target else 'MISREAD')}")
    print(f"\nexact {exact}/{total}; silently corrected {corrected}; other misreads {total-exact-corrected}")

if __name__ == "__main__":
    main()
