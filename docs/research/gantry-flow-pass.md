# GANTRY POINT — Flow Pass (research)

> **STATUS: implemented 2026-06-12** — 44-waypoint reprofile (215 sections), see `src/game/levels/gantryPoint.ts` and `src/game/levels/gantry/*`; placement truth in `tools/audit-merge-gantry.mjs`.

**Premise in one line:** in Burnout you usually never brake — you drift, on the boost,
all the time; some parts of GANTRY POINT are not designed for that. This document
measures exactly which parts, against what the player's drift can physically hold,
and proposes a revised waypoint table that converts the accidental brake traps into
drift sweepers while keeping the deliberate slow pockets the GDD wants.

Research-only: no code was changed. All numbers below come from a scratch replica of
`buildLoopSections` (`src/game/race.ts`) verified **byte-identical** against the live
bundled level (220 sections, max diff 0.0), and from the drift/grip constants in
`src/game/control.ts`. Companion to `docs/gantry-point-gdd.md`.

---

## 1. What Criterion actually built (the research)

The design bar GANTRY POINT aims at is Burnout 3's, so first: how B3 corners work.

1. **Tracks are built around the slide, and the slide needs width.** Alex Ward
   (Director of Design): "The tracks are built around how the cars slide … a bad
   racing game is one where you bounce around the walls all the time." Roads were
   made "really wide, much wider than real life" — roughly **twice realistic width** —
   and then the cars were made "twice as fast" to win the speed feel back
   ([PlayStation.Blog, Classic Levels Deconstructed: Alpine](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/)).
2. **The default corner is a sweeper you drift, not a bend you brake for.** The same
   deconstruction describes Alpine's "huge corners that beg to be drifted through."
   Drift is B3's corner *tool*: "heavy braking and acceleration in quick succession"
   only to break traction, then the slide carries the corner and feeds the boost
   economy ([Burnout Wiki: Drift](https://burnout.fandom.com/wiki/Drift)).
3. **Hairpins and 90°s exist — but the documented choice is still the drift.** On
   Waterfront, the wiki's corner-by-corner guidance is: at the hairpin you "either
   slow down to make the sharp turn, or drift around it"; through the post-junction
   90°s "it is recommended to drift around these"
   ([Burnout Wiki: Waterfront (Burnout 3)](https://burnout.fandom.com/wiki/Waterfront_(Burnout_3))).
   So the B3 corner language has three words, not two: **sweeper (flat), 90° (drift),
   hairpin (the rare deliberate exception where braking is allowed to exist)**. A lap
   gets one or two exceptions, not seven.
4. **Pace variety comes from traffic, furniture and the pack — not from geometry
   stops.** B3 tracks are "designed with crashes in mind, as walls, pillars, and
   other obstacles are littered over these tracks in addition to all the traffic"
   ([zerokspot review, 2004](https://zerokspot.com/weblog/2004/10/03/burnout-3-a-review/));
   takedown opportunity placement was the explicit AI/track design goal. Notably,
   **B3 had no shortcuts** — alternate routes arrived with Revenge
   ([3rd Voice Gaming, Burnout retrospectives](https://3rdvoicegaming.com/2018/05/13/burnout-retrospective-part-six-burnout-dominator-2007/));
   our four cuts are a Revenge-ism layered on a B3 ring, which is fine, but it means
   the *main loop* must carry B3 flow on its own — the cuts can't excuse a slow main line.
5. **The pack concertinas by AI rule, not by geometry.** Paradise ships rival pacing
   as data — AISections speed classes (`VERY_SLOW…VERY_FAST`) plus rubber-band
   multiplier curves ([burnout.wiki: AISections](https://burnout.wiki/wiki/AI_Sections),
   mirrored in `../../../docs/AISections.md`) — and the racing-AI literature's
   rubber-band/dead-zone rules (Nic Melder, *Game AI Pro* ch. 42,
   [gameaipro.com](https://www.gameaipro.com/)) keep the field glued regardless of
   corner radii. Our `race.ts` already implements exactly this. The implication is
   the key design lever of this whole document: **you do not need brake-trap
   geometry to make the pack bunch — the AI's conservative speed classes do it for
   free** (see §4).

---

## 2. What our drift can physically hold (control.ts, derived)

In a drift, the path bends at `slip × DRIFT_CARVE` rad/s, with slip capped at
`DRIFT_MAX_SLIP` = 40° and the slip *target* scaled by `clamp(v/30, 0.7, 1)`
(`src/game/control.ts`). Two consequences dominate everything below:

- **Minimum drift radius is `v / ω`** with ω = 1.117 rad/s at v ≥ 30 — and because
  the slip target scales with v below 30, the radius floor is **constant ≈ 26.9 m
  for every speed between 21 and 30 m/s**. A corner tighter than ~27 m cannot be
  held by a clean drift at *any* respectable speed.
- **The brake pedal does not work in a drift** (`input.brake && !this.drifting`);
  mid-drift taps only deepen the slip (+10°, decaying 0.6 s), and drift scrub bleeds
  ≤ 3.5 m/s². Speed must be set *before* the corner — which is why tight geometry
  after a 38 m/s straight forces a true 26 m/s² brake stab. That stab is exactly the
  feeling the premise complains about.

| speed | clean-drift R_min | tap-spam R_min | gripped R (steady state) |
| --- | --- | --- | --- |
| 18 m/s | 23.0 m | 17.9 m | 8.6 m |
| 22 m/s | 26.9 m | 21.1 m | 10.4 m |
| 26 m/s | 26.9 m | 23.3 m | 13.0 m |
| 30 m/s | 26.9 m | 26.9 m | 17.2 m |
| 34 m/s | 30.4 m | 30.4 m | 25.2 m |
| 38 m/s | 34.0 m | 34.0 m | 46.9 m |
| 48 m/s (boost) | 43.0 m | 43.0 m | 46.9 m |

(Tap-spam = re-tapping the brake ~3/s to keep the +10° tighten topped up — expert
tech, ~+8° average slip below 30 m/s.) Gripped steering out-corners the drift below
~34 m/s but **collapses to R 47 m at top speed** (the fast-fading lock) — so at race
pace the drift is strictly the better corner tool, exactly as the file comments
intend ("corners want the drift").

That yields an objective four-band bar on **true centreline radius**:

| centreline R | verdict | what it means at the wheel |
| --- | --- | --- |
| ≥ 43 m | **boost-flat** | hold the drift at 48 m/s, never lift |
| 34–43 m | **flat-out drift** | hold at 38; lift off boost only |
| 27–34 m | **committed drift** | shed to ~1.117·R (30–38) by lift + early slide — still no brake |
| 23–27 m | **marginal** | slow drift at 18–21, or tap-spam at ~24–28 |
| < 23 m | **brake trap** | drift physically cannot hold it; brake-to-grip corner |

For reference, the AI formula `v = clamp(√(16R), 18, 38)` assumes a 16 m/s² lateral
budget; a full drift at 30–38 m/s sustains **33–42 m/s²** — 2.1–2.7× more. Every
corner is therefore *much* faster for a drifting player than its section class, which
is the entire flow story. (Side note: the section-R computation divides by the
*nominal* 8 m spacing while the resampler's effective spacing is ~9.45 m, so the AI
classes underestimate geometry by a further ~18%; passing the measured spacing into
`finishSections` would raise all AI corner speeds ~9% — an optional, separate lever.)

---

## 3. The lap as it is — every pocket below 26 m/s

Current loop: 220 sections, 2 080 m, `sum(8/v)` = 61.8 s, min/max class 18/38.
Pocket = contiguous run of sections with class < 26 m/s. `R` = true centreline
radius (circumradius over the pocket), the player columns from §2's model.

| # | sections (~arc) | corner | min class | R (m) | drift holds | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 23–24 (235 m) | horseshoe outer | 23.4 | 38.6 | 43 (boost-flat) | flowing already |
| 2 | 27–29 (270 m) | **Cannery Point apex** | 18.5 | 26.6 | 21 / 30 spam | **marginal — fix** |
| 3 | 35–36 (343 m) | Crane Alley approach | 21.1 | 45.1 | 48 | flowing (AI-only lift) |
| 4 | 38–41 (368 m) | **port gate fork (CRANE SMASH)** | 18.0 | 14.8 | — | **brake trap — KEEP** |
| 5 | 53–61 (506 m) | Port Detour / dock street | 20.0 | 29.0 | 32 | committed drift — keep |
| 6 | 73, 77 (689 m) | port exit, quay rejoin | 23–24 | 66–180 | 48 | flowing (sampling noise) |
| 7 | 88–90 (819 m) | **headland spike (CLIFF CRASH)** | 18.0 | 22.0 | 17 / 25 spam | **brake trap — fix** |
| 8 | 113–124 (1073 m) | **Lookout Ess** (110 m long!) | 18.0 | 12.0 | impossible | **worst trap — fix** |
| 9 | 149–151 (1433 m) | west coast (brake propagation) | 18.0 | 30.6 | 34 | flowing once flick 1 eases |
| 10 | 154–157 (1480 m) | **chicane flick 1** | 18.0 | 14.3 | impossible | **brake trap — fix** |
| 11 | 160–163 (1534 m) | **chicane flick 2 (ROADBLOCK)** | 18.0 | 12.4 | impossible | **brake trap — KEEP (soften)** |
| 12 | 165–168 (1578 m) | **chicane flick 3** | 18.0 | 13.5 | impossible | **brake trap — KEEP (soften)** |
| 13 | 176–179 (1679 m) | **Beach Run fork turn-in** | 18.0 | 15.7 | impossible | **brake trap — fix** |
| 14 | 188–190 (1786 m) | village street | 19.6 | 26.7 | 21 / 30 spam | marginal — fix |
| 15 | 193–195 (1833 m) | **village 90° S** | 18.0 | 18.8 | 15 / 19 spam | **brake trap — fix** |
| 16 | 197–201 (1868 m) | **village folded 90° + motel** | 18.0 | 12.1 | impossible | **brake trap — fix** |

The lap currently has **eight brake traps**; B3's idiom budgets one or two. The Lookout
Ess is the worst offender — 110 m at the 18 floor with a 12 m fold the drift cannot
touch — followed by the chicane's *three* consecutive stops and the village's two.

---

## 4. The design tension, resolved with the AI's own numbers

The GDD deliberately wants slow pockets "where the pack concertinas and the fighting
happens" (CRANE SMASH, ROADBLOCK, Port Detour, village). The flow pass does **not**
fight that — it exploits the gap between the AI's 16 m/s² budget and the drift's
33–42 m/s²:

> A corner reprofiled to R 27–36 still classes at **21–24 for rivals** — they brake,
> bunch and present themselves exactly as before — while a committed player drift
> carries **30–40 through the same arc**. The concertina survives; only the player's
> brake pedal dies.

So pockets split three ways:

- **Stay slow, geometry untouched (the true pinches):**
  - **CRANE SMASH port-gate fork** (R 15, class 18): the lap's one real stop —
    grip-corner it at ~18–20, or take Harbor Run, which blasts *straight through*
    the fork: the shortcut's reward already includes skipping the only hairpin.
    That is excellent design as-is.
  - **Port Detour** (R 29, class 20–24): "slowest sustained stretch" by GDD decree,
    skippable by Harbor Run, and *already* a committed-drift corridor for the player
    at ~32. No change.
- **Stay slow, but soften from "wall" to "tight" (the theatre):**
  - **ROADBLOCK middle flicks** (R 12.4/13.5 → ~20–22): keep class 18 — still the
    slowest walled pocket on the lap, still the takedown theatre — but at R 20–22 a
    tap-spam drift survives at ~20–24, and the 22 m corridor adds effective radius
    on a clean line (see width note, §7). "Hairpin-lite", not a dead stop.
  - **Village south leg** (new): deliberately *marginal* (R ≈ 24, class 19–23) so
    Beach Run keeps its price and the village keeps its concertina — but the slow
    moment is now one drift-able pocket instead of two impossible folds.
- **Reprofile to drift sweepers (everything else):** Cannery apex, headland spike,
  Lookout Ess, chicane flick 1, Beach-fork turn-in, village street + motel corner.

---

## 5. Proposed waypoint table (blocking input)

44 points (was 42) for `buildLoopSections(WAYPOINTS, 8)`. **Bold** = changed/new;
everything else is byte-identical to `src/game/levels/gantryPoint.ts`. Section
indices elsewhere in this doc are from the rebuilt loop (N = 215) and must be
re-derived via `nearestSection` as always.

| # | x | z | Sector / change |
|---|-----|------|---------------|
| 1 | 0 | -228 | START/FINISH — unchanged |
| 2 | 148 | -220 | south straight — unchanged |
| 3 | 202 | -212 | into the horseshoe — unchanged |
| 4 | **246** | **-192** | horseshoe outer, pushed 4 m out — rounds the arc |
| 5 | **258** | **-154** | Cannery apex +2/+2 — apex R 26.6 → 35.3 (lighthouse clearance re-audited: passes) |
| 6 | **236** | **-118** | horseshoe return +2/+2 |
| 7 | **227** | **-94** | Crane Alley approach +1/+1 — smooths the dogleg the other deltas would have kinked |
| 8 | 230 | -62 | port gate fork — **unchanged (CRANE SMASH pinch kept)** |
| 9–15 | 196,-46 … 198,82 | | Port Detour — **all seven unchanged (kept slow)** |
| 16 | 228 | 100 | quay rejoin — unchanged |
| 17 | 248 | 136 | quay north — unchanged |
| 18 | **257** | **170** | quay north +1/+2 |
| 19 | **264** | **200** | spike apex +2/+4 — hook R 22.0 → 29.7 |
| 20 | **247** | **226** | cliff hook +5/+2 |
| 21 | 204 | 240 | clifftop — unchanged |
| 22 | 144 | 250 | clifftop straight — unchanged |
| 23 | **48** | **239** | ess entry (was 30,244) — fork moves ~18 m east |
| 24 | **20** | **217** | ess arc a (was 10,218) |
| 25 | **-8** | **205** | ess arc b (was -20,216) — dip deepened ~9 m |
| 26 | **-36** | **213** | ess arc c — **new point** (R≈30 bottom arc) |
| 27 | **-72** | **236** | ess exit (was -40,240) — exit moves ~30 m west |
| 28 | -156 | 236 | clifftop W — unchanged |
| 29–31 | -198,210 / -228,170 / -242,124 | | NW sweepers — unchanged (already flowing) |
| 32 | **-226** | **82** | chicane flick 1 (was -214,82) — amplitude −12, R 14.3 → 24.0 |
| 33 | -244 | 40 | flick 2 — **unchanged coordinate; unfolds to R 22 via neighbours (ROADBLOCK kept)** |
| 34 | **-229** | **6** | flick 3 (was -218,2) — amplitude −11, R 13.5 → 20.3 |
| 35 | -246 | -40 | chicane exit — unchanged |
| 36 | **-245** | **-60** | Beach fork arc a — **new point** |
| 37 | **-230** | **-86** | Beach fork arc b (replaces -250,-86) — turn-in R 15.7 → 41.8 |
| 38 | **-206** | **-99** | Beach fork arc c (replaces -202,-100) |
| 39 | **-152** | **-114** | village street (was -154,-114) |
| 40 | **-130** | **-156** | village right sweep (replaces -140,-156) — R 18.8 → 32+ |
| 41 | **-133** | **-185** | village south leg (replaces the -168,-180 / -164,-198 fold) — **deliberately marginal R≈24** |
| 42 | **-122** | **-207** | motel sweep a (replaces -134,-214) |
| 43 | **-96** | **-220** | motel sweep b — **new point**; launches the drift onto the straight |
| 44 | -78 | -226 | merge — unchanged |

### Predicted profile after the pass (same pocket method)

| corner | class (AI min) | true R | player drift | verdict |
| --- | --- | --- | --- | --- |
| horseshoe outer | 24.3 | 39.6 | 44 | flat-out drift |
| Cannery Point apex | 20.7 | 35.3 | 39 | **flat-out drift** (was marginal) |
| Crane Alley approach | 19.8 | 43.4 | 48 | flowing |
| port gate fork (CRANE SMASH) | 18.0 | 15.3 | — | **kept brake pinch** |
| Port Detour | 20.0 | 29.0 | 32 | committed drift (unchanged) |
| headland spike (CLIFF CRASH) | 20.8 | 29.7 | 33 | **committed drift** (was trap) |
| Lookout Ess (three arcs) | 20.2–24.2 | 28.4–31.2 | 32–35 chained | **committed drift chain** (was 12 m fold) |
| chicane flick 1 | 18.8 | 24.0 | 19 / 27 spam | **marginal drift flick** (was trap) |
| chicane flicks 2+3 (ROADBLOCK) | 18.0 | 20.3–22.0 | 16–17 / 21–25 spam | **kept slow — tech-driftable** |
| Beach fork sweeper | 24.2 | 41.8 | 47 | **flat-out drift** (was trap) |
| village street | 20.3 | 32.4 | 36 | committed drift |
| village south leg | 19.0 | 24.2 | 19 / 27 spam | **marginal by design** |
| motel sweep | 19.5 | 53+ | 48 | flat-out (AI lifts ~19 — a takedown beat, not a player stop) |

**Lap arithmetic:** 215 sections, 1 996 m, `sum(8/v)` = **58.7 s** (was 61.8);
`sum(ds/v)` 67.6 s vs 72.1 s → predicted wall clock **≈ 70 s** (was ~75), comfortably
inside the 60–90 s target. Brake traps on the racing line: **8 → 1 kept pinch + 2
kept-tight theatre flicks**, all three of them paid theatres (CRANE SMASH, ROADBLOCK).
Verified on the rebuilt loop: no self-intersection (closest non-adjacent approach
64.3 m ≥ 30), min centreline R 15.3 m > the 11 m half-width fold limit (it's the kept
CRANE pinch), start straight 190 m ≥ 150, both ramp wedges ≥ 24 m off the main line,
all four signature circles still cover the line, **zero** solid-prop/building
clearance violations against the live dressing.

---

## 6. Width: keep 22 m (the Burnout answer is already in the ribbon)

Tested and rejected as the primary fix. The 22 m four-lane ribbon already *is* the
drift accommodation — Criterion's own "twice as wide as real life" rule (§1). On a
22 m corridor a clean outside-inside-outside line adds roughly `e·(1+cos(θ/2))/(1−cos(θ/2))`
of effective radius (e ≈ 8 m usable half-width): tens of metres on an isolated 90°,
which is why the kept ROADBLOCK flicks at centreline R 20–22 play as drift-able in
practice even though the centreline math says marginal — *if* the player has the road.
In a six-car scrum they don't, which is exactly why the geometry bar in §2 is set on
the centreline. Widening further would dilute the combat density the GDD wants, and
`RaceDef.width` is a single scalar — per-section width is an engine work item that
this pass deliberately avoids needing.

---

## 7. Knock-on effects (re-check list for the implementing slice)

1. **Section count 220 → 215; indices shift after the ess.** Shortcut attachments
   self-heal (`nearestSection`), verified: HARBOR 41→78, FLYOVER 16→36, LEDGE
   ~116→~128, BEACH ~180→~207 — contract (entry ≥ 4, entry < exit ≤ N−4) holds.
2. **Two branch polylines must move with their forks** (their mouths end up 12–20 m
   off the new main line otherwise):
   - LOOKOUT LEDGE → `[[52,240], [-8,247], [-76,237]]` (the ess fork moved east and
     its exit west; the ledge still runs the rim, saves slightly more — re-price with
     mouth barrels if needed).
   - BEACH RUN first point `[-250,-90]` → `[-240,-76]` (rest unchanged). Note the
     flowing fork shrinks Beach Run's save toward ~0.5 s; acceptable for the
     "pressure valve", or pull its rejoin a touch later to compensate.
3. **Wall styles re-derive from anchors** (`wallStyles` reference section ranges):
   dockyard fence 36–83 → unchanged 36–83; harbor kerb 76–89 → 76–~90; cliff
   guardrail 87–144 → **87–148**. Re-derive all from the anchor coordinates, then
   re-run `tools/audit-merge-gantry.mjs` (last-wins resolution unchanged).
4. **Knockables to re-seat** (audited deltas vs the new line):
   - flick-3 run-off cluster is orphaned (now 19–21 m off): pole `(-209,6)` →
     ~`(-218,4)`, barrels `(-210.5,12.5)` → ~`(-220,11)`, `(-209,8)` → ~`(-218,7)`
     (re-derive at 9–10 m off the new centreline with `tools/audit-gantry-dressing.mjs`).
   - pole `(-247,23)` slips to 8.8 m — nudge ~1 m outward.
   - LEDGE mouth barrels `(16,252)/(10,253)` move with the new mouth → ~`(44,247)/(38,250)`.
   - ROADBLOCK's three middle-flick barrels stay within spec (Δ < 1.5 m) — leave.
5. **Coast outline**: the spike apex moved 2 m seaward and the ess dip ~9 m inland;
   harbor/cliff arcs need containment re-verified (audit-merge §2 does this) — expect
   at most a small bulge at the spike.
6. **Signature circles**: all four still covered (CLIFF CRASH line distance 8.0 →
   11.7 m; optionally re-centre it to ~(256,204) to hug the new apex).
7. **Zone-file comments** quoting indices (e.g. dockyard "sections 36..83", cliff
   "sections 89–144 sit at z ≥ 185") need their numbers refreshed.
8. Optional engine lever, separate slice: feed the *measured* effective spacing into
   `finishSections` so AI classes stop underestimating radii by ~18% (raises all
   corner classes ~9%, including the kept pockets — retune `RUBBER_*` feel after).

---

## 8. Sources

- [Classic Levels Deconstructed: Burnout 3: Takedown's blistering Alpine track](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/) — PlayStation.Blog, 2017 (Alex Ward & Chris Walley quotes: slide-first track design, double width, double speed, drift-bait corners).
- [Drift — Burnout Wiki (Fandom)](https://burnout.fandom.com/wiki/Drift) — drift as the corner/boost tool.
- [Waterfront (Burnout 3) — Burnout Wiki (Fandom)](https://burnout.fandom.com/wiki/Waterfront_(Burnout_3)) — corner-by-corner "slow down or drift" language; [Alpine](https://burnout.fandom.com/wiki/Alpine) — "huge corners that beg to be drifted through".
- [Burnout Retrospective Part Three: Burnout 3](https://3rdvoicegaming.com/2018/04/18/burnout-retrospective-part-three-burnout-3-takedown-2004/) and [Part Six: Dominator](https://3rdvoicegaming.com/2018/05/13/burnout-retrospective-part-six-burnout-dominator-2007/) — 3rd Voice Gaming (track rhythm; shortcuts absent before Revenge).
- [Burnout 3: A review — zerokspot](https://zerokspot.com/weblog/2004/10/03/burnout-3-a-review/) — tracks designed with crashes/furniture in mind.
- [AISections — burnout.wiki](https://burnout.wiki/wiki/AI_Sections) (mirrored at `docs/AISections.md` in the repo root) — speed classes / SectionResetPair, the model `race.ts` mirrors.
- Nic Melder, racing rubber-banding chapters, *Game AI Pro* ([gameaipro.com](https://www.gameaipro.com/)) — pack-glue rules already implemented in `race.ts`.
- Local ground truth: `src/game/race.ts` (resampler + speed classes), `src/game/control.ts` (drift/grip constants), `src/game/levels/gantryPoint.ts` (waypoints, zones, knockables), analysed 2026-06-12 with a scratch esbuild replica (deleted; method: bundle the live level exactly like `tools/audit-merge-gantry.mjs`, replicate `buildLoopSections`, assert 0 diff, then evaluate candidate tables).
