/**
 * Fixtures reproducing the response SHAPES documented for the Yahoo Fantasy
 * Sports API. Content is synthetic; the nesting, the indexed-collection
 * pseudo-arrays and the fragment arrays mirror what the live API emits.
 */

export const LEAGUES_RESPONSE = {
  fantasy_content: {
    users: {
      0: {
        user: [
          { guid: 'ABC123' },
          {
            games: {
              0: {
                game: [
                  { game_key: '449', game_id: '449', name: 'Football', code: 'nfl', season: '2026' },
                  {
                    leagues: {
                      0: {
                        league: [{
                          league_key: '449.l.123456',
                          league_id: '123456',
                          name: 'The Championship Belt',
                          num_teams: '12',
                          scoring_type: 'head',
                          current_week: '9',
                          start_week: '1',
                          end_week: '17',
                          season: '2026',
                        }],
                      },
                      1: {
                        league: [{
                          league_key: '449.l.999999',
                          league_id: '999999',
                          name: 'Work League',
                          num_teams: '10',
                          scoring_type: 'head',
                          current_week: '9',
                          season: '2026',
                        }],
                      },
                      count: 2,
                    },
                  },
                ],
              },
              count: 1,
            },
          },
        ],
      },
      count: 1,
    },
  },
};

export const SETTINGS_RESPONSE = {
  fantasy_content: {
    league: [
      {
        league_key: '449.l.123456',
        name: 'The Championship Belt',
        num_teams: '12',
        current_week: '9',
        season: '2026',
      },
      {
        settings: [{
          draft_type: 'live',
          scoring_type: 'head',
          uses_faab: '1',
          waiver_type: 'FR',
          trade_end_date: '2026-11-20',
          playoff_start_week: '15',
          num_playoff_teams: '6',
          roster_positions: [
            { roster_position: { position: 'QB', position_type: 'O', count: 1 } },
            { roster_position: { position: 'RB', position_type: 'O', count: 2 } },
            { roster_position: { position: 'WR', position_type: 'O', count: 3 } },
            { roster_position: { position: 'TE', position_type: 'O', count: 1 } },
            { roster_position: { position: 'W/R/T', position_type: 'O', count: 1 } },
            { roster_position: { position: 'K', position_type: 'K', count: 1 } },
            { roster_position: { position: 'DEF', position_type: 'DT', count: 1 } },
            { roster_position: { position: 'BN', count: 6 } },
          ],
          stat_modifiers: {
            stats: [
              { stat: { stat_id: '4', value: '0.04' } },
              { stat: { stat_id: '5', value: '4' } },
              { stat: { stat_id: '6', value: '-1' } },
              { stat: { stat_id: '9', value: '0.1' } },
              { stat: { stat_id: '10', value: '6' } },
              { stat: { stat_id: '11', value: '0.5' } },
              { stat: { stat_id: '12', value: '0.1' } },
              { stat: { stat_id: '13', value: '6' } },
              { stat: { stat_id: '18', value: '-2' } },
            ],
          },
        }],
      },
    ],
  },
};

export const TEAMS_RESPONSE = {
  fantasy_content: {
    league: [
      { league_key: '449.l.123456' },
      {
        teams: {
          0: {
            team: [
              [
                { team_key: '449.l.123456.t.1' },
                { team_id: '1' },
                { name: 'Gridiron Oracle' },
                { is_owned_by_current_login: 1 },
                { waiver_priority: 4 },
                { faab_balance: '67' },
                { number_of_moves: '9' },
                { number_of_trades: '1' },
                { managers: [{ manager: { nickname: 'You', guid: 'ABC123', is_current_login: '1' } }] },
              ],
              {
                team_standings: {
                  rank: '3',
                  outcome_totals: { wins: '5', losses: '3', ties: '0', percentage: '.625' },
                  points_for: '1129.4',
                  points_against: '1010.2',
                },
              },
            ],
          },
          1: {
            team: [
              [
                { team_key: '449.l.123456.t.2' },
                { team_id: '2' },
                { name: 'Box Score Bandits' },
                { waiver_priority: 7 },
                { faab_balance: '0' },
                { number_of_moves: '18' },
                { number_of_trades: '0' },
                { managers: [{ manager: { nickname: 'Tommy', guid: 'DEF456' } }] },
              ],
              {
                team_standings: {
                  rank: '5',
                  outcome_totals: { wins: '4', losses: '4', ties: '0' },
                  points_for: '1056.3',
                  points_against: '1080.1',
                },
              },
            ],
          },
          count: 2,
        },
      },
    ],
  },
};

export const ROSTER_RESPONSE = {
  fantasy_content: {
    team: [
      [
        { team_key: '449.l.123456.t.1' },
        { team_id: '1' },
        { name: 'Gridiron Oracle' },
      ],
      {
        roster: {
          0: {
            players: {
              0: {
                player: [
                  [
                    { player_key: '449.p.30977' },
                    { player_id: '30977' },
                    { name: { full: 'Marcus Whitfield', first: 'Marcus', last: 'Whitfield' } },
                    { editorial_team_abbr: 'KC' },
                    { bye_weeks: { week: '10' } },
                    { display_position: 'QB' },
                    { primary_position: 'QB' },
                    { eligible_positions: [{ position: 'QB' }] },
                    { status: 'Q', status_full: 'Questionable' },
                  ],
                  { selected_position: [{ coverage_type: 'week', week: '9' }, { position: 'QB' }] },
                ],
              },
              1: {
                player: [
                  [
                    { player_key: '449.p.31002' },
                    { player_id: '31002' },
                    { name: { full: 'Devin Barrow' } },
                    { editorial_team_abbr: 'SF' },
                    { bye_weeks: { week: '9' } },
                    { display_position: 'RB' },
                    { primary_position: 'RB' },
                    { eligible_positions: [{ position: 'RB' }, { position: 'W/R/T' }] },
                  ],
                  { selected_position: [{ coverage_type: 'week', week: '9' }, { position: 'BN' }] },
                ],
              },
              count: 2,
            },
          },
        },
      },
    ],
  },
};

export const TRANSACTIONS_RESPONSE = {
  fantasy_content: {
    league: [
      { league_key: '449.l.123456' },
      {
        transactions: {
          0: {
            transaction: [
              [
                { transaction_key: '449.l.123456.tr.44' },
                { transaction_id: '44' },
                { type: 'add/drop' },
                { status: 'successful' },
                { timestamp: '1762300000' },
                { faab_bid: '17' },
              ],
              {
                players: {
                  0: {
                    player: [
                      [
                        { player_key: '449.p.32001' },
                        { player_id: '32001' },
                        { name: { full: 'Wesley Ravenscroft' } },
                        { display_position: 'RB' },
                        { editorial_team_abbr: 'DEN' },
                      ],
                      { transaction_data: [{ type: 'add', source_type: 'waivers', destination_type: 'team', destination_team_key: '449.l.123456.t.2' }] },
                    ],
                  },
                  1: {
                    player: [
                      [
                        { player_key: '449.p.31500' },
                        { player_id: '31500' },
                        { name: { full: 'Corbin Ashworth' } },
                        { display_position: 'WR' },
                        { editorial_team_abbr: 'NYJ' },
                      ],
                      { transaction_data: { type: 'drop', source_type: 'team', source_team_key: '449.l.123456.t.2', destination_type: 'waivers' } },
                    ],
                  },
                  count: 2,
                },
              },
            ],
          },
          count: 1,
        },
      },
    ],
  },
};

export const SCOREBOARD_RESPONSE = {
  fantasy_content: {
    league: [
      { league_key: '449.l.123456' },
      {
        scoreboard: {
          0: {
            matchups: {
              0: {
                matchup: {
                  week: '9',
                  status: 'midevent',
                  is_playoffs: '0',
                  teams: {
                    0: { team: [[{ team_key: '449.l.123456.t.1' }, { name: 'Gridiron Oracle' }], { team_points: { total: '88.4' } }, { team_projected_points: { total: '112.1' } }] },
                    1: { team: [[{ team_key: '449.l.123456.t.2' }, { name: 'Box Score Bandits' }], { team_points: { total: '76.2' } }, { team_projected_points: { total: '104.9' } }] },
                    count: 2,
                  },
                },
              },
              count: 1,
            },
          },
        },
      },
    ],
  },
};
