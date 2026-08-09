-- Rotation-risk badge (2026-08-08 user request), built directly on the
-- lineup-probability data landed in migration 0110. The signal isn't
-- "is this player good" - it's "does this player have a real contest for
-- their own slot", which the graphics already encode as multiple
-- candidates per (team, position_slot) with their own modelled
-- percentage. A player's own probability being low without a strong
-- teammate behind them isn't risk (see game_player_pool's own docstring
-- pattern for the same distinction elsewhere); risk only exists when a
-- REAL competitor is close behind.
--
-- player_lineup_probability_latest collapses to the most recent
-- snapshot_date per (team, slot, rank) so re-running the weekly import
-- naturally supersedes last week's picture rather than averaging across
-- them - a rotation battle is a today's-team-news thing, not a season
-- trend.
create or replace view player_lineup_probability_latest as
select distinct on (team_id, position_slot, slot_rank)
    team_id, formation, position_slot, slot_rank, player_id, raw_name,
    start_probability, is_new_signing, snapshot_date
from player_lineup_probability
order by team_id, position_slot, slot_rank, snapshot_date desc;

-- One row per matched player_id, using their single highest-probability
-- slot (a player can appear as a candidate in more than one slot on the
-- graphic, e.g. a winger also listed at CAM - the slot they're most
-- likely to actually play in is the one that matters for risk).
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
        c.start_probability as contender_probability
    from best_slot bs
    join lateral (
        select l.raw_name, l.start_probability
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
    end as risk_level
from best_slot bs
left join closest_contender cc on cc.player_id = bs.player_id;
