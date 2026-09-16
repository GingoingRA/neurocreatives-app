# Neurocreatives — Build & Deploy Walkthrough

Two tabs, one contract, plus a Codex-of-Content TV:

- **🧠 Neurocreative Challenge** — write about GenLayer, get fact-checked and graded with a 5-line verdict. Includes AI-slop detection: generic, low-effort AI-written filler gets a hard score penalty, not just a lower average.
- **🐙 GenLayer Engagement** — link a GitHub handle, get a deterministic engagement score + tier badge grounded in real GitHub facts.
- **📺 Codex of Content TV** (below the header, left-aligned) — a retro TV-shaped display that auto-flips through 10 curated tips pulled from GenLayer's official [Codex of Content](https://docs.google.com/document/d/e/2PACX-1vQ5ww_X_S5EQBb42OuZVzgvqdpJh4gbyb1k9wpJG4Kv8NMr8uzA3dnj7OtSA_8M959vJHAmxCJsZwUP/pub) — the community content-curation guide GenLayer's Discord uses to evaluate submissions. Also links out to `portal.genlayer.foundation` for builder quests/AMAs/community tasks.

This walkthrough takes you from a fresh contract file to a live app on Vercel.

The whole frontend (both tabs, shared components, and all styling) lives in a single
`src/App.jsx` for easy copy/paste and editing — only `main.jsx` (entry point) and
`index.html` (font links, root div) sit alongside it. No backend/serverless functions
are needed — the Codex TV content is static, curated data baked into the app.

## History: what changed and why

**v0.15.0 — real provenance verification, addressing external review feedback.** A
review of this app correctly flagged that both leaderboards were entirely
self-asserted: anyone could claim any GitHub handle with zero proof, and pasted text
had no way to verify the submitter actually wrote it or that it existed anywhere
outside the transaction itself. Two real fixes, both contract-level (not just UI):

1. **GitHub ownership verification.** `set_github_handle(handle)` is gone, replaced
   by `verify_github_handle(handle, gist_url)` — the standard web3 "prove you control
   this account" pattern (same idea Keybase and Gitcoin Passport use). The caller
   creates a GitHub Gist containing their wallet address and passes its URL; the
   contract fetches the gist's raw content (`gl.nondet.web.get`, using the same
   `User-Agent` header fix from earlier) and checks (a) the gist URL is actually
   under `gist.github.com/{handle}/...` — provably impossible unless you're logged
   into that exact account — and (b) the gist's content contains the caller's wallet
   address. `evaluate_my_genlayer_engagement` now requires this verification to have
   passed first. GitHub itself is the identity provider here; the contract never
   trusts a bare claim.
2. **Content provenance.** `submit_content_for_evaluation` now takes a URL, not
   pasted text — a blog post, GitHub README, X post, Mirror/Substack article,
   wherever the piece is actually published. The contract fetches the real page
   itself (`gl.nondet.web.render`) and grades *that*, storing the source URL
   alongside the score so anyone can click through and check it. As a bonus: if the
   URL is hosted under the submitter's *verified* GitHub handle (e.g. their own
   README), the entry gets an "author verified" badge — genuine confidence the
   specific person behind the wallet wrote it, not just a username typed into a form.

One known tradeoff worth flagging: `gl.eq_principle.strict_eq` requires the leader's
and validators' independent fetches to match exactly, which works reliably for
stable content (blog posts, READMEs) but can fail on pages with live-updating
elements (view counters, ads, timestamps) — noted directly in the contract's comments
as a submission-URL guideline, not something silently swept under the rug.

**v0.19.0 (frontend only) — tab switcher, warnings, and card now share one aligned
column (symmetry fix).** Previously the tab switcher and network warning spanned the
full page width (inside the header), while the active tab's card lived in the
narrower right column next to `CodexTV` — so their edges/centers never lined up.
Moved the tab switcher out of `Header` (now just brand + wallet) into a new
`TabSwitcher` component, and moved it plus the network warning/wallet-gate/
username-gate/error-banner into `.tab-column`, directly above the card. All of these
— switcher, warning, gates, and both cards — now share the identical `max-width: 760px`
(widened from 640px) and centering via `.tab-column-inner`/`.tab-panel`, so they form
one visually aligned block instead of three independently-positioned pieces. Also
fixed a real bug found along the way: `.tab-column` was missing
`flex-direction: column`, meaning its children were laying out in a row by default
instead of stacking vertically.

**v0.18.0 (frontend only) — auto-retry on LEADER_TIMEOUT/VALIDATORS_TIMEOUT.**
`"The leader validator timed out processing this transaction"` is a genuine
network-level outcome, not a bug — the assigned leader (or the validator round) took
too long. It's more likely on Neurocreative submissions specifically, since that write
runs two sequential LLM calls (the scoring round, then the write-up), giving the
leader more opportunity to run long. Since a transaction that ends this way never
reaches `ACCEPTED`, none of the contract's state changes apply — meaning it doesn't
consume one of the 5 submission slots, so retrying is free. Both tabs now do that
automatically (`writeContractTrackedWithLeaderRetry`, up to 2 retries) instead of
surfacing the error and making the user notice and resubmit by hand — a fresh
transaction is submitted each retry (the timed-out one is dead and can't be resumed),
with a visible "automatically resubmitting (1/2)" note while it happens.

**v0.17.0 (frontend only) — TV/tab-card two-column layout + transaction status
survives tab switches, page refresh, and wallet reconnects.** Two changes:

1. Layout: `CodexTV` and the active tab card now sit side by side (TV on the left,
   card on the right) in a `.two-col` row, with the TV resized down from its earlier
   "double size" (480px → 400px frame) to sit in better proportion next to the
   640px-wide cards. Warnings/gates stay full-width above the row.
2. **Transaction status persistence.** Previously, `txStage`/`txElapsedMs` lived only
   in each tab component's local state, so switching tabs unmounted the component
   (React destroys local state on unmount) and the whole progress bar vanished — even
   though the transaction itself was still running fine on-chain. Fixed two ways:
   - Both tab components now stay mounted at all times once logged in; switching tabs
     just toggles CSS `display`, which doesn't unmount anything or lose state.
   - The transaction hash is saved to `localStorage` (keyed by contract address +
     wallet address + which write it was) the moment it's obtained, and cleared once
     the transaction resolves. On mount — which covers a page refresh or a fresh
     wallet connect, not just a tab switch — each tab checks for a saved in-flight
     hash and automatically resumes watching it via `writeContractTracked`'s new
     `resumeHash` option, instead of requiring the user to notice nothing's showing
     and resubmit.

**v0.16.0 (frontend only) — layout fix + longer backpressure retry.** (1) The
onboarding elements (network warning, wallet/username gates, error banner, tab
content) are now wrapped in a dedicated `.content-flow` block directly under
`CodexTV`, with an explicit `justify-content: flex-start` safety net on `.app-main` —
on some tall/wide viewports these were drifting down toward the bottom of the page
instead of sitting right under the header. (2) The pipeline-backpressure retry budget
was too short (5 attempts × fixed 8s ≈ 40s) for how long Bradbury actually stays
congested — bumped to exponential backoff up to ~5.5 minutes total. Also added a
proactive check at wallet-connect time that calls `eth_getCode` on
`VITE_CONTRACT_ADDRESS` and fails immediately with a clear message if nothing's
deployed there, instead of only surfacing a cryptic viem "Requested resource not
found" error the first time someone tries to submit something.

**Follow-up:** the (1) fix above wasn't enough on its own — the network warning and
username gate were still appearing low on the page. Rather than keep guessing at the
exact flex-layout mechanism without being able to render it live, the block was moved
explicitly: it now renders directly under the header/tab switcher (above `CodexTV`),
not below it.

**Second follow-up:** the tab content itself (the Neurocreative Challenge / GenLayer
Engagement cards) had the same problem once a username was set — they were still
rendering after `CodexTV`, so on a short viewport they'd appear below the whole TV
block. Moved into the same `content-flow` block as the gates above, so the full
functional flow (warnings → gates → tab card) sits together directly under the
header, with `CodexTV` now placed after everything functional, right before the
footer.

**v0.15.0 (frontend, no contract change) — live transaction stage tracking + Codex TV
repositioned.** Two changes:

1. The Codex TV moved from a persistent full-height left sidebar to an inline block
   directly under the header/brand name, at roughly double its previous size (480px
   frame, 380px screen). It's no longer sticky/full-height since it's not a sidebar
   anymore — it scrolls with the page like any other content.
2. Replaced `genlayer-js`'s `waitForTransactionReceipt` (fixed timeout budget, throws a
   raw error and leaves the UI stuck with no recovery path except resubmitting) with a
   custom polling loop against `client.getTransaction()` for the Neurocreative
   Challenge and GenLayer Engagement tabs. This shows a live 5-stage progress bar
   (Submitted → Proposing → Committing → Revealing → Accepted/Finalized), watches
   indefinitely instead of giving up on a fixed budget, and surfaces "Under appeal" if
   a round gets disputed. After 5 minutes it offers a "Stop watching" option with a
   reassurance that the submission is already on-chain regardless — no more being
   stuck on "still confirming" with resubmitting as the only way out.

**v0.14.0 — 3-tier assessment tone.** The 5-line write-up used to always force one
strength + one weakness + one suggestion, even for a 95/100 submission. Now the
tone is picked deterministically from the already-agreed `overall_score` (the
ai_slop penalty is already applied by this point, so a slop-flagged submission can't
accidentally land in the celebratory tier):
- **`>= 85`**: purely celebratory — no manufactured weakness, names at least two
  genuine strengths, may optionally suggest something to try next framed as an
  exciting possibility rather than a flaw.
- **`< 40`**: direct and honest — clearly states the content falls short, names a
  concrete problem (not vague criticism), gives one clear actionable fix, stays
  respectful rather than harsh.
- **everything in between**: the original balanced strength/weakness/suggestion
  format, unchanged.

Thresholds live as `ASSESSMENT_HIGH_SCORE_THRESHOLD` (85) and
`ASSESSMENT_LOW_SCORE_THRESHOLD` (40) near the top of the contract — hand-picked,
not yet tuned against real submissions. The frontend's `verdictLabel()` helper
mirrors these same two numbers to pick a matching heading ("🎉 Nailed it:" / "Needs
work:" / "Why this score:") — keep both in sync if you change the thresholds.

**v0.13.0 — scoring criteria realigned to GenLayer's actual Codex of Content.** The
Neurocreative Challenge's rubric was originally invented (`accuracy`, `depth`,
`clarity`, `creativity`). Checked it against the real Codex, which repeatedly names its
own evaluation pillars near-verbatim: *"originality, relevance, information accuracy,
and overall effort."* Two of those four (`relevance`, `effort`) were completely absent
from the contract, and `creativity` was a stand-in for the Codex's actual term
(`originality`) rather than the real thing. The rubric is now `accuracy`, `relevance`,
`originality`, `effort`, `clarity` (5 criteria, up from 4) plus the existing `ai_slop`
hard-penalty dimension — see `CODEX_EVALUATION_STANDARDS` in the contract for the
grounding text, paraphrased from the Codex itself. Weights: accuracy 3.0, relevance
2.0, originality 2.0, effort 2.0, clarity 1.0 (sums to 10 → /100).

This app started as three tabs (Gen Idea, Neurocreative Challenge, GenLayer Engagement)
plus a one-time GEN faucet. **Gen Idea and the faucet have since been removed** and the
app renamed from GenIdea to Neurocreatives, to focus on the two tabs that reliably work
well and add a news sidebar instead. If you're looking for the idea-scoring or faucet
code from an earlier version, it's gone from this handoff — ask if you want it back.

Real fixes worth knowing about from earlier iterations, since they still apply to the
tabs that remain:

- **`ai_slop` criteria for Neurocreative** ends in a hard deterministic penalty
  (`ai_slop >= 7` caps the score at 15, `ai_slop >= 4` halves it) rather than just being
  averaged in like the other 4 criteria, so a slop-y submission can't buy a good score
  just by also nailing accuracy/clarity. The prompt lists concrete, checkable tells
  (stock phrases, buzzwords, structural patterns) rather than asking for a vague
  "does this feel like AI filler" judgment, since LLMs are far more reliable against a
  concrete checklist than an abstract vibe.
- **`UNDETERMINED` transactions**: GenLayer's Equivalence Principle needs *objective,
  checkable* criteria to reach consensus reliably. Anywhere a validator check asked for
  a subjective judgment (e.g. exact-matching a fuzzy classification, or "does the tone
  match these scores") independent LLM runs disagreed often enough that transactions
  ended in `UNDETERMINED` after the network exhausted leader rotations. Every
  consensus check in this contract is now either a numeric-tolerance comparison for
  genuinely quantifiable things, or a bucketed (low/medium/high) comparison for fuzzier
  judgments like `ai_slop`.
- **`genlayer-js` timeout budget**: the SDK's default `waitForTransactionReceipt` gives
  up after 30 seconds, nowhere near enough for a write that triggers LLM consensus.
  Both remaining tabs' writes use a much longer budget (~12 minutes for the LLM-heavy
  calls, ~2.5 minutes for quick ones), and if a call still somehow times out, the app
  polls the read side afterward and recovers the result instead of just erroring out.
- **`genlayer-js` treats `UNDETERMINED`/`CANCELED`/`LEADER_TIMEOUT`/`VALIDATORS_TIMEOUT`
  as "decided" states and resolves *without throwing*** even when you asked for
  `ACCEPTED` — it only throws for an actual client-side timeout where the tx is still
  in-flight. So a genuinely failed consensus round could look identical to success from
  the frontend's point of view. `writeContract()` in this app checks the resolved
  status itself and throws a real error for any non-success decided state.
- **GitHub API calls** need a `User-Agent` header (GitHub returns 403 without one) and
  the response object's field is `.status`, not `.status_code` — confirmed against
  GenLayer's authoritative SDK reference at `sdk.genlayer.com`, since the tutorial-style
  docs page uses the wrong field name in its examples.
- **Node congestion** (`"pipeline backpressure (l1_sender_commit)"`, RPC error -32603)
  is Bradbury's own node temporarily refusing new transactions. The frontend
  auto-retries with exponential backoff (5s, 10s, 20s, then 30s repeating, up to 12
  attempts — roughly 5.5 minutes total) when it hits this specific error.
  **Important caveat:** if this shows up as a popup *from your wallet itself*
  ("Fail to create") rather than as text inside the app, it means MetaMask/Rabby's own
  pre-flight gas-estimation call hit the congested node *before* your click ever
  reached our code — the app's retry logic can't intercept that, since it never sees
  it. In that case, just dismiss the wallet popup and click submit again; there's no
  way for the frontend to retry something that failed inside the wallet extension
  itself.
- **Asimov and Bradbury share the same chain ID** (`4221`) in `genlayer-js`, differing
  only in RPC URL — see the troubleshooting section below.
- **Non-MetaMask wallets** (Rabby, etc.): `genlayer-js`'s own `client.connect()`
  hard-depends on MetaMask's proprietary Snaps API and throws on wallets that don't
  support it. This app does the network switch itself with standard
  `wallet_addEthereumChain`/`wallet_switchEthereumChain` calls instead.

---

## 0. Prerequisites

- Node.js 18+ and npm
- [MetaMask](https://metamask.io/) or another EIP-1193 browser wallet (e.g. Rabby — see the compatibility note above)
- A GitHub account (Vercel deploys from a Git repo)
- The GenLayer CLI (same command on macOS and Windows):

  ```bash
  npm install -g genlayer
  ```

  > macOS: if this fails with an `EACCES` permissions error, it usually means npm's
  > global install directory isn't user-writable. Don't run it with `sudo` — instead
  > fix npm's global prefix once ([npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)) or install [nvm](https://github.com/nvm-sh/nvm) and use a Node version through that instead.

---

## 1. Deploy the Intelligent Contract

You're deploying `neurocreatives_contract_v15.py` — it has both tabs' logic in it.
Every command in this section is identical whether you're in macOS Terminal or
Windows Command Prompt — it's the same `genlayer` CLI binary either way.

### 1.1 Pick a network

```bat
genlayer network set studionet
```

or, for the public testnet:

```bat
genlayer network set testnet-bradbury
```

### 1.2 Create/import an account

```bat
genlayer account create
```

This funds an account you'll use to pay for deployment and write transactions. On a
testnet you'll need testnet GEN — check GenLayer's Discord/docs for the current faucet
link, since these rotate.

### 1.3 Deploy

```bat
genlayer deploy --contract neurocreatives_contract_v15.py
```

You'll get output like:

```
✅ Contract deployed successfully!
Transaction Hash: 0x1234...
Contract Address: 0xabcd...
```

**Copy the Contract Address — you'll need it for the frontend.**

### 1.4 Sanity-check it

```bat
genlayer schema <contractAddress>
```

This fetches the contract's ABI schema directly — the fastest way to confirm a fresh
deploy loaded correctly before ever opening the frontend.

Then try an actual read call:

```bat
genlayer call <contractAddress> get_content_leaderboard
```

Should return `{"total_submissions": 0, "submissions": []}` on a freshly deployed contract.

---

## 2. Run the frontend locally

Steps are the same on macOS and Windows — only the shell commands differ, shown side
by side below.

1. Unzip/copy this project folder, then open a terminal in it:

   **macOS (Terminal):**
   ```bash
   cd neurocreatives-app
   npm install
   ```

   **Windows (Command Prompt):**
   ```bat
   cd neurocreatives-app
   npm install
   ```

2. Copy the env template and fill in your contract address:

   **macOS:**
   ```bash
   cp .env.example .env
   ```

   **Windows:**
   ```bat
   copy .env.example .env
   ```

   Open the new `.env` file in a text editor and set:

   ```ini
   VITE_CONTRACT_ADDRESS=0xabcd...        # from step 1.3
   VITE_GENLAYER_NETWORK=testnetBradbury  # must match the network you actually deployed to
   ```

   > If you deployed via GenLayer Studio's UI and selected "Bradbury Testnet" there,
   > use `testnetBradbury` here too — the frontend has to target the exact same
   > network the contract lives on, or every call will fail with a "contract not
   > found" style error.
   >
   > Note the naming difference: the **CLI** network name is hyphenated
   > (`testnet-bradbury`, used in Part 1), while the **frontend** `.env` value is
   > camelCase (`testnetBradbury`, matching `genlayer-js`'s chain export names).
   > Same network, two different spellings depending on which tool you're using.

3. **Fund a testnet wallet.** Every write in this app — even just `set_username` —
   is a real transaction and costs testnet GEN. Grab some from GenLayer's Bradbury
   faucet before testing.

4. Start the dev server (same command on both platforms):

   ```bash
   npm run dev
   ```

5. Open the printed `localhost` URL. Click **Connect Wallet**, set a username, then try
   both tabs — the Codex TV is static content and works the same locally as in
   production, no extra setup needed.

**macOS-specific notes:**
- If `npm install` fails on an Apple Silicon Mac (M1/M2/M3) with a native-module build
  error, make sure Xcode Command Line Tools are installed: `xcode-select --install`.
- MetaMask/Rabby work identically in Safari and Chrome on macOS; if using Safari,
  make sure the extension is enabled under **Safari → Settings → Extensions**.

**If a write transaction hangs:** GenLayer transactions go through several statuses (`PROPOSING` → `COMMITTING` → `REVEALING` → `ACCEPTED`/`FINALIZED`) as validators reach consensus — a few seconds to a minute is normal, longer for LLM-scoring calls. The Neurocreative Challenge and GenLayer Engagement tabs show a **live stage tracker** for this (see below) rather than a generic spinner.

**How the live stage tracker works, and why it replaced the old fixed-timeout approach:** earlier versions relied on `genlayer-js`'s own `waitForTransactionReceipt`, which gives up after a fixed budget and throws a raw `"Timed out waiting for transaction..."` error — on a slow testnet, this left the UI stuck showing "still confirming" with no way to recover except resubmitting (which burns one of the limited submission slots, and the *original* submission was often still fine, just slow). The app now polls `client.getTransaction()` directly instead, so it can show exactly which stage the transaction is in (a 5-dot progress bar: Submitted → Proposing → Committing → Revealing → Accepted/Finalized) and **watches indefinitely** rather than timing out on a fixed budget. If a round gets disputed, an "Under appeal" note appears instead of silently stalling. After 5 minutes it shows a reassurance note plus a **"Stop watching"** button — your submission is already on-chain at that point regardless, so stopping just means you're no longer watching from this tab; reopening it later (or checking the leaderboard) will show the result once it lands.

**If a transaction lands on the wrong testnet** (e.g. you set `VITE_GENLAYER_NETWORK=testnetBradbury` but the tx shows up on Asimov): `testnetAsimov` and `testnetBradbury` share the exact same chain ID (`4221`) in `genlayer-js`, differing only in RPC URL. MetaMask/Rabby identify saved networks by chain ID, so if it already has *any* network saved under 4221, switching to "testnetBradbury" can silently reuse that old entry's RPC. Fix it in your wallet directly:

1. **Settings → Networks**, find the entry with Chain ID `4221`.
2. Either delete it, or edit it to the network you actually want:

   | | Asimov | Bradbury |
   |---|---|---|
   | RPC URL | `https://rpc-asimov.genlayer.com` | `https://rpc-bradbury.genlayer.com` |
   | Block Explorer | `https://explorer-asimov.genlayer.com/` | `https://explorer-bradbury.genlayer.com/` |

3. Reconnect the wallet in the app, and glance at your wallet's active network name/RPC before signing — the app can't detect this mismatch itself, since both networks report the same chain ID.

The app shows a warning banner about this whenever you're connected on Asimov or Bradbury, as a reminder.

---

## 3. Deploy the frontend to Vercel

### 3.1 Push to GitHub

Same commands on macOS and Windows:

```bat
cd neurocreatives-app
git init
git add .
git commit -m "Neurocreatives app"
git branch -M main
git remote add origin https://github.com/<you>/neurocreatives-app.git
git push -u origin main
```

(`.env` is already git-ignored — don't commit your real values.)

### 3.2 Import into Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo.
2. Vercel auto-detects **Vite** as the framework. Confirm these build settings (should
   be prefilled):
   - **Build command:** `vite build`
   - **Output directory:** `dist`
   - **Install command:** `npm install`
3. Under **Environment Variables**, add:
   | Name | Value |
   |---|---|
   | `VITE_CONTRACT_ADDRESS` | your deployed contract address |
   | `VITE_GENLAYER_NETWORK` | `studionet` (or your chosen testnet) |
4. Click **Deploy**.

### 3.3 Verify

Once deployed, open the Vercel URL, connect your wallet, and run through both tabs end-to-end, and confirm the Codex TV is flipping through tips. Since env vars are baked in at build time for Vite, if you ever change `VITE_CONTRACT_ADDRESS` (e.g. after redeploying the contract), update it in Vercel's project settings and **redeploy** — editing the env var alone won't update an already-built app.

---

## 4. Updating the contract later

If you change `neurocreatives_contract_v15.py`, you'll get a **new** contract address after redeploying — GenLayer contracts aren't upgraded in place unless you specifically build for [upgradability](https://docs.genlayer.com/developers/intelligent-contracts/features/upgradability). Update `VITE_CONTRACT_ADDRESS` in Vercel and redeploy the frontend whenever that happens.

---

## About the Codex of Content TV

`CODEX_HIGHLIGHTS` (near the top of `src/App.jsx`) is a **manually curated, static**
list of 10 tips distilled from GenLayer's official
[Codex of Content](https://docs.google.com/document/d/e/2PACX-1vQ5ww_X_S5EQBb42OuZVzgvqdpJh4gbyb1k9wpJG4Kv8NMr8uzA3dnj7OtSA_8M959vJHAmxCJsZwUP/pub)
(v1, Jul 24 2026) — GenLayer's community content-curation guide (the Mochi Bot
submission/voting system, evaluation standards, what gets rejected, etc.). The
`CodexTV` component auto-advances through them every 7 seconds inside a retro
TV-shaped frame (CRT scanline overlay included), with dot indicators you can click to
jump directly to a tip.

**This is not live-scraped** — there's no backend involved, it's a plain JS array. Two
reasons for that: the source is a prose Google Doc (no repeating structure to parse
reliably like the old blog scraper had), and distilling "the important parts" is
inherently a judgment call, not something worth faking as automated. The doc itself
does auto-update on Google's side (its publish-to-web feature refreshes within ~5
minutes of edits), so if GenLayer revises the Codex, **ask Claude to re-read it and
refresh `CODEX_HIGHLIGHTS`** — that's the intended way to keep this current, rather
than expecting it to update itself.

To change the flip interval, edit the `7000` (milliseconds) in `CodexTV`'s
`setInterval` call. To add/remove tips, edit the `CODEX_HIGHLIGHTS` array — each entry
just needs a `title` and a `body`.

---

## What each tab actually calls

| Tab | User action | Contract calls |
|---|---|---|
| Neurocreative Challenge | Submit for Grading | `submit_content_for_evaluation` (write), then `get_my_content_evaluations` (view) |
| Neurocreative Challenge | See leaderboard | `get_content_leaderboard` (view) |
| GenLayer Engagement | Verify handle | `verify_github_handle` (write, requires a gist proof) |
| GenLayer Engagement | Check My Engagement | `evaluate_my_genlayer_engagement` (write — fetches GitHub, scores it), then `get_my_engagement` (view) |
| GenLayer Engagement | See leaderboard | `get_engagement_leaderboard` (view) |

Both tabs share one username, set once via `set_username`. Existing username and
GenLayer-engagement state are both re-loaded from the contract on wallet connect, so
returning users skip straight back in.
