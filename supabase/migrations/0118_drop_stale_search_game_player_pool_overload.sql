-- search_game_player_pool has accumulated a stale, unused overload.
-- Migrations 0099 -> 0100 -> 0101 -> 0114 -> 0115 each used
-- `create or replace function search_game_player_pool(...)` but changed
-- the argument list along the way - Postgres treats a differing arg list
-- as a NEW overload, not a replacement of the old one, so the original
-- 10-arg version from migration 0099 was never actually dropped, just
-- shadowed.
--
-- Confirmed live via pg_proc: exactly 2 overloads exist today -
--   1. p_game_slug, p_gameweek, p_position, p_team_name, p_competition,
--      p_search, p_exclude_ids, p_max_price, p_limit, p_offset (10 args,
--      no p_sort_by/p_exclude_club - dead, from migration 0099)
--   2. the same 8 args + p_sort_by, p_exclude_club, then p_limit,
--      p_offset (12 args - the real one, from migration 0115)
-- frontend-v2/src/lib/poolSearch.ts always calls with named params
-- including p_sort_by/p_exclude_club, so it always resolves to the
-- 12-arg overload - the 10-arg one is unreachable dead schema clutter,
-- not a live bug, purely a cleanup.

drop function if exists search_game_player_pool(text, integer, text, text, text, text, bigint[], numeric, integer, integer);
