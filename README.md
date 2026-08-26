# 🏈 Gridiron Oracle

**A self-hosted war room built for one purpose: winning your Yahoo fantasy football league.**

Not a projection site. Not a rankings aggregator. A decision engine that reads your
actual league — your scoring rules, your rivals' rosters, their entire transaction
history — simulates it tens of thousands of times, and tells you what to do,
denominated in the only currency that matters: **change in championship probability**.

```bash
git clone https://github.com/fgkardonski-pty/nfl-fantasy && cd nfl-fantasy
node bin/oracle.mjs demo      # seed a full synthetic league
node bin/oracle.mjs serve     # open http://127.0.0.1:4317
```

No `npm install`. No build step. No dependencies at all — this runs on a clean
Node 22 with nothing but the standard library.

---

## Why this exists

Most fantasy tools answer the wrong question. They rank players by projected
points, and projected points are an intermediate quantity nobody gets a trophy
for. Three things follow from taking that seriously:

**1. A projection is a distribution, not a number.**
Starting a 12.0 over an 11.4 is not a decision — it is noise. What decides the
week is the *shape*: a boom/bust receiver with a 4-point floor and a 30-point
ceiling is a completely different asset from a metronome who scores 11 every
Sunday, and which one you want depends entirely on whether you are ahead or
behind. Every projection here carries a mean, a standard deviation, a 10th
percentile floor and a 90th percentile ceiling.

**2. Players are correlated, and ignoring it makes you lose.**
Your quarterback and his own receiver rise and fall together. Your running back
competes with your own passing game for the ball. A defense is strongly
*negatively* correlated with the offense it is facing. Simulate players
independently and you will systematically understate the variance of a stacked
lineup — which means overstating your win probability as an underdog, exactly
when you most need the truth.

**3. Your league is a game against people, not against projections.**
Eleven humans, each of whom leaves a complete behavioural record in the
transaction log: what they bid, when they bid it, whether they chase last week's
box score, whether they panic-drop after one bad game, and whether they quietly
stopped paying attention in November. That record is the single most exploitable
edge in any league, and almost nobody uses it.

---

## What it does

### The War Room
Your win probability this week, from a correlated Monte Carlo simulation of your
starters against your opponent's actual starters. The optimal lineup — solved
**exactly** via the Hungarian algorithm, not greedily — plus every realistic
alternative re-simulated and ranked by win probability. When maximising points
and maximising win probability disagree, it says so, and it follows the win
probability.

> *"You are a 22.4% underdog. Starting Marcus Whitfield over Devin Barrow raises
> win probability to 26.1% (+3.7 pts of win probability) while giving up 2.4
> projected points. Chase the tail — expected points do not matter, only the
> outcomes where you win do."*

Every number expands to show the components that produced it: the baseline, the
role trend, the defensive matchup, the implied team total from the betting
market, the wind at the stadium, the injury designation.

### Waivers & FAAB
Free agents ranked by **marginal championship probability**, not projected
points. A 14-point receiver is worth nothing to you if you already start three
better ones. Each target gets an optimal bid derived from its value to *your*
roster, your remaining budget, the weeks left, and the bids your rivals are
predicted to make — with budget deliberately held in reserve for the injury that
has not happened yet.

Plus a **breakout scanner** that finds role changes before the box score does:
snap share climbing, target share climbing, red-zone touches accumulating, and
ownership that has not caught up yet. That gap is the whole game.

### Trades
Every 1-for-1, 2-for-1 and 2-for-2 package across every roster in your league,
evaluated **twice**: once on your valuations, and once on the counterparty's —
reconstructed from their revealed preferences, including their positional bias,
their recency chasing, and the endowment premium everyone demands for their own
players. Results split into two boards:

- **Win-win** — both sides genuinely improve. These get accepted.
- **Value arbitrage** — you gain and they do not, but their own board says they
  will take it anyway. Real edge, lower hit rate, and you should know which kind
  you are sending.

Each comes with the pitch, tailored to who you are pitching.

### Opponent Intelligence
A dossier per manager, built from the transaction log:

| Trait | What it reveals |
|---|---|
| Waiver aggression | How hard they contest the wire |
| FAAB burn rate | Whether they will be broke when it matters |
| Positional bias | Where they systematically overpay |
| Box-score chasing | Whether you can sell them a player who just spiked |
| Panic dropping | Whose drops are worth watching for real value |
| Engagement | Who has checked out |

Archetypes — *Budget Burner*, *Box Score Chaser*, *Panic Churner*, *Absentee*,
*Set-and-Forget*, *Active Dealer* — are assigned **relative to your league**,
not against fixed thresholds, and each carries a confidence score. A label
everybody has is not intelligence.

From that: a ranked prediction of **who each rival claims this week and what
they will bid**, a contested-players board showing who you are racing, and a
buy-low list of players whose owners will sell cheap.

### Season Odds
Thousands of season replays: playoff odds, seed distribution, championship odds
for every team. This is the number the entire platform optimises, and it sits in
the sidebar on every screen.

### Draft Room
Value over replacement computed from **your league's actual starting
requirements** — not a generic 12-team template. Gap-based tiering so you see
the cliffs. And **VONA**: a Monte Carlo simulation of the draft forward to your
next pick, with an opponent model, to answer the question that actually decides
drafts — *what will realistically still be on the board when I am back on the
clock?* The best pick is rarely the best player.

---

## Connecting Yahoo

1. Create an app at [developer.yahoo.com/apps/create](https://developer.yahoo.com/apps/create/)
   - **Application Type:** Web Application
   - **Redirect URI:** `http://localhost:4317/auth/yahoo/callback`
   - **API Permissions:** Fantasy Sports → Read *(or Read/Write to submit moves)*
2. `cp .env.example .env` and fill in `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`,
   and `ORACLE_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. `node bin/oracle.mjs serve`, open the **Data & Yahoo** page, click **Connect**.
4. Click **Sync league now**.

The platform then pulls your league settings and **exact scoring rules**, every
team, every roster, the full transaction log with FAAB bids, matchups,
standings, draft results, and the league player universe with ownership.

Refresh tokens are AES-256-GCM encrypted with a key derived from `ORACLE_SECRET`
before they touch the database. They are never logged and never returned over
the API. The server binds to `127.0.0.1` by default.

### Optional data sources

| Source | Key needed | What it adds |
|---|---|---|
| [Sleeper](https://docs.sleeper.com) | none | Injury designations, depth charts, league-wide add/drop velocity |
| [the-odds-api](https://the-odds-api.com) | free tier | Implied team totals and game script — the strongest free pre-kickoff signal |
| [Open-Meteo](https://open-meteo.com) | none | Wind and precipitation at each outdoor stadium |
| [Anthropic](https://console.anthropic.com) | optional | Converts free-text news into a bounded, cited projection impact |

Everything is optional. Without them the relevant multiplier stays at 1.0 and
the platform *says so* — it does not invent numbers.

---

## Command line

```bash
node bin/oracle.mjs lineup            # optimal lineup + win probability + the case for each call
node bin/oracle.mjs waivers           # ranked targets with FAAB bids
node bin/oracle.mjs trades            # win-win trades and arbitrage, with the pitch
node bin/oracle.mjs intel             # rival dossiers and predicted claims
node bin/oracle.mjs outlook           # playoff and championship odds
node bin/oracle.mjs draft --slot 4    # live draft board with VOR, VONA and tiers
node bin/oracle.mjs yahoo sync        # pull your league
node bin/oracle.mjs research          # run every research job once
node bin/oracle.mjs research daemon   # run the scheduler in the foreground
node bin/oracle.mjs status            # what is loaded, connected, and stale
```

Add `--json` to `lineup`, `waivers`, `trades`, `intel` or `outlook` for
machine-readable output.

---

## How the model works

```
Yahoo league settings ──┐
Weekly stat history ────┼──► baseline (recency-weighted, shrunk to positional prior)
Snap / target / RZ ─────┼──► role multiplier (only the CHANGE in role, not the level)
Opponent defense ───────┼──► matchup multiplier (shrunk hard — 4 games is mostly noise)
Vegas total & spread ───┼──► environment multiplier (volume × game script)
Stadium weather ────────┼──► weather multiplier (wind and rain only)
Injury designation ─────┼──► availability multiplier
News (optional LLM) ────┘
                         │
                         ▼
              mean, σ, floor (p10), ceiling (p90)   ← gamma, so the floor is never negative
                         │
                         ▼
       correlation matrix ──► Cholesky ──► GAUSSIAN COPULA
                         │
                         ▼
   correlated samples that preserve each player's skewed marginal distribution
                         │
        ┌────────────────┼────────────────┬─────────────────┐
        ▼                ▼                ▼                 ▼
   win probability   playoff odds   championship odds   FAAB dollars
```

**Design commitments, enforced in code and tests:**

- **Nothing is fabricated.** A missing source produces a neutral multiplier and
  a component note saying it is missing. Demo players are explicitly fictional
  and labelled as such on every screen.
- **Everything is explainable.** Every projection carries the component
  contributions that produced it. Every bid carries its rationale. Every trade
  carries its pitch.
- **Everything is reproducible.** Every modelling and simulation path draws
  from an explicitly seeded RNG, so the same inputs give the same
  recommendation. The only two unseeded uses of randomness in the codebase are
  network retry backoff jitter and research-job start jitter, which are
  deliberately non-reproducible and touch nothing the model reads.
- **The statistics are actually right.** Verified against closed forms, not
  eyeballed.

---

## Tests

```bash
npm test    # 101 tests
```

The claims this platform makes are the ones under test:

- `erf`, normal quantiles, `lnGamma` and the gamma CDF against **closed-form
  values** (the exponential and chi-squared special cases).
- The lineup optimizer proved **exactly optimal against exhaustive brute force**
  over 250 random rosters across four slot configurations, including
  SUPERFLEX and multi-position flex.
- The Gaussian copula verified to **preserve every marginal distribution**
  (mean, σ, non-negativity) *while* inducing the target correlations.
- Season simulation coherence: playoff odds sum to the number of playoff spots,
  championship odds sum to 1, and `titleOdds ≤ playoffOdds` for every team.
- Yahoo's nested-array JSON parsed from **response-shape fixtures** covering
  leagues, settings, teams, rosters, transactions and the scoreboard.
- End-to-end integration on a seeded league: legal lineups, no player started
  twice, bids never exceeding budget, trades only proposing players the two
  sides actually own, and predicted claims only targeting genuine free agents.

---

## Honest limitations

Written down because a tool that overstates its confidence is worse than no tool.

- **The Yahoo integration is unit-tested against fixtures, not against live
  Yahoo.** It was developed in an environment with no outbound access to
  Yahoo's API. The OAuth flow, the client, and the sync are written against the
  documented API shapes and every parser path is covered by tests, but the first
  live sync is the first live sync. Expect to file a bug; the sync reports
  per-stage failures precisely so you can.
- **Future weeks are simulated at team level, not player level.** For the
  current week the simulation is player-by-player with full correlation. Beyond
  it we do not know who will be healthy, who will be on a bye, or what the lines
  will be — so a team becomes a mean and a standard deviation. That is stated
  rather than dressed up as precision we do not have.
- **The correlation coefficients are principled estimates, not fitted from
  play-by-play data.** They encode well-established structure (QB↔WR positive,
  RB↔own passing game negative, DEF↔opposing offense strongly negative) at
  plausible magnitudes. Fitting them to real historical data would be better.
- **Opponent archetypes need evidence to work.** Early in a season, with three
  transactions in the log, most managers will read as "Balanced" — correctly.
  The confidence score reflects that. On a demo league the model recovers 9 of
  12 intended manager types, and the three misses all carry low confidence.
- **Multi-position eligibility now comes from Yahoo, but is untested live.**
  Yahoo publishes a per-player eligibility list, and returns `display_position`
  as a comma list ("WR,RB") for multi-eligible players. The sync stores the
  primary position and the full eligibility list separately, and the optimizer
  honours the list. This is covered by unit tests, but like the rest of the
  Yahoo path it has not met the live API.
- **Demo mode is synthetic.** Fictional players, simulated statistics. It exists
  so every engine is exercisable before you enter a credential — it is not a
  model of any real athlete, and the UI says so on every screen.
- **This does not submit moves for you by default.** Write scope exists and
  `submitAddDrop` is implemented, but nothing calls it automatically. Deciding
  is the machine's job; clicking is yours.

---

## Architecture

```
bin/oracle.mjs           CLI
src/
  config.mjs             .env + process.env
  util/                  stats · seeded RNG · AES-GCM crypto · rate-limited HTTP · logging
  db/                    node:sqlite schema, migrations, bulk upsert, provenance
  engine/
    scoring.mjs          league-aware scoring from Yahoo's real stat table
    roster.mjs           slot eligibility, FLEX/SUPERFLEX, positional demand
    optimizer.mjs        Hungarian algorithm — exact lineup assignment
    features.mjs         opportunity share, usage trends, breakout signal
    matchup.mjs          defensive ratings, Vegas game script, weather
    projections.mjs      distributions with per-component explanations
    correlation.mjs      the correlation structure between players
    simulate.mjs         Gaussian copula Monte Carlo, weekly and season-long
    leverage.mjs         start/sit by win probability, not points
    vor.mjs              value over replacement, gap-based tiering, scarcity
    draft.mjs            VONA via forward draft simulation with an opponent model
    waivers.mjs          FAAB bids priced in championship probability
    trades.mjs           dual-sided evaluation, win-win search
    opponent.mjs         behavioural dossiers, claim and bid prediction
  providers/
    yahoo/               OAuth2+PKCE · JSON normaliser · API client · league sync
    sleeper.mjs          player index, injury status, trending adds
    odds.mjs             implied team totals from the betting market
    weather.mjs          stadium forecasts at kickoff
  research/              scheduler, jobs, optional LLM news scoring
  server/                zero-dependency router, static serving, API
  service.mjs            the bridge: database → engines → answers
public/                  the war room (ES modules + CSS, no build step)
test/                    101 tests
```

**Why zero dependencies?** Because the alternative is that this stops working in
eighteen months when a transitive dependency breaks, and because `git clone &&
node bin/oracle.mjs serve` should be the entire setup. Node 22's built-in
`node:sqlite` and `fetch` make it genuinely practical.

---

## Configuration

See `.env.example`. Everything is optional except the Yahoo pair for live data.

| Variable | Default | Purpose |
|---|---|---|
| `ORACLE_PORT` / `ORACLE_HOST` | `4317` / `127.0.0.1` | Server binding |
| `ORACLE_DB` | `./data/oracle.db` | SQLite path |
| `ORACLE_SECRET` | — | **Required to store credentials.** Encryption key |
| `YAHOO_CLIENT_ID` / `_SECRET` | — | Yahoo app credentials |
| `ODDS_API_KEY` | — | Betting lines |
| `ANTHROPIC_API_KEY` | — | LLM news → projection impact |
| `ORACLE_SIMS_WEEK` | `20000` | Weekly matchup iterations |
| `ORACLE_SIMS_SEASON` | `5000` | Season replays |
| `ORACLE_SEED` | `8675309` | Master RNG seed — change it, get different noise; keep it, get reproducible answers |

---

*Built with [Claude Code](https://claude.com/claude-code). The engineered prompt
that produced this repository is preserved verbatim in
[`SUPERPROMPT.md`](SUPERPROMPT.md).*
