# Deploy

GitHub Pages, account **k84hero**, repo `stock-tracker`.

1. Push to `k84hero/stock-tracker` (manual — this project does NOT use the
   github-publisher agent; that is fenced to Drake's research repos).
2. Settings → Pages → Source: "Deploy from branch" → branch `main`, folder `/ (root)`.
3. CSP is enforced via the `<meta http-equiv>` in `index.html`. GitHub Pages cannot
   serve custom headers. TRACKED GAP (security.md §2): `frame-ancestors`, HSTS,
   `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` are
   structurally absent until the site is fronted by Cloudflare (proxied DNS) —
   when that lands, add them via a Transform Rule / Managed Headers.
4. API keys: `config.js` carries baked publishable defaults (rate-limit-bound free-tier
   keys, per security.md §1). Rotating a key = edit `config.js`, commit, push. The
   Settings panel (localStorage) overrides baked defaults per browser.
5. After pushing: Settings → Code security → enable **Secret scanning** and
   **Push protection**.
