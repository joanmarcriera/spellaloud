# Moving from the home-server build to the browser app

For a family that ran the old home-server ("family") build (`ash.<home>` / `finn.<home>`, SQLite on the NAS) and
now uses the browser-only app. Nothing on the server is changed; keep it running until step 4 is checked.

## 0. Stop the old app first

Stop it before exporting, so no practice is saved on the server after the copy (TrueNAS: Apps > spellings > Stop,
or `midclt call app.stop spellings`). Keep the dataset: it stays covered by the snapshots and is the fallback.

## 1. Export on the server (read-only)

    # on the NAS / host that holds SPELLING_DATA_DIR
    python3 tools/export_family.py --data-dir /mnt/BigDisk/applications/spellings/data --check   # counts only
    python3 tools/export_family.py --data-dir /mnt/BigDisk/applications/spellings/data --out spellings-family.spellings

One file holds every child: names, years, settings, weeks (and any term a parent picked), words, recordings
(child voice vs read-aloud kept apart), every session and result, and the "I know it" marks. Use `--kid ash`
for one child. A warning is printed for any word whose recording file is missing; the word is still exported.

## 2. Import on the wall display / tablet

Open the app's Grown-ups page on that device → **Back up / move to another device** → **Import a file** → choose
the file → **The children in the file** → **Replace everything here** (fresh device) or **Add to what is here**.
The preview line shows the weeks, words, recordings and sessions it is about to add: compare it with step 1.

Each browser keeps its own copy. Import on every device the children use (wall display, phone), or pick one.

## 3. Change the wall-board links

Old: `https://ash.<home>/` and `https://finn.<home>/` (hostname picked the child).
New: `<app>/?kid=ash&name=Ash` and `<app>/?kid=finn&name=Finn`, where `<app>` is the public app address.

After step 2 the children already exist on the device, so the tile opens straight into the child's Home.
Remove any wall-board note that says a child "needs to be created / set up first": that was only for a fresh
device, and the app now shows its own one-tap set-up screen in that case.
Fully Kiosk: allow the new host for the microphone (`microphoneAccess`), as was done for the old hostnames.

## 4. Check, then retire

On the wall display: each child's stars and streak match the old app, *This week* plays, a recorded word plays
in the child's voice. Then disable the old proxy hosts and take a first backup from the wall display
(Grown-ups > Back up / move to another device). Keep the NAS dataset; restart the app there to roll back.
