# NEXUS — First-Time Setup (Simple Guide)

Everything here is **100% free**. No account, no subscription, no credit card, ever.

---

## Step 0 — Install it (once)

1. Install **Bun** (free): 👉 https://bun.sh — on Windows, open PowerShell and paste the one-line installer from that page.
2. Get Nexus: on the GitHub page click **Code → Download ZIP** and unzip it (or `git clone` it).
3. Open the Nexus folder, click the address bar, type `cmd`, press **Enter**, and run:

   ```
   bun install
   ```

## How to open Nexus (the only thing you must know)

**Double-click the file `Start Nexus.cmd`** in the Nexus folder.

- A black window opens (that's the engine — **keep it open**).
- Your browser opens **http://localhost:1420** automatically after a few seconds.
- To **close** Nexus: close the black window.

---

## Step 1 — The brain (a free AI model on your own PC)

Nexus thinks using **Ollama**, a free program that runs AI models on your own computer. Without it, every typed
command still works — only free-form chat and AI-written briefs need it.

1. Install Ollama: 👉 **https://ollama.com/download**
2. Open any terminal and pull one chat model — pick by your computer's memory:

   ```
   ollama pull llama3.2:3b
   ```
   (8 GB RAM or less) — or, with 16 GB or more, `ollama pull qwen2.5:7b-instruct-q4_K_M`.

3. Give Nexus long-term memory (~270 MB, one time):

   ```
   ollama pull nomic-embed-text
   ```

Nexus finds whatever compatible model you have — it never forces a download.

---

## Step 2 — Make it yours (1 minute)

A fresh Nexus knows **nothing** about you. Press **Ctrl+K** and type:

```
setup
```

It shows a short checklist. Then tell it who you are and what you're working toward:

```
setup name Sam
setup goal Ship my first app by June
setup goal Read 12 books this year
```

Optional modules start **off**. Type `modules` to see them, and turn on the ones you want (then restart Nexus):

| Module | For | Turn on |
|---|---|---|
| `academics` | CAIE A Level students (Physics 9702, Maths 9709, CS 9618): past papers, chapters, exam countdown | `modules on academics` |
| `scholarships` | Students: a daily sweep of free undergraduate-scholarship feeds | `modules on scholarships` |
| `agency` | Freelancers: leads → clients → projects → payments | `modules on agency` |

Then type `audit` — a health check that says exactly what (if anything) to fix. `help` lists every command.

---

## Step 3 — The voice (optional)

Want to **hold Space and talk** to Nexus, and have it **talk back**? Download these 4 free files and drop them all into this folder:

```
apps\shell\src-tauri\binaries\
```

**Ears (speech → text):**

1. **whisper program** — download `whisper-bin-x64.zip` from
   👉 https://github.com/ggerganov/whisper.cpp/releases/latest
   Unzip it and copy `whisper-cli.exe` (plus any `.dll` files next to it) into the folder above.
2. **whisper model** — direct download (148 MB):
   👉 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

**Mouth (text → speech):**

3. **Piper program** — download `piper_windows_amd64.zip` from
   👉 https://github.com/rhasspy/piper/releases/latest
   Unzip and copy `piper.exe` (plus its files) into the folder above.
4. **Piper voice** — direct downloads (both files, ~60 MB):
   👉 https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
   👉 https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

Skip this entirely if you don't care about voice — Nexus shows `STT · NOT INSTALLED` and everything else works fine.

---

## Step 4 — Connections (optional)

Nexus works fully offline with **zero** accounts connected. Skip this step entirely if you want.

**Where:** open Nexus → click **⚙ SETTINGS** in the top-right corner (under the clock). Every connection below is a form in that panel.

**Notion** (so Nexus can search/create your Notion pages):
1. Go to 👉 https://www.notion.so/my-integrations → **New integration** → name it "Nexus" → copy the **Internal Integration Secret** (starts with `ntn_` or `secret_`).
2. In Notion, open the page you want Nexus to use → `···` menu → **Connections** → add "Nexus".
3. In Nexus: ⚙ SETTINGS → NOTION → paste the token → **CONNECT NOTION**.

**Google Calendar + Gmail:**
1. Go to 👉 https://console.cloud.google.com → create a project → enable the **Calendar API** and **Gmail API** → **Credentials → Create credentials → OAuth client ID → Desktop app** → copy the Client ID + Client secret.
2. In Nexus: ⚙ SETTINGS → GOOGLE → paste both → **CONNECT GOOGLE** → a normal Google login tab opens → approve.

**Any other email (IMAP):** ⚙ SETTINGS → EMAIL → your provider's IMAP host, your email, and an **app password** (search "app password" in your mail provider's help) → **CONNECT IMAP**.

**YT WEEK button:** ⚙ SETTINGS → INTEL → paste YouTube channel IDs (comma-separated) → **SAVE CHANNELS**. Free public feeds, no API key.

Buttons that need a connection say **CONNECT TO ENABLE** until you do — nothing breaks.

---

## Step 5 — Make it a real desktop app (optional, advanced)

Right now Nexus runs in your browser (which is fine!). To turn it into an installed Windows app with its own window and tray icon, you need the free Rust compiler once:

1. Install Rust: 👉 https://rustup.rs (also installs Visual Studio Build Tools when prompted)
2. In the Nexus folder run: `bun run build:runner`
3. Copy `packages\runner\out\nexus-runner.exe` to `apps\shell\src-tauri\binaries\nexus-runner-x86_64-pc-windows-msvc.exe`
4. Run: `cd apps\shell\src-tauri` then `cargo install tauri-cli` then `cargo tauri build`
5. Your installer appears in `target\release\bundle\`

---

## Where is my stuff saved?

Everything lives in one folder on your PC: **`C:\Users\<you>\.nexus\`** — never in the Nexus folder you downloaded,
so the code holds nobody's data and updating it never touches yours.

- `brain\` — who you are (`knowledge\user.md`), your goals (`knowledge\mission.md`), Nexus's personality
  (`identity.md`) and its long-term memories — plain text files you can read and edit
- `vault\` — every report/plan Nexus writes, as normal markdown files you can open anywhere
- `nexus.db` — its database (trackers, history, metrics)
- Nothing is ever uploaded anywhere: Nexus only listens on your own computer (`127.0.0.1`), behind a random key that
  only your HUD knows. Delete that folder = factory reset.
