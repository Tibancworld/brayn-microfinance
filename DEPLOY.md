# Always-on hosting (no PC tunnel)

Cloudflare **Containers** need a [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) plan.  
Until then, host on **Render** (runs in the cloud; your PC can be off).

## Deploy on Render

1. Push this repo to GitHub (already: `Tibancworld/brayn-microfinance`)
2. Open [Render Blueprint](https://dashboard.render.com/select-repo?type=blueprint)
3. Connect the repo → apply `render.yaml`
4. After deploy, copy the URL: `https://brayn-microfinance.onrender.com`
5. In Render → service → **Environment**, note generated `ADMIN_PASSWORD`

## Point www.myprototype.work at Render

In Cloudflare DNS for `myprototype.work` (**bblessking** account):

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `www` | `brayn-microfinance.onrender.com` | Proxied (orange) |

Remove the tunnel CNAME target (`*.cfargotunnel.com`).

Optional: Cloudflare SSL/TLS mode **Full**.

## Notes

- Free Render may **sleep** after idle (~15 min); first request can take 30–60s to wake
- SQLite on free Render is **ephemeral** (resets on redeploy/sleep disk wipe). Fine for demos; for real data upgrade Render disk or Workers Paid + Containers
- Stop local tunnel when DNS points to Render: close `wrangler tunnel run`

## Upgrade path (Cloudflare only)

1. Workers Paid on `bblessking@gmail.com`
2. `npm run cf:deploy`
3. Attach `www.myprototype.work` to the Worker custom domain
