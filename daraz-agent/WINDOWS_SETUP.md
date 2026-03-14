# 🪟 Windows Setup Guide — Daraz Daily Agent

## Prerequisites

### 1. Install Python
Download from [python.org](https://python.org/downloads/) — **check "Add Python to PATH"** during install.

### 2. Verify Python works
Open **Command Prompt** and run:
```
python --version
```
Should print `Python 3.10+`

---

## Quick Setup (Recommended)

1. Extract all files into a folder, e.g. `C:\DarazAgent\`
2. Right-click `setup_windows.bat` → **Run as administrator**
3. Edit `.env` with your OpenAI key (see below)
4. Test: double-click `run_agent.py` or open CMD and run:
   ```
   python C:\DarazAgent\run_agent.py
   ```

---

## Add Your OpenAI API Key

Open `.env` in Notepad:
```
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxx
```
Save the file.

---

## Manual Task Scheduler Setup

If the `.bat` file doesn't work, set it up manually:

1. Press **Win + S** → search **"Task Scheduler"** → open it
2. Click **"Create Basic Task..."** in the right panel
3. Fill in:
   - **Name:** `DarazDailyAgent`
   - **Trigger:** Daily → Start time: `7:00 AM`
   - **Action:** Start a program
     - **Program:** `python`  
     - **Arguments:** `C:\DarazAgent\run_agent.py`
     - **Start in:** `C:\DarazAgent\`
4. Click Finish

### To verify it's registered:
- In Task Scheduler → Task Scheduler Library → find `DarazDailyAgent`
- Right-click → **Run** to test it immediately

---

## Where Are My Reports?

Reports are saved in the `reports\` subfolder:
```
C:\DarazAgent\
  └── reports\
        ├── daraz_report_2025-03-10.html   ← opens in browser
        └── daraz_report_2025-03-10.pdf    ← if weasyprint installed
```

Each day gets its own file. The HTML opens automatically in your browser.

---

## Optional: Get PDF Reports Too

Install WeasyPrint for PDF output:
```
pip install weasyprint
```
> Note: WeasyPrint on Windows may require GTK. If installation is complex,
> the HTML report alone is fully usable (print to PDF from browser with Ctrl+P).

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `python not found` | Re-install Python with "Add to PATH" checked |
| `ModuleNotFoundError` | Run `pip install -r requirements.txt` in CMD |
| Task runs but no report | Check `agent.log` in the agent folder |
| Blank products in report | Daraz may have updated their HTML — check `agent.log` |
| OpenAI error | Verify your API key in `.env` has credits |

---

## Checking Logs

Open `agent.log` in Notepad to see what happened during the last run.

Or in CMD:
```
type C:\DarazAgent\agent.log
```
