"use client";

/**
 * /fouls - Fouls board edge finder.
 *
 * Its own route tree and its own engine, deliberately separate from the
 * fantasy games: this is a betting-market tool, it shares no scoring model with
 * them, and per the per-game-independent-identity convention nothing here
 * branches on a game slug.
 *
 * Two input routes. LIVE pulls both ladders and the confirmed lineups straight
 * from SportMonks' bet365 feed (see sportmonksFouls.ts). PASTE stays because
 * fouls markets open late and unevenly, so there will be mornings where the
 * feed has nothing and the board is on screen in front of you.
 *
 * All maths runs in the browser; nothing is written to Supabase.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fitBoard, DEFAULT_ASSUMED_OVERROUND, nbSurvival, STARTERS_SHARE, type Board } from "@/lib/foulsEdge";
import { analyseBoard, ATTRIBUTION_RATE, type Formation } from "@/lib/foulsMatchup";
import { simulateBoard, searchCombos, boardTemperature, type Leg } from "@/lib/foulsCombos";
import { buildBoard, parseTeamSheet } from "@/lib/foulsBoardParser";
import {
  DEFAULT_COMMITTED,
  DEFAULT_FOULED,
  DEFAULT_HOME_SHEET,
  DEFAULT_AWAY_SHEET,
} from "@/lib/foulsSampleBoard";

type Fixture = { id: number; name: string; league: string; kickoff: string };

type LiveState = {
  board: Board;
  formations: Formation[];
  lineupsConfirmed: boolean;
  hasFoulsMarkets: boolean;
  bookmakerUpdatedAt: string | null;
  notes: string[];
  fixtureName: string;
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export default function FoulsPage() {
  const [source, setSource] = useState<"live" | "paste">("live");

  // --- live ---
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixtureId, setFixtureId] = useState<number | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- paste ---
  const [homeTeam, setHomeTeam] = useState("Fulham");
  const [awayTeam, setAwayTeam] = useState("Chelsea");
  const [homeShape, setHomeShape] = useState("4-2-3-1");
  const [awayShape, setAwayShape] = useState("3-4-3");
  const [homeSheet, setHomeSheet] = useState(DEFAULT_HOME_SHEET);
  const [awaySheet, setAwaySheet] = useState(DEFAULT_AWAY_SHEET);
  const [committedText, setCommittedText] = useState(DEFAULT_COMMITTED);
  const [fouledText, setFouledText] = useState(DEFAULT_FOULED);

  const [overround, setOverround] = useState(DEFAULT_ASSUMED_OVERROUND);
  const [expectedFouls, setExpectedFouls] = useState(21);
  const [tab, setTab] = useState<"likely" | "edges" | "duels" | "combos">("likely");

  useEffect(() => {
    fetch("/api/fouls/fixtures?days=10")
      .then((r) => r.json())
      .then((d) => setFixtures(d.fixtures ?? []))
      .catch(() => setFixtures([]));
  }, []);

  const loadFixture = useCallback(async (id: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(`/api/fouls/board?fixtureId=${id}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setLive(d as LiveState);
    } catch (err) {
      setLive(null);
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const result = useMemo(() => {
    try {
      let board: Board;
      let formations: Formation[];
      let warnings: string[] = [];

      if (source === "live") {
        if (!live) return { errors: [] as string[], idle: true };
        if (!live.hasFoulsMarkets || live.formations.length < 2) {
          return { errors: [] as string[], notes: live.notes, idle: true };
        }
        board = live.board;
        formations = live.formations;
        warnings = live.notes;
      } else {
        const home = parseTeamSheet(homeTeam, homeShape, homeSheet);
        const away = parseTeamSheet(awayTeam, awayShape, awaySheet);
        const errors = [...home.errors, ...away.errors];
        if (home.formation.slots.length < 7 || away.formation.slots.length < 7) {
          return { errors: [...errors, "Both team sheets need at least 7 players."] };
        }
        const built = buildBoard(committedText, fouledText, home.formation, away.formation);
        board = built.board;
        formations = [home.formation, away.formation];
        warnings = built.warnings;
        if (errors.length) warnings = [...errors, ...warnings];
      }

      if (board.committed.length < 4 || board.toBeFouled.length < 4) {
        return {
          errors: ["Need at least 4 players priced in each market."],
          warnings,
        };
      }

      const fit = fitBoard(board, overround);
      const analysis = analyseBoard(fit, formations[0], formations[1]);
      const sim = simulateBoard(analysis, { draws: 20000, seed: 7 });
      const temp = boardTemperature(sim, expectedFouls);

      const candidates: Leg[] = analysis.edges
        .filter((e) => e.edge > 0 && e.decimal <= 8)
        .slice(0, 14)
        .map((e) => ({
          player: e.player,
          team: e.team,
          market: e.market,
          line: e.line,
          decimal: e.decimal,
          fractional: e.fractional,
        }));
      const combos = searchCombos(sim, candidates, { maxLegs: 3, top: 8, minJointProb: 0.05 });
      const startersTotal = fit.committed.reduce((a, f) => a + f.mu, 0);

      return { errors: [], warnings, board, fit, analysis, sim, temp, combos, startersTotal };
    } catch (err) {
      return { errors: [`Could not analyse this board: ${(err as Error).message}`] };
    }
  }, [
    source, live, homeTeam, awayTeam, homeShape, awayShape, homeSheet, awaySheet,
    committedText, fouledText, overround, expectedFouls,
  ]);

  const likelyRows = useMemo(() => {
    if (!("analysis" in result) || !result.analysis || !result.fit) return [];
    const { analysis, fit } = result;
    return fit.committed
      .map((f) => {
        const mu = analysis.consensusMu.get(`committed|${f.name}`) ?? f.mu;
        const p1 = nbSurvival(1, mu, fit.size);
        const p2 = nbSurvival(2, mu, fit.size);
        const p3 = nbSurvival(3, mu, fit.size);
        const e1 = analysis.edges.find((e) => e.market === "committed" && e.player === f.name && e.line === 1);
        const e2 = analysis.edges.find((e) => e.market === "committed" && e.player === f.name && e.line === 2);
        return { name: f.name, team: f.team, mu, p1, p2, oneOrTwo: p1 - p3, e1, e2 };
      })
      .sort((a, b) => b.p2 - a.p2);
  }, [result]);

  return (
    <main className="min-h-screen bg-navy-950 text-navy-100">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-6">
          <Link href="/" className="text-sm text-navy-400 hover:text-sky-400">
            &larr; Hail Mary
          </Link>
          <h1 className="mt-2 text-3xl font-semibold">Fouls Board</h1>
          <p className="mt-2 max-w-3xl text-sm text-navy-300">
            Fits a count distribution to every price ladder, checks the two boards against
            each other (every foul has a committer and a victim, so they must agree), maps
            the duels from the confirmed lineups, and ranks what is worth backing.
          </p>
        </header>

        <div className="mb-6 flex gap-2">
          {(
            [
              ["live", "Live from bet365"],
              ["paste", "Paste a board"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSource(key)}
              className={`rounded px-3 py-1.5 text-sm ${
                source === key
                  ? "bg-sky-500 font-medium text-navy-950"
                  : "bg-navy-800 text-navy-300 hover:bg-navy-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {source === "live" ? (
          <section className="mb-8 rounded-lg bg-navy-900 p-4 ring-1 ring-navy-700">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block flex-1 min-w-[280px]">
                <span className="mb-1 block text-xs font-medium text-navy-200">Fixture</span>
                <select
                  value={fixtureId ?? ""}
                  onChange={(e) => {
                    const id = parseInt(e.target.value, 10);
                    setFixtureId(id);
                    if (isFinite(id)) loadFixture(id);
                  }}
                  className="w-full rounded bg-navy-950 px-2 py-1.5 text-sm ring-1 ring-navy-700 focus:ring-sky-500"
                >
                  <option value="">Select a fixture&hellip;</option>
                  {fixtures.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.kickoff.slice(0, 16)} · {f.league} · {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => fixtureId && loadFixture(fixtureId)}
                disabled={!fixtureId || loading}
                className="rounded bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 disabled:opacity-40"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {loadError && <p className="mt-3 text-sm text-rose-400">{loadError}</p>}

            {live && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <Pill ok={live.hasFoulsMarkets}>
                  {live.hasFoulsMarkets ? "Fouls markets posted" : "No fouls markets yet"}
                </Pill>
                <Pill ok={live.lineupsConfirmed}>
                  {live.lineupsConfirmed ? "Lineups confirmed" : "Lineups not out yet"}
                </Pill>
                {live.bookmakerUpdatedAt && (
                  <span className="rounded bg-navy-800 px-2 py-1 text-navy-400">
                    bet365 updated {live.bookmakerUpdatedAt}
                  </span>
                )}
                <span className="rounded bg-navy-800 px-2 py-1 text-navy-400">
                  {live.board.committed.length} committed · {live.board.toBeFouled.length} to-be-fouled ladders
                </span>
              </div>
            )}
            {live?.notes?.map((n) => (
              <p key={n} className="mt-2 text-xs text-amber-300/90">
                {n}
              </p>
            ))}
          </section>
        ) : (
          <>
            <section className="mb-6 grid gap-4 lg:grid-cols-2">
              <Panel title="Fouls committed">
                <Paste value={committedText} onChange={setCommittedText} />
              </Panel>
              <Panel title="To be fouled">
                <Paste value={fouledText} onChange={setFouledText} />
              </Panel>
              <Panel title="Home team sheet">
                <TeamInputs
                  team={homeTeam}
                  setTeam={setHomeTeam}
                  shape={homeShape}
                  setShape={setHomeShape}
                  sheet={homeSheet}
                  setSheet={setHomeSheet}
                />
              </Panel>
              <Panel title="Away team sheet">
                <TeamInputs
                  team={awayTeam}
                  setTeam={setAwayTeam}
                  shape={awayShape}
                  setShape={setAwayShape}
                  sheet={awaySheet}
                  setSheet={setAwaySheet}
                />
              </Panel>
            </section>
          </>
        )}

        <section className="mb-8 flex flex-wrap items-end gap-6 rounded-lg bg-navy-900 p-4 ring-1 ring-navy-700">
          <Field
            label="Assumed overround %"
            hint="Bookmaker margin per rung. Cannot be read off one-sided prices, so it must be supplied."
            value={overround}
            onChange={setOverround}
          />
          <Field
            label="Expected match fouls"
            hint="Both full teams. Used only to judge whether the board is running hot."
            value={expectedFouls}
            onChange={setExpectedFouls}
          />
        </section>

        {"errors" in result && result.errors && result.errors.length > 0 && (
          <Notice tone="error" items={result.errors} title="Input problems" />
        )}
        {"warnings" in result && result.warnings && result.warnings.length > 0 && (
          <Notice tone="warn" items={result.warnings} title="Warnings" />
        )}

        {"idle" in result && result.idle && (
          <p className="rounded-lg bg-navy-900 p-6 text-center text-sm text-navy-400 ring-1 ring-navy-700">
            {source === "live"
              ? "Pick a fixture above. If its fouls markets are not posted yet, switch to Paste a board."
              : "Paste a board to begin."}
          </p>
        )}

        {"analysis" in result && result.analysis && result.fit && result.temp && (
          <>
            <section className="mb-8 grid gap-4 md:grid-cols-3">
              <Stat
                label="Board implies"
                value={`${(result.startersTotal! / STARTERS_SHARE).toFixed(1)} fouls`}
                sub={`vs ${expectedFouls} expected · running ${result.temp.verdict}`}
                tone={result.temp.verdict === "hot" ? "bad" : "neutral"}
              />
              {result.analysis.conservation.map((c) => (
                <Stat
                  key={c.team}
                  label={`${c.team} commit vs ${c.opponent} fouled`}
                  value={signed(c.ratio - 1)}
                  sub={
                    c.ratio > 1
                      ? `to-be-fouled board is ${(c.ratio * 100 - 100).toFixed(0)}% richer than committed supports`
                      : "committed board is richer than to-be-fouled supports"
                  }
                  tone={Math.abs(c.ratio - 1) > 0.08 ? "good" : "neutral"}
                />
              ))}
            </section>

            <nav className="mb-4 flex flex-wrap gap-2">
              {(
                [
                  ["likely", "Most likely to commit"],
                  ["edges", "Best value"],
                  ["duels", "Duel map"],
                  ["combos", "Combos"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    tab === key
                      ? "bg-sky-500 font-medium text-navy-950"
                      : "bg-navy-800 text-navy-300 hover:bg-navy-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            {tab === "likely" && (
              <Panel title="Most likely to commit fouls">
                <Table
                  head={["Player", "Team", "xFouls", "1+", "price", "edge", "2+", "price", "edge", "1 or 2"]}
                  rows={likelyRows.map((r) => [
                    r.name, r.team, r.mu.toFixed(2), pct(r.p1), r.e1?.fractional ?? "-",
                    r.e1 ? <Edge key="a" v={r.e1.edge} /> : "-",
                    pct(r.p2), r.e2?.fractional ?? "-",
                    r.e2 ? <Edge key="b" v={r.e2.edge} /> : "-",
                    pct(r.oneOrTwo),
                  ])}
                />
                <Legend
                  rows={[
                    ["xFouls", "How many fouls we expect this player to commit."],
                    ["1+ / 2+", "Our chance he commits at least that many. 66% = two times in three."],
                    ["price", "What the bookmaker is offering."],
                    ["edge", "Green means the price is longer than the chance deserves — value. Grey means it is too short."],
                    ["1 or 2", "Chance of exactly one or two fouls. It peaks around 1.3 expected fouls, so it comes out near 55% for almost everyone and separates players poorly. The 2+ column is the useful one."],
                  ]}
                />
              </Panel>
            )}

            {tab === "edges" && (
              <Panel title="Best value on the board">
                <Table
                  head={["Player", "Market", "Line", "Price", "Fair", "Edge", "Kelly", "Why"]}
                  rows={result.analysis.edges.slice(0, 25).map((e) => [
                    e.player,
                    e.market === "committed" ? "commits" : "fouled",
                    `${e.line}+`,
                    e.fractional ?? "-",
                    e.fairDecimal.toFixed(2),
                    <Edge key="e" v={e.edge} />,
                    `${(e.kelly * 100).toFixed(1)}%`,
                    <span key="w" className="text-xs text-navy-400">{e.reasons.join("; ") || "-"}</span>,
                  ])}
                />
                <Legend
                  rows={[
                    ["Line", "“2+” means two or more fouls."],
                    ["Price", "What the bookmaker offers."],
                    ["Fair", "What we think it is worth, as a decimal price. If Fair is 2.10 and they offer 2.20, you are getting the better of it."],
                    ["Edge", "The gap between those two, as a percentage. Positive is value."],
                    ["Kelly", "The share of your betting bankroll this bet mathematically justifies. Most people bet a quarter of Kelly or less."],
                    ["Why", "Which of the checks flagged it — the cross-board gap, the duel map, or the rung sitting off the player's own ladder."],
                  ]}
                />
                <Caveat>
                  Edge here is relative to <em>this board</em>, not a promise of profit. It moves
                  with the assumed overround above. The ordering is far more reliable than the level.
                </Caveat>
              </Panel>
            )}

            {tab === "duels" && (
              <div className="space-y-4">
                {result.analysis.duels.map((d) => (
                  <Panel key={d.committerTeam} title={`${d.committerTeam} fouling ${d.suffererTeam}`}>
                    <div className="grid gap-6 md:grid-cols-2">
                      <div>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-navy-400">
                          Where the clashes are
                        </h4>
                        <Table
                          head={["Committer", "Victim", "Fouls"]}
                          rows={d.flows.slice(0, 10).map((f) => [f.committer, f.sufferer, f.fouls.toFixed(2)])}
                        />
                      </div>
                      <div>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-navy-400">
                          Market vs duel structure
                        </h4>
                        <Table
                          head={["Player", "Market", "Duels", "Ratio"]}
                          rows={[...d.sufferDiagnostics]
                            .sort((a, b) => b.ratio - a.ratio)
                            .map((s) => [
                              s.player,
                              s.marketMu.toFixed(2),
                              s.structuralMu.toFixed(2),
                              <span
                                key="r"
                                className={
                                  s.ratio > 1.25 ? "text-rose-400" : s.ratio < 0.8 ? "text-emerald-400" : "text-navy-300"
                                }
                              >
                                {s.ratio.toFixed(2)}
                              </span>,
                            ])}
                        />
                      </div>
                    </div>
                    <Legend
                      rows={[
                        ["Fouls", "Expected fouls flowing from that committer to that victim over the match. It is where the game's friction actually sits."],
                        ["Market", "Fouls the bookmaker's price says this player will suffer."],
                        ["Duels", "Fouls the formation says he should suffer, given who he is up against."],
                        ["Ratio", "Market divided by Duels. Red (above 1.25) means the bookmaker rates him higher than the matchup justifies — his to-be-fouled price is too short. Green (below 0.8) means the opposite, and is where value hides."],
                      ]}
                    />
                  </Panel>
                ))}
              </div>
            )}

            {tab === "combos" && (
              <Panel title="Multi-leg combinations">
                <Table
                  head={["Legs", "Joint", "Corr", "Naive", "Fair", "Edge if naive"]}
                  rows={result.combos!.map((c) => [
                    <span key="l" className="text-xs">
                      {c.legs
                        .map((l) => `${l.player} ${l.line}+ ${l.market === "committed" ? "commits" : "fouled"}`)
                        .join("  +  ")}
                    </span>,
                    pct(c.jointProb),
                    c.correlationPremium.toFixed(3),
                    c.naiveDecimal.toFixed(2),
                    c.fairDecimal.toFixed(2),
                    <Edge key="e" v={c.edgeAtNaivePrice} />,
                  ])}
                />
                <Legend
                  rows={[
                    ["Joint", "How often all the legs land together. 5% means about one time in twenty."],
                    ["Corr", "How much more often they land together than if they were unrelated. 1.24 means 24% more often — fouls bunch up, because a fussy referee or a niggly game lifts everyone's count at once."],
                    ["Naive", "The price you would get if your bet builder simply multiplied the legs together, like an ordinary accumulator."],
                    ["Fair", "What the combination is genuinely worth once that bunching is accounted for."],
                    ["Edge if naive", "The gap between Naive and Fair — but only real if your bookmaker actually multiplies. Most bet builders price correlation in, so treat Fair as the number that matters."],
                  ]}
                />
                <Caveat>
                  Use the <strong>Fair</strong> column as a price test. Build the combination in your
                  bet builder and look at what it quotes: above Fair is worth taking, below Fair is
                  not, however big the number looks.
                </Caveat>
              </Panel>
            )}

            <footer className="mt-8 rounded-lg bg-navy-900 p-4 text-xs text-navy-400 ring-1 ring-navy-700">
              <p className="mb-1">
                Fitted dispersion {result.fit.size} · margin exponent{" "}
                {result.fit.kappaCommitted.toFixed(3)} / {result.fit.kappaToBeFouled.toFixed(3)} ·{" "}
                {result.sim!.draws.toLocaleString()} simulations ·{" "}
                {(result.sim!.sharedVarianceShare * 100).toFixed(0)}% of variance is match-wide ·
                attribution {ATTRIBUTION_RATE}
              </p>
              <p>
                Ladders and lineups come from bet365 via SportMonks. Fouls markets open late and
                unevenly, so an empty board usually means not-yet-posted rather than an error.
              </p>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

/* ========================================================================== *
 * Presentation helpers
 * ========================================================================== */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-navy-900 p-4 ring-1 ring-navy-700">
      <h3 className="mb-3 text-sm font-medium text-navy-200">{title}</h3>
      {children}
    </div>
  );
}

function Paste({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={11}
      spellCheck={false}
      className="w-full rounded bg-navy-950 p-3 font-mono text-xs text-navy-100 outline-none ring-1 ring-navy-700 focus:ring-sky-500"
    />
  );
}

function TeamInputs({
  team, setTeam, shape, setShape, sheet, setSheet,
}: {
  team: string; setTeam: (v: string) => void;
  shape: string; setShape: (v: string) => void;
  sheet: string; setSheet: (v: string) => void;
}) {
  return (
    <>
      <div className="mb-2 flex gap-2">
        <input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          className="w-2/3 rounded bg-navy-950 px-2 py-1 text-sm ring-1 ring-navy-700 focus:ring-sky-500"
        />
        <input
          value={shape}
          onChange={(e) => setShape(e.target.value)}
          className="w-1/3 rounded bg-navy-950 px-2 py-1 text-sm ring-1 ring-navy-700 focus:ring-sky-500"
        />
      </div>
      <Paste value={sheet} onChange={setSheet} />
    </>
  );
}

function Field({
  label, hint, value, onChange,
}: {
  label: string; hint: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-navy-200">{label}</span>
      <input
        type="number"
        value={value}
        step={1}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-32 rounded bg-navy-950 px-2 py-1 text-sm ring-1 ring-navy-700 focus:ring-sky-500"
      />
      <span className="mt-1 block max-w-xs text-[11px] text-navy-400">{hint}</span>
    </label>
  );
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded px-2 py-1 ${
        ok ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
      }`}
    >
      {children}
    </span>
  );
}

function Stat({
  label, value, sub, tone,
}: {
  label: string; value: string; sub: string; tone: "good" | "bad" | "neutral";
}) {
  const colour = tone === "bad" ? "text-rose-400" : tone === "good" ? "text-sky-400" : "text-navy-100";
  return (
    <div className="rounded-lg bg-navy-900 p-4 ring-1 ring-navy-700">
      <div className="text-xs uppercase tracking-wide text-navy-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${colour}`}>{value}</div>
      <div className="mt-1 text-xs text-navy-400">{sub}</div>
    </div>
  );
}

function Edge({ v }: { v: number }) {
  return (
    <span className={v > 0 ? "text-emerald-400" : "text-navy-400"}>
      {v >= 0 ? "+" : ""}
      {(v * 100).toFixed(1)}%
    </span>
  );
}

/**
 * Plain-English column glossary, rendered directly beneath the table it
 * describes rather than in a help page - these columns are the whole product,
 * and a reader should never have to guess what "Corr" means.
 */
function Legend({ rows }: { rows: [string, string][] }) {
  return (
    <div className="mt-4 rounded border border-navy-700/70 bg-navy-950/40 p-3">
      <h5 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-navy-400">
        What these columns mean
      </h5>
      <dl className="space-y-1.5">
        {rows.map(([term, meaning]) => (
          <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="shrink-0 font-mono text-xs text-sky-300 sm:w-32">{term}</dt>
            <dd className="text-xs text-navy-300">{meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200/90">
      {children}
    </p>
  );
}

function Notice({ tone, title, items }: { tone: "error" | "warn"; title: string; items: string[] }) {
  return (
    <div
      className={`mb-6 rounded-lg p-4 ring-1 ${
        tone === "error" ? "bg-rose-950/40 ring-rose-800" : "bg-amber-950/30 ring-amber-800/60"
      }`}
    >
      <h4 className="mb-1 text-sm font-medium">{title}</h4>
      <ul className="list-inside list-disc text-xs text-navy-200">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-navy-700 text-left text-xs uppercase tracking-wide text-navy-400">
            {/* Keyed by index, not label: several tables repeat a heading
                (a price and an edge column for each of 1+ and 2+). */}
            {head.map((h, i) => (
              <th key={i} className="py-2 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-navy-800/60">
              {r.map((c, j) => (
                <td key={j} className="py-1.5 pr-3 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
