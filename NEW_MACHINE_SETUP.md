# cursor_backtest — New Machine Setup

Single guide to move this project from one PC to another and run it under Cursor.

**Private repo:** https://github.com/elangomanjiny/cursor_backtest  
**Branch:** `main`

---

## 1. What is *not* in `requirements.txt`

`requirements.txt` only installs **Python libraries** for the app.

| Tool | In `requirements.txt`? | Purpose |
|------|------------------------|---------|
| Git | No | Clone / push code |
| GitHub CLI (`gh`) | No | Auth + clone private repo |
| Python 3.11+ | No | Run backend / create `.venv` |
| Node.js 18+ (LTS) | No | Build React UI (`webapp`) |
| Cursor | No | IDE |
| FastAPI, pandas, uvicorn, … | **Yes** | App runtime (via pip) |
| React / Vite deps | No — in `webapp/package.json` | UI (via npm) |

Market data (`data/`) and QuestDB (`tools/questdb/`) are **not** in git. Copy them separately or re-download / reinstall.

---

## 2. Install system tools (once per machine)

### Windows (winget)

```powershell
winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
```

Then install **Cursor** from https://cursor.com

Close and reopen the terminal (or Cursor) so `git`, `gh`, `python`, and `node` are on `PATH`.

### Verify

```powershell
git --version
gh --version
python --version
node --version
npm --version
```

---

## 3. Git identity (once per machine)

```powershell
git config --global user.name "elangomanjiny"
git config --global user.email "elangomanjiny@gmail.com"
```

---

## 4. Log in to GitHub CLI (once per machine)

Browser login to github.com alone is **not** enough. The CLI needs its own login:

```powershell
gh auth login
```

Choose:

1. **GitHub.com**
2. **HTTPS**
3. **Login with a web browser**
4. Enter the one-time code at https://github.com/login/device

Check:

```powershell
gh auth status
```

You should see: `Logged in to github.com account elangomanjiny`

---

## 5. Clone the project

```powershell
cd E:\
gh repo clone elangomanjiny/cursor_backtest
cd cursor_backtest
```

Or open Cursor → **Clone repo** → `https://github.com/elangomanjiny/cursor_backtest.git`  
(You must be logged into GitHub in Cursor / `gh` for a private repo.)

---

## 6. Optional: copy market data from the old PC

On the **old** machine, copy:

```text
E:\cursor_backtest\data\
```

to the **new** machine:

```text
<your-clone>\data\
```

(~850 MB ticks/bars). If you skip this, use **Data Loader** in the UI to download ranges again.

---

## 7. Python virtualenv + dependencies

```powershell
cd E:\cursor_backtest   # or your clone path
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

---

## 8. Frontend build

```powershell
cd webapp
npm install
npm run build
cd ..
```

Rebuild whenever you change UI source under `webapp/src/`.

---

## 9. Start the app

```powershell
cd E:\cursor_backtest
.\.venv\Scripts\uvicorn.exe backend.app.main:app --app-dir . --reload --port 8000
```

Open: **http://127.0.0.1:8000/**

---

## 10. Optional: QuestDB

QuestDB is **not** in the git repo (`tools/questdb/` is ignored).

- If you need it, reinstall QuestDB or copy `tools/questdb` from the old PC.
- Helper script (if present): `scripts/setup_questdb.ps1`
- Health check may show QuestDB status on `/api/health`.

The core backtest can run without QuestDB for parquet-based flows.

---

## 11. Prompt to paste into a new Cursor chat

After the folder is open in Cursor, paste:

```text
This is my project: https://github.com/elangomanjiny/cursor_backtest (private).

Help me set it up on this machine:
1. Confirm the repo is cloned (or clone with `gh repo clone elangomanjiny/cursor_backtest`)
2. Create Python venv and install requirements.txt
3. In webapp: npm install && npm run build
4. Start uvicorn: .\.venv\Scripts\uvicorn.exe backend.app.main:app --app-dir . --reload --port 8000
5. Open http://127.0.0.1:8000/

Context: local volume-delta research terminal (Binance UM → parquet → Python hybrid sim → FastAPI → React).
Optimize UI: After / Before / Flat + Time opt Step 30m/1h.
Performance tab: FinTech overview dashboard.
Market data folder `data/` may be missing — load via Data Loader or copy from old PC.

Do not commit unless I ask.
```

---

## 12. Day-to-day sync between machines

### On machine A (after changes)

```powershell
cd E:\cursor_backtest
git add -A
git status
git commit -m "Describe why you changed this"
git push
```

### On machine B

```powershell
cd E:\cursor_backtest
git pull
cd webapp
npm install
npm run build
cd ..
```

Re-run `pip install -r requirements.txt` only if `requirements.txt` changed.

---

## 13. What git tracks vs ignores

| Tracked (in GitHub) | Ignored (local only) |
|---------------------|----------------------|
| `backend/` | `.venv/` |
| `webapp/src/`, configs | `webapp/node_modules/`, `webapp/dist/` |
| `scripts/`, `requirements.txt` | `data/`, `*.parquet` |
| `README.md`, this guide | `tools/questdb/`, `logs/` |

---

## 14. Quick troubleshooting

| Problem | Fix |
|---------|-----|
| `gh` / `git` not found | Reopen terminal after install; check PATH |
| `gh auth` fails | Run `gh auth login` again (browser device code) |
| Private clone denied | Must be logged in as `elangomanjiny` |
| UI looks old | `cd webapp; npm run build` |
| No bars in range | Load data in UI or copy `data/` from old PC |
| Cursor / PC very slow | Low RAM (4 GB is tight). Close Chrome; use `workers=1–2` on optimize |
| Port 8000 in use | Stop old uvicorn, or use another port |

---

## 15. Checklist

- [ ] Git, GitHub CLI, Python 3.11+, Node.js, Cursor installed  
- [ ] `gh auth login` completed  
- [ ] Repo cloned  
- [ ] (Optional) `data/` copied  
- [ ] `.venv` + `pip install -r requirements.txt`  
- [ ] `webapp` → `npm install` + `npm run build`  
- [ ] uvicorn running → http://127.0.0.1:8000/  

---

*Last updated for the private GitHub handoff of `cursor_backtest`.*
