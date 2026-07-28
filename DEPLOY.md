# Deploying ScrumStage so anyone in the world can test it

This deploys the whole app (frontend + API + course content + database) to
**Render** on its **free tier**. You get a public `https://…onrender.com`
address that opens from any country. No credit card required to start.

Testers don't need to register — the app creates a guest session automatically,
so they can start the course immediately.

The setup uses two files already added to this folder:
- `Dockerfile.render` — builds everything into a single container.
- `render.yaml` — tells Render to create one web service + one Postgres database.

---

## What you need
- A free **GitHub** account — https://github.com
- A free **Render** account — https://render.com (sign up with GitHub)

## Step 1 — Put this folder on GitHub

Open a terminal **inside this folder** (`Interactive-Learning-Platform`) and run:

```bash
git init
git add .
git commit -m "ScrumStage — ready for Render"
```

Create an empty repo on GitHub (github.com → New repository, e.g.
`scrumstage`, leave it empty — no README), then connect and push:

```bash
git remote add origin https://github.com/<your-username>/scrumstage.git
git branch -M main
git push -u origin main
```

## Step 2 — Deploy on Render

1. Go to https://dashboard.render.com
2. Click **New +** → **Blueprint**.
3. Connect your GitHub and pick the `scrumstage` repo.
4. Render reads `render.yaml` and shows a plan: one web service
   (`scrumstage`) + one Postgres database (`scrumstage-db`).
5. Click **Apply**.

Render now builds the Docker image and starts the database. The first build
takes about 3–5 minutes. On first start the backend **creates its own database
tables automatically** (migrations run on boot) — you don't do anything.

## Step 3 — Share the link

When the service shows **Live**, its URL is at the top of the service page,
something like:

```
https://scrumstage.onrender.com
```

Send that link to anyone — it works worldwide over HTTPS.

---

## Good to know (free tier)

- **Sleeps when idle.** A free web service goes to sleep after 15 minutes with
  no traffic. The next visit wakes it and takes ~1 minute to load, then it's
  fast again. Fine for testing; upgrade to a paid instance (~\$7/mo) to keep it
  always on.
- **Database lifespan.** The free Postgres is 1 GB and lasts **30 days**, then a
  14-day grace period before it's deleted. For a longer test, upgrade the
  database in Render (from ~\$7/mo) — your data is kept.
- **Updates deploy themselves.** `autoDeploy` is on, so every `git push` to
  `main` rebuilds and redeploys automatically.

## Optional — turn on generative (LLM) answers later

The Q&A works out of the box with the built-in grounded composer (no API key).
To switch on generative answers, open the `scrumstage` service in Render →
**Environment** → add:

```
LLM_BASE_URL = https://api.openai.com/v1
LLM_API_KEY  = <your key>
LLM_MODEL    = gpt-4o-mini
```

Save — Render redeploys and on-topic answers become LLM-generated (still
constrained to each module's material).

---

## Troubleshooting

- **Build fails on the frontend step** — make sure you pushed the whole folder
  (it must contain `frontend/`, `backend/`, and `course-content/`).
- **App loads but API calls fail** — open the service **Logs** in Render; the
  backend prints `[api] listening on :PORT` once healthy. If it can't reach the
  database, confirm `scrumstage-db` finished creating and redeploy.
- **Health check** — Render pings `/api/health`; it should return
  `{"status":"ok"}`.
