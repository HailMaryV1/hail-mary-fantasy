-- Wires the rotation-risk signal (migration 0111) into Ask Mary's
-- recommendation search (2026-08-09 user request: "it keeps putting cherki
-- and foden in my team ... likely sharing minutes"). Two additive columns
-- are needed to make a contested pair actionable in code rather than just
-- displayable text:
--
-- 1. player_rotation_risk.contender_player_id - the badge only ever needed
--    contender_name for display. Turning "you have a contested slot" into
--    "don't also buy/keep this SPECIFIC other player" requires the
--    contender's own player_id, not just their name.
-- 2. game_player_pool.player_id - the pool view only ever exposed
--    game_player_id (game-scoped). Matching a pool row to its rotation-risk
--    entry (keyed by the game-independent players.id) needs the bridge.
create or replace view player_rotation_risk as
with latest as (
    select * from player_lineup_probability_latest
),
best_slot as (
    select distinct on (player_id)
        player_id, team_id, position_slot, slot_rank, start_probability
    from latest
    where player_id is not null
    order by player_id, start_probability desc
),
closest_contender as (
    select
        bs.player_id,
        c.raw_name as contender_name,
        c.start_probability as contender_probability,
        c.player_id as contender_player_id
    from best_slot bs
    join lateral (
        select l.player_id, l.raw_name, l.start_probability
        from latest l
        where l.team_id = bs.team_id
          and l.position_slot = bs.position_slot
          and l.slot_rank <> bs.slot_rank
        order by abs(l.slot_rank - bs.slot_rank) asc, l.start_probability desc
        limit 1
    ) c on true
)
select
    bs.player_id,
    bs.team_id,
    bs.position_slot,
    bs.slot_rank,
    bs.start_probability,
    cc.contender_name,
    cc.contender_probability,
    case
        when bs.start_probability >= 85 then 'nailed'
        when bs.start_probability < 65 and cc.contender_probability >= 25 then 'high_risk'
        when bs.start_probability < 80 and cc.contender_probability >= 20 then 'some_risk'
        else 'nailed'
    end as risk_level,
    cc.contender_player_id
from best_slot bs
left join closest_contender cc on cc.player_id = bs.player_id;

create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    gp.position_code as position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    coalesce(proj_for_current_gw.hail_mary_score, proj_fallback.hail_mary_score) as hail_mary_score,
    fanteam_status.lineup,
    coalesce(fanteam_status.status, eflfantasy_status.status) as status,
    fanteam_status.form,
    gp.competition,
    p.id as player_id
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select gfg.gameweek
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    where gfg.game_id = gp.game_id and f.kickoff_at >= now()
    order by gfg.gameweek asc, f.kickoff_at asc
    limit 1
) current_gw on true
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
      and pr.gameweek is not distinct from current_gw.gameweek
    order by pr.created_at desc
    limit 1
) proj_for_current_gw on true
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) proj_fallback on true
left join lateral (
    select s.lineup, s.status, s.form
    from fanteam_player_status s
    where s.game_player_id = gp.id and fg.slug = 'fanteam'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) fanteam_status on true
left join lateral (
    select s.status
    from eflfantasy_player_status s
    where s.game_player_id = gp.id and fg.slug = 'eflfantasy'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) eflfantasy_status on true
where gp.is_active;
