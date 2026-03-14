# Daraz Daily Agent 🛒

Automated product & supplier intelligence for **Daraz.lk** (Sri Lanka).

- Scrapes top products and suppliers daily using Daraz's JSON API
- Filters: local sellers, Rs. 3,000+, 4★+ rating, ranked by popularity
- Generates beautiful HTML reports with AI market analysis (OpenAI GPT-4o-mini)
- Finds supplier phone numbers via SerpAPI
- Runs as a web dashboard on Render (or locally on Windows)

---

## 🚀 Deploy to Render (Web Dashboard)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/daraz-agent.git
git push -u origin main
```

### 2. Create a Render Web Service

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Environment:** Python
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn web_app:app --bind 0.0.0.0:$PORT --workers 1 --timeout 300`
4. Add **Environment Variables** (in Render dashboard → Environment):
   ```
   OPENAI_API_KEY   = sk-proj-your-real-key-here
   SERP_API_KEY     = your-serpapi-key-here
   ```
5. Click **Deploy**

Your dashboard will be live at `https://your-service.onrender.com`

---

## 💻 Run Locally (Windows)

### Quick setup
1. Copy `.env.example` → `.env` and fill in your API keys
2. Run `setup_windows.bat` as Administrator (installs deps + schedules daily task)
3. Test: `python run_agent.py`

### Manual install
```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your keys
python run_agent.py          # product report
python darazpartner.py       # supplier report (interactive)
python web_app.py            # local web dashboard on http://localhost:5000
```

---

## 📁 Project Structure

```
daraz-agent/
├── daraz_agent.py       # Product scraper & ranker
├── darazpartner.py      # Supplier scraper & contact finder
├── web_app.py           # Flask web dashboard (for Render)
├── run_agent.py         # Windows CLI entry point
├── test_api.py          # Test your OpenAI key
├── requirements.txt
├── Procfile             # Render start command
├── .env.example         # Environment variable template
├── .gitignore
├── setup_windows.bat    # Windows one-click setup
└── WINDOWS_SETUP.md     # Detailed Windows guide
```

---

## 🔑 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ Yes | For GPT-4o-mini market analysis |
| `SERP_API_KEY` | ⚠️ Optional | For finding supplier phone numbers |

Get keys:
- OpenAI: https://platform.openai.com/api-keys
- SerpAPI: https://serpapi.com

---

## ⚠️ Notes

- Reports and logs are **not persisted** on Render's free tier (ephemeral filesystem). Run the agent and download reports before the instance restarts. For persistence, connect a [Render Disk](https://render.com/docs/disks).
- The supplier agent's interactive mode (typing a category) is only available locally. On Render it runs in **daily auto mode**.
