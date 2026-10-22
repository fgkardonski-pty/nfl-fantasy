# War Room operating priorities

The original SUPERPROMPT.md remains the product mission. Frank's September 7
clarification sets the implementation order: automatic daily evidence, actual
league activity and opponent rosters, explained acquisition decisions, and a
separate next-lineup decision. Both Yahoo and Sleeper must be supported.

## Implemented in this change

- `serve` starts research automatically; `--no-research` explicitly disables it.
- Every registered live league is refreshed every 30 minutes, including Sleeper
  settings, rosters and completed transaction history. Requests are deduplicated
  while a refresh is in progress. The selected league is not changed by refresh.
- Shared player index refresh is daily; weekly projection/previous-week stats
  and schedule refresh is every six hours. Existing odds/weather jobs cover all
  registered live season/week pairs. Each source can fail independently.
- Sleeper imports preserve team identity and remaining FAAB. Unknown player IDs
  and incomplete roster responses do not replace saved roster ownership.
- War Room opens with separate acquisition and start/sit sections, recent player
  movements, source status and plain-language reasons. It updates every minute
  while visible, without requiring a manual browser refresh.
- Acquisition suggestions are alternatives, not simultaneous claims. They
  compare required drops, current lineup gain and a season starting-lineup proxy.
  They pause on stale ownership, unsupported scoring or failed weekly evidence.
- Lineup changes preserve known locked starter slots, use the opponent's submitted
  starters for pregame win-probability optimization when available, and otherwise
  explain their expected-points basis. Small Monte Carlo differences do not force
  an override. Existing detailed simulations remain available separately.
- Imported weekly projections remain usable after the first real game, without
  compounding another set of matchup multipliers. Week-zero forecasts are excluded
  from observed-game counts. Shared season values now use the league-scored draft
  valuation rather than flat positional constants.
- Existing Sleeper live draft polling is retained. Draft-phase War Rooms link
  directly to it. Draft and weekly lineup decisions remain separate.

## Activation

Deploy this branch to the existing Node host and restart its normal `serve`
process. It must remain running for scheduled research to execute. Use the
existing production database and environment; neither is stored in this repo.
The change does not submit roster moves or send messages.

Sleeper needs a registered league ID and a verified team selection. Existing
registrations are reused. For a new registration:

    node bin/oracle.mjs sleeper league --id <league-id> --user <username>

Yahoo needs a valid OAuth connection and the actual provider league key. The
hand-entered Yahoo league file is not an authenticated Yahoo API key and is
explicitly flagged as manual. Do not report those rosters as automatically fresh.

## Remaining mission gaps

- The original prompt's championship-delta objective is not yet fully implemented:
  legacy waiver title deltas and trade acceptance rates remain heuristics. The
  new action screen does not relabel them as measured probabilities.
- This change does not deliver a new news-source connector or route/air-yard feed.
  Existing news scoring only processes news already ingested. Missing projections,
  undocumented Sleeper statistics/schedule endpoints and unavailable odds remain
  visible limitations, not invented evidence.
- Exact live scores and remaining-game conditional distributions are not modeled.
  Locked lineup decisions preserve slots; the legacy full-week simulation below
  the action screen remains a pregame scenario, not live win odds.
- Future-week injury scenarios, full playoff-rule simulation, real claim-order
  simulation, provider-specific drop restrictions and automated transaction
  submission remain outside this patch. Verify final move legality on the provider.
- The production Sleeper league ID, database, provider credentials and host were
  not available in the repository. Fixture tests do not establish live connectivity.

## Validation

Regression tests cover repeat Sleeper import, budget/identity preservation,
incomplete-ID refusal, idempotent manager-attributed activity, stale-data gates,
explained add/drop alternatives, locked starters, weekly forecasts after observed
games and overlapping scheduler runs. Run `npm test` for the complete suite.
