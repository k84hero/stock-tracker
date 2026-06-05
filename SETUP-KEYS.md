# Key setup — your account-level steps

I wrote all the code. These are the steps only you can do (they touch your Cloudflare
and GitHub accounts). When you finish Part 1, paste me the Worker URL and I'll bake it
in + flip the analyst to proxy mode. Part 2 is optional polish you can do any time.

---

## Part 1 — Cloudflare Worker (the analyst key, the important one)

This puts your Anthropic key on a server you control. The public site never sees it;
a passphrase only you know unlocks it.

**Easiest path (dashboard, no CLI):**
1. Make a free account at https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it `stock-analyst` → Deploy → **Edit code** → paste the contents of `worker/worker.js` → **Deploy**.
3. In that worker → **Settings** → **Variables and Secrets** → add two **Secrets** (encrypted):
   - `ANTHROPIC_API_KEY` = your real `sk-ant-…` key (the freshly rotated one)
   - `ANALYST_PASSPHRASE` = any strong passphrase you'll remember (e.g. 4 random words)
4. Copy the worker URL (looks like `https://stock-analyst.<your-subdomain>.workers.dev`).
5. **Paste that URL to me.** I'll bake it into the site, add it to the CSP, and the
   analyst field becomes a passphrase box. You'll type the passphrase once and you're done.

**CLI path (if you prefer):** in `worker/`, run
`npx wrangler deploy`, then `npx wrangler secret put ANTHROPIC_API_KEY` and
`npx wrangler secret put ANALYST_PASSPHRASE`.

> Your key now bills only your own analyst clicks (gated by the passphrase), not random
> visitors'. Still set a monthly spend cap in the Anthropic console as a backstop.

---

## Part 2 — GitHub Actions Secrets (the market keys, cosmetic)

This pulls the two publishable market keys out of the repo entirely. Optional — they're
rate-limited freebies — but it keeps your git history key-free and lets you rotate them
without a public commit.

1. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   - `FINNHUB_KEY` = `d8hf209r01qgcfbpfjkgd8hf209r01qgcfbpfjl0`
   - `TWELVEDATA_KEY` = `611bda3de7cf48f6883f33679d8327d3`
2. Tell me they're set. I'll then: switch Pages to "GitHub Actions" source, enable the
   `push` trigger in `.github/workflows/deploy.yml`, and `git rm` the committed `config.js`
   so `config.template.js` + the workflow generate it fresh each deploy. I'll verify the
   site stays live through the cutover.

---

## Also: rotate the pasted key (do first)

The Anthropic key you pasted into chat earlier is in this machine's local transcript.
Revoke it at https://platform.claude.com → API Keys, make a new one, and use the NEW
one in Part 1 step 3. Don't paste the new one into chat — it only goes into Cloudflare.
