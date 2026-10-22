# טופסי התחייבות: Commitment forms to Excel

Turns a stack of lab commitment forms (scanned PDFs, phone photos, handwriting) into an RTL Excel sheet with one row per commitment and 7 fields. Every field gets a confidence level (ok / review / empty). A review screen shows the form image beside the table, so the fields that need checking can be confirmed or fixed quickly.

Product docs live in `agent-os/product/`. The build spec is in `agent-os/specs/2026-10-15-2332-phase1-mvp-form-extraction/`.

## Run

```bash
cp .env.example .env        # then set ANTHROPIC_API_KEY
docker compose up --build
```

Open **http://localhost:8080**.

Everything runs locally. The only external call is the Claude API, and it receives only the page image. Uploaded files and the SQLite DB live in `./data/`, which git ignores.

## Use

1. **Upload:** drop one file or many (PDF, JPG, PNG, HEIC). Each file shows a progress bar, and the app moves to review when processing finishes.
2. **Review:** fields waiting for review are orange. Hover a field to see why it was flagged.
   - **Enter** confirms the field, or saves your edit, and jumps to the next orange field. **Esc** cancels.
   - Pressing Enter outside a field starts from the first orange field.
   - Edits are saved to the server immediately.
   - "רק לבדיקה" (review only) filters the table to forms that still need review.
   - Use the zoom and rotate buttons on the image as needed.
   - A failed form has a "נסה שוב" (Try again) button.
3. **Export:** downloads the xlsx. You get a warning if orange fields remain. Batch delete removes the files and all records.

## Speed, users, patient file and rules (roadmap 2ד)

### Speed
- **Every page in parallel.** All pages of all files are sent at once, up to `extract.concurrency` (16) calls on the server. With `extract.adaptive`, the limit halves on a rate limit (honouring `retry-after`) and creeps back up.
- **Review while reading.** Each page is saved and shown for review right after validation (`early_save`). Localize and the double check finish in the background ("בדיקה כפולה ברקע") and update only fields nobody touched. The processing screen jumps to review at the first ready page (a checkbox keeps you there). Enter after the last flagged field waits for the next page.
- **Lighter calls.** A model per stage (`models:`), forced tool use where the model supports it (about 4x faster on Haiku, never a reply in prose), prompt caching of the system prompt and tool schema, JPEG crops capped at 1568 px, and the page halves read in parallel.
- **Live updates.** `GET /api/batches/{id}/events` (SSE) tells the screens to refetch. Polling slows to 5 s while it is connected, and the poll no longer loads image blobs.
- **Measured** on the 6-page sample PDF: first page reviewable after 15.6 s, the whole file done in 52.6 s, with no retries. Earlier runs of the same file took 38–437 s (median about 2 minutes).

### Users and roles
- **Roles:** `intake`, `approver`, `lab_manager` and `admin`. A user may hold several roles.
- **Admin screen:** at `/admin/users`. Create, edit and reset passwords. Deactivation is a soft delete, and history stays. The last admin cannot be removed.
- **Sign-out:** a password reset, role change or deactivation signs the user out everywhere (`token_version`).
- **First admin:** `admin1` (with `DEMO_PASSWORD`) is created when no active admin exists.

### Live user guide
- **The "?" button** in the header opens a menu: the tour for the user's role, a guide for another role, or "continue where I stopped".
- **Tour:** a step-by-step walk that moves between the real screens and highlights the relevant element, per role (intake, approver, lab manager, admin). It shows in the UI language, and a role the user does not hold shows explanations only.
- **First sign-in:** a welcome screen offers the tour, until the user ticks "don't show again".
- **Code:** `frontend/src/guide/`. Steps and their anchors are in `steps.ts` (anchors are `data-guide` attributes on the screens); texts are in `frontend/src/i18n/locales/guide.ts`, in every UI language.

### Patient file
- **Screens:** `/patients` (search by ID, name or commitment number) and `/patients/{id}`.
- **Automatic filing:** forms are filed by normalized ID automatically only when the ID is valid and was read with confidence.
- **Suggested links:** anything weaker is a suggestion to confirm or reject. A person's decision is final.
- **Referrals and other medical pages:** they get one light read on the `document` model (ID, name, date, kind, test, referral number).
- **Audit:** viewing a file is recorded in the audit log.

### Validation rules in plain Hebrew
- **Where:** `/rules` (lab manager or admin).
- **Converting:** write e.g. "אם הקופה מכבי והבדיקה PCR – חובה מספר הפניה". Claude turns it into a structured rule, and the explanation is generated from that rule. Unknown terms become a question, never a guess.
- **Dry run:** shows "הכלל היה מסמן N טפסים" on the current data before anything changes.
- **At run time:** the rules run deterministically in the validate stage and flag the field (`rule:<id>`). They never change a value.
- **When activated:** a rule can also flag open forms. Approved forms are never touched.
- **New fields:** the forms now also read `test_type` and `referral_number`. They are optional, an empty one never holds a form back, and they are not exported unless added to `export.yaml`.

## Configuration (no code changes needed)

| File | What |
|---|---|
| `config/pipeline.yaml` | stage order, concurrency (`adaptive`), model per stage (`models:`), `early_save`, `documents.read`, retries, confidence bands, double-check on/off and scope, `extract.verifier` (a second model for the independent re-read) |
| `config/senders.yaml` | closed list of senders with aliases, and the fuzzy-match threshold |
| `config/export.yaml` | Excel columns (order and Hebrew headers), date format, separator |
| `.env` | `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-sonnet-5-5`) |

### How confidence works

A field's level comes from its **final confidence**, built from evidence rather than the model's own score (which is usually "100%"): the independent second read of every value (agreement lifts it, disagreement caps it at 60%), a failed validation (ID check digit, invalid or future date) caps it, and handwriting is never accepted after one read. **Under 50%** the value is dropped and the field says *not identified*; **50-80%** goes to an intake clerk; **from 80%** it is approved automatically (`confidence:` in `pipeline.yaml`). A sender not in the list, or a lab rule, still sends the field to a person. A department ("מחלקת פנימית ב' לניאדו") is filed under its hospital.

With `double_check.enabled`, fields flagged only by soft signals (low confidence or illegible) get a second, focused read. If both reads agree, the field becomes ok. Validation failures always stay orange.

## Pipeline

`ingest → preprocess → split → classify → extract → normalize → validate → localize → confidence`

Each stage has its own file in `backend/pipeline/stages/` and implements `run(form, ctx)`. To add a capability, write a stage class and add a line to `config/pipeline.yaml`.

## Learning from corrections

Every manual fix of a field is stored (`Correction`) with what the model read and what the human says is right. Once the form is **approved** (a second pair of eyes), the fix becomes a lesson (`backend/pipeline/learning.py`), re-read at the start of every batch:

- **Sender spellings** that were always fixed to the same canonical name on at least 2 forms are mapped directly (shown as "Value from earlier corrections").
- **The extraction prompt** lists recurring mistakes: confused characters in ID / name, values missed or invented, sender and date examples. Never a patient's name or ID.
- **Fields the model gets wrong while confident** (10%+ of recent approved forms) always go to review ("Often wrong before").

Only the latest 500 corrections count, so a lesson fades once the mistake stops. Reset or editing back to the model's value removes the correction; a retry keeps it. Tune or switch off under `learning:` in the pipeline config. The manager sees the current lessons at `GET /api/learning`.

## Edge cases

A problem with one file or page never stops the batch. Problems are stored as codes (`error_code`, `warnings`, form `reasons`), and the UI translates them.

- **Bad uploads.** These fail alone, with a clear reason:
  - empty file
  - damaged or cut-off file
  - password-protected PDF
  - too many pages
  - image too large
  - content that doesn't match the extension

  A partly damaged PDF keeps its good pages and warns that pages are missing. A cut-off image is read as far as it goes and sent to review.
- **What is on the page.** The orientation check also classifies each page:
  - commitment
  - continuation page
  - other medical document
  - unrelated
  - blank

  Only commitments are read. The other pages are listed apart in review, with an "It is a commitment" override, and they are never exported.
- **One commitment over several pages.** A continuation page is merged into the form before it:
  - empty fields are filled from it
  - number lists are combined
  - conflicting values go to review

  Review can split the pages again or merge a page with the previous one.
- **Several commitments on one page.** Each one becomes its own form, read from a crop of its region, and goes to review.
- **Slow or unreliable uploads.** Each file is uploaded on its own (`POST /api/batches/open`, then `POST /api/batches/{id}/files` per file). A stalled upload is retried, and you can cancel. Each file is read as soon as it arrives.
- **Slow scanning.** A page stuck in one stage longer than `extract.stage_timeout_seconds` fails alone and can be retried.
- **API down.** A bad API key, no credit or no connection pauses the batch once, with a message, and you resume once it's fixed.
- **Server restart.** Pages interrupted by a restart are marked `interrupted`. "Retry everything that failed" re-reads them.
- **Review while scanning.** Forms that are done can be opened from the processing screen and corrected while the rest are still being read. A poll never overwrites a field being edited.
- **Other safeguards:**
  - The same file uploaded twice gets a warning.
  - A commitment number already seen on another form gets a warning.
  - A form with no values at all gets a warning.
  - Two people editing the same field get a conflict message instead of a silent overwrite.
  - Retrying a form asks for confirmation first if it has manual fixes.

Every behavior can be tuned under `preprocess`, `classify`, `regions`, `merge_pages` and `extract` in the pipeline config.

## Tests and accuracy

```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Linux/mac: .venv/bin/pip
.venv/Scripts/python -m pytest
```

Accuracy eval: put 10–15 forms in `eval/samples/`, and their correct values in `eval/ground_truth.csv`. Use one row per page and separate multiple values with `;`. Then run:

```bash
backend/.venv/Scripts/python -m eval.run          # from the repo root
# or inside Docker:
docker compose exec -w /app backend python -m eval.run
```

The report (`eval/report.md`) lists per-field accuracy, **hidden errors** (marked ok but wrong; the target is 0), flag rate, and false empties.

## Networks that intercept HTTPS (NetFree, antivirus, corporate proxy)

If installs or Claude calls fail with `CERTIFICATE_VERIFY_FAILED` or `APIConnectionError`:

- **Claude API at runtime:** put the filter's root certificate at `certs/ca.crt` and add `SSL_CERT_FILE=/certs/ca.crt` to `.env`. For local runs outside Docker, use the local path instead.
- **Docker builds:** add these to `.env`, then rebuild:
  ```
  PIP_EXTRA_ARGS=--trusted-host pypi.org --trusted-host files.pythonhosted.org
  NPM_EXTRA_ARGS=--strict-ssl=false
  ```

## Local development without Docker

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
cd frontend && npm install && npm run dev      # http://localhost:5173, proxies /api to :8000
```
