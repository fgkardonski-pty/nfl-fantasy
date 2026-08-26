/**
 * Optional LLM pass: convert free-text NFL news into a structured, numeric
 * impact on a specific player's projection.
 *
 * This is deliberately narrow. The model is not asked to project points or pick
 * lineups — it is asked to do the one thing it is genuinely better at than a
 * regression: read a sentence of English and tell you whether the player's role
 * just got bigger or smaller, and how confident that reading is. The number it
 * returns is a bounded multiplier adjustment, and it is always stored with the
 * rationale and the source so a human can overrule it.
 *
 * If ANTHROPIC_API_KEY is not set, this module is inert and the news
 * multiplier stays at 1.0. Nothing is fabricated.
 */
import config from '../config.mjs';
import { request } from '../util/http.mjs';
import { logger } from '../util/log.mjs';

const log = logger('llm');

const SYSTEM = `You analyse NFL news for fantasy football impact.

For each news item you are given, decide how it changes the named player's
expected fantasy production for the NEXT game, relative to what someone would
have expected before reading it.

Return STRICT JSON only, no prose, in this exact shape:
{"items":[{"id":"<the id given>","impact":<number -1..1>,"confidence":<number 0..1>,"rationale":"<one sentence>"}]}

Guidance on impact:
   1.0  player's role massively expands (starter ahead of him is out for the season)
   0.4  meaningful positive role change (promoted to starter, returning from injury healthy)
   0.1  mildly positive (good practice report, favourable coach comment)
   0.0  no material fantasy impact — MOST NEWS IS THIS. Do not invent signal.
  -0.3  mildly negative (limited in practice, committee mention)
  -0.7  significant negative (questionable with a soft-tissue injury, benching)
  -1.0  player will not play or has lost his role entirely

Confidence should be LOW (< 0.3) when the report is speculative, second-hand,
or from an unnamed source, and HIGH (> 0.7) only for confirmed transactions,
official injury designations, or direct quotes from the coaching staff.

Never speculate beyond what the text says. If the text does not clearly bear on
this player's playing time, target share, or availability, return impact 0.`;

export const isEnabled = () => Boolean(config.anthropicKey);

/**
 * Score a batch of news items.
 * @param {Array<{id:string, playerName:string, pos:string, team:string, headline:string, body?:string}>} items
 * @returns {Promise<Array<{id:string, impact:number, confidence:number, rationale:string}>>}
 */
export async function scoreNews(items) {
  if (!isEnabled() || !items.length) return [];

  const payload = items.slice(0, 25).map((i) => ({
    id: i.id,
    player: `${i.playerName} (${i.pos}, ${i.team ?? 'FA'})`,
    headline: i.headline,
    detail: (i.body ?? '').slice(0, 600),
  }));

  const res = await request('https://api.anthropic.com/v1/messages', {
    source: 'anthropic',
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ items: payload }) }],
    }),
    retries: 2,
    timeoutMs: 60000,
  });

  if (!res.ok) {
    log.warn(`news scoring failed: ${res.error}`);
    return [];
  }
  const text = res.json?.content?.map((c) => c.text ?? '').join('') ?? '';
  const parsed = extractJson(text);
  if (!parsed?.items) {
    log.warn('news scoring returned unparseable output; ignoring rather than guessing');
    return [];
  }
  return parsed.items
    .filter((i) => i && i.id)
    .map((i) => ({
      id: String(i.id),
      impact: clamp(Number(i.impact) || 0, -1, 1),
      confidence: clamp(Number(i.confidence) || 0, 0, 1),
      rationale: String(i.rationale ?? '').slice(0, 400),
    }));
}

/** Pull the first JSON object out of a response that may be fenced or prefixed. */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
