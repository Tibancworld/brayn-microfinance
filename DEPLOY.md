# Deploy Brayn Microfinance on myprototype.work

`myprototype.work` is a Namecheap domain (currently parked). The Node/SQLite app needs a host, then DNS points the domain at that host.

## 1. Push this repo to GitHub

If the remote is not set yet:

```bash
git init
git add .
git commit -m "Prepare production deploy for myprototype.work"
gh repo create brayn-microfinance --private --source=. --remote=origin --push
```

## 2. Deploy on Render (recommended)

1. Open [https://dashboard.render.com/select-repo?type=blueprint](https://dashboard.render.com/select-repo?type=blueprint)
2. Connect the `brayn-microfinance` GitHub repo
3. Apply `render.yaml` (Docker web service + 1 GB disk at `/app/data`)
4. After the first deploy, open the Render service → **Environment** and copy:
   - `ADMIN_PASSWORD` (auto-generated)
   - Confirm `SESSION_SECRET` exists
5. Note the temporary URL, e.g. `https://brayn-microfinance.onrender.com`

## 3. Point myprototype.work at Render

In Render → your service → **Settings → Custom Domains**:

1. Add `myprototype.work`
2. Add `www.myprototype.work` (optional)
3. Copy the DNS target Render shows (usually something like `brayn-microfinance.onrender.com`)

In **Namecheap → Domain List → myprototype.work → Advanced DNS**:

| Type | Host | Value | TTL |
|---|---|---|---|
| URL Redirect Record *(remove if present)* | `@` | delete parking redirect | — |
| CNAME Record | `www` | `brayn-microfinance.onrender.com` | Automatic |
| ALIAS / ANAME / CNAME Flattening* | `@` | `brayn-microfinance.onrender.com` | Automatic |

\* Namecheap may not support ALIAS on `@`. If not:

1. In Render, use the **A records** they list for the apex domain, **or**
2. Redirect `@` → `https://www.myprototype.work` and put the CNAME only on `www`.

Remove Namecheap parking / marketplace page records so they no longer serve the auction landing page.

## 4. SSL

Render issues HTTPS certificates after DNS validates (often 5–30 minutes). Then open:

- https://myprototype.work/login.html

Demo admin username is still `admin` unless you changed `ADMIN_USERNAME`. Use the generated `ADMIN_PASSWORD` from Render env vars (not the local `password123` unless you set that yourself).

## Local production smoke test

```bash
docker build -t brayn-mf .
docker run --rm -p 3000:3000 -e SESSION_SECRET=dev-secret -e NODE_ENV=production -v "${PWD}/data:/app/data" brayn-mf
```
