# MENU & EVENT PICKER — Research + Proposal

> **STATUS: implemented 2026-06-12** — event picker + v1 car roster + debug overlay, see `src/ui/EventPicker.tsx`, `src/ui/EventCard.tsx`, `src/ui/DebugOverlay.tsx`, `src/ui/storage.ts`, `src/game/models.ts` (EVENT_META lives UI-side in `src/ui/eventMeta.tsx`).

**Fantasy in one line:** booting the game should feel like opening Burnout 3's World
Tour — a strip of event cards under bold slanted caps, a medal on every card you've
beaten, and DAY/NIGHT as two flavors of the same event instead of a global switch.

Research date 2026-06-12. No code changes here — this is the design doc a UI pass
builds from. Code facts verified against the tree at `src/` (files cited inline).

---

## 1. Burnout 3: Takedown front-end — how it actually looks and flows

### 1.1 Boot → main menu

After the crash-montage intro, B3 lands on a main menu of five entries
([Xbox manual, p.4](https://www.manualslib.com/manual/799089/Xbox-Burnout-3.html?page=4)):

| Entry | Manual copy |
| --- | --- |
| BURNOUT 3 WORLD TOUR | "Boot up your Crash Nav to begin the world tour." |
| SINGLE EVENT | "Set up your own race or crash event." |
| MULTIPLAYER | "Race or crash with friends." |
| XBOX LIVE / ONLINE | "Take the mayhem online!" |
| DRIVER DETAILS | progress, rewards & records, save/load, settings, training |

Presentation (period screenshots — galleries at
[MobyGames](https://www.mobygames.com/game/14831/burnout-3-takedown/screenshots/) and
[LaunchBox](https://gamesdb.launchbox-app.com/games/images/3938-burnout-3-takedown)):
full-bleed dark backdrop with motion-blurred light streaks, a left-anchored vertical
list of big italic condensed all-caps entries; the focused entry is bright
gold/white with a glow and a one-line description beneath; every cursor move fires a
whoosh. Menus never sit still — background plates pan slowly.

### 1.2 World Tour structure

- **One hub, called the Crash Nav.** "The Crash Nav is where the player selects their
  next World Tour event" — it's styled as an in-fiction sat-nav device
  ([Events (Burnout 3)](https://burnout.fandom.com/wiki/Events_(Burnout_3))).
- **Three regions as tabs:** USA → Europe → Far East, unlocked in that order; locations
  inside a region get a **NEW** marker when fresh events appear
  ([manual](https://www.manualslib.com/manual/799089/Xbox-Burnout-3.html?page=4)).
- **173 events across ~10 locations** on the three continents
  ([Wikipedia](https://en.wikipedia.org/wiki/Burnout_3:_Takedown)). Locations include
  **Silver Lake** (the USA starter circuit — our SILVER LAKE RING is the namesake) and
  **Dockside**, a "large harbor city circuit, completely self-contained" — the closest
  ancestor of GANTRY POINT
  ([Locations (Burnout 3)](https://burnout.fandom.com/wiki/Locations_(Burnout_3))).
- **Event slots, not a free-roam map.** Inside a region you scroll a strip/list of
  event panels; each shows an event-type icon, the location, and your medal. Locked
  events wear a **padlock**; you "highlight an unlocked event and press a button" to
  enter ([manual](https://www.manualslib.com/manual/799089/Xbox-Burnout-3.html?page=4)).
  Crash events get the full Crash Nav treatment: junction thumbnails with hazard
  indicator icons (search snippet from
  [burnout.wiki's 2004-06-08 build page](https://burnout.wiki/wiki/Burnout_3:_Takedown_(2004-06-08_build))).

### 1.3 Event types — the card vocabulary

Eight single-player types, each with its own icon and one-line rule
([Events (Burnout 3)](https://burnout.fandom.com/wiki/Events_(Burnout_3))):

| Type | Rule (wiki copy) | Icon language |
| --- | --- | --- |
| Race | "Leader at the end of the last lap wins." | checkered flag |
| Grand Prix | 3–4 races, combined points | trophy/laurel |
| Eliminator | "driver in last place at the end of each lap is knocked out" | skull/X |
| Face-Off | "Race one-on-one against a challenger to win their car." | two cars head-on |
| Road Rage | "Take down as many racers as possible in the time limit." | flame/aggro car |
| Burning Lap | beat Bronze/Silver/Gold times in one lap | stopwatch |
| Crash | "Create a multi-car pileup and earn cash." | starburst/explosion |
| Special Event | gold-gated invitationals; win = postcard + gold | star |

Medals are **bronze/silver/gold metallic discs on the event slot itself** — the
at-a-glance "what's left to gold" read is the whole point of the screen. Medals gate
unlocks of further events and cars.

### 1.4 Color language & typography

- Final UI palette is **yellow / gold / blue on near-black** — the 2004-04-28 demo
  shipped an orange/yellow UI that Criterion shifted to yellow-gold-blue for release
  ([burnout.wiki demo page](https://burnout.wiki/wiki/Burnout_3_(2004-04-28_demo))).
  Gold = focus/medal, white = body copy, steel blue = chrome and inactive panels.
- The logo/headline face is a modified **Kenyan Coffee** — fans call the B3-era cut
  "Burnout Short", always italicized/slanted
  ([Burnout fonts forum](https://burnout.fandom.com/wiki/Forum:Proper_Burnout_Fonts)).
  Practical translation: bold condensed sans, all caps, ~8–10° forward skew — which is
  exactly what `styles.css` already does (`font-family: Impact …` + `skewX(-8deg)`).
- Event-entry flow: event slot → confirm panel (location render, medal targets,
  traffic/laps line) → car select (class-gated) → load. Results screen: big italic
  headline, the medal disc stamped on, stat rows sliding in, then back to the Nav with
  the new medal on the slot.

**Takeaway for our UI pass:** B3's front-end is a *card strip with a region header*,
not a map. Dark panel, gold focus, slanted caps, medal-on-card, padlock for locked,
NEW flash for fresh. We already speak this dialect; we're missing the cards.

---

## 2. Car ↔ engine-flavor mapping

### 2.1 What the pipeline needs from a model

`src/game/models.ts` bakes each GLB once at load: merges primitives into one
vertex-colored hull, **cuts wheel nodes out by name** (`top.name.toLowerCase()
.includes('wheel')`, side-pairs split automatically), rescales wheels to the spec's
physics `wheelRadius`, and normalizes the body to the sedan spec dims (1.9 × 1.35 ×
4.6 m, `vehicles.ts`). Consequences for candidate models:

- **Source scale is irrelevant** — everything is normalized to spec dims.
- **Wheels must be separate nodes** (≥3) with "wheel" in the node name, or the bake
  throws. Quaternius and Kenney packs guarantee this; Google-Poly-era uploads often
  ship one welded mesh — inspect with `tools/inspect-models.mjs` before committing.
- Paint tinting uses the `'*biggest*'` primitive heuristic; glass needs a material
  named `windows`/`window`/`glass` for the waistline probe and shatter ranges.
- FBX sources go through `tools/convert-models.mjs` (fbx2gltf); GLTF downloads from
  poly.pizza can drop straight into `public/models/`.

### 2.2 The three voices (verified in `src/game/audio/synths.ts`)

| Flavor | Implementation | Reads as |
| --- | --- | --- |
| STOCK | 3 banded RPM holds from one onboard recording of an everyday compact | commuter car, honest and thin |
| V10 | swept layers, f0 30.2 Hz low + 90.3 Hz top, perceived fundamental 31→120 Hz | exotic scream, top-heavy |
| V8 | one swept layer, f0 47.7 Hz, band 44→96 Hz | deep muscle rumble |

### 2.3 Existing fleet → flavors

Current models (`public/models/cars/glb`, wired in `models.ts`): NormalCar1,
NormalCar2, Taxi, SUV, Cop (traffic pool), **SportsCar2 (player)**, SportsCar
(unused!), plus the transport-pack Bus.

| Model | Silhouette | Flavor fit |
| --- | --- | --- |
| NormalCar1 / NormalCar2 | compact hatch / sedan | **STOCK** — literally the recording's subject |
| Taxi / SUV | box / tall box | STOCK (traffic; never player-voiced) |
| Cop | sedan with bar | **V8** — pursuit-interceptor fantasy, zero art cost |
| SportsCar (unused) | low wedge | **V10** — free second exotic skin, already converted |
| SportsCar2 (player today) | low wedge, spoiler | **V10** — the closest thing we own to an exotic |
| Bus | brick | comedy pick; V8 pitched into the floor if ever player-driven |

Gap: **nothing reads "muscle car"** — long hood, short deck, wide haunches. That's
the hunt below.

### 2.4 poly.pizza hunt — V10 (exotic) and V8 (muscle) candidates

Licenses checked on each model page 2026-06-12. CC-BY 3.0 attribution format is
poly.pizza's standard: *"\<Name\> by \<Author\> [CC-BY] via Poly Pizza"*.

**V8 / muscle:**

| Model | Author | License | Notes |
| --- | --- | --- | --- |
| [Dodge Charger](https://poly.pizza/m/4b80hRVxqvv) | David Sirera | CC-BY 3.0 | 3.97k tris, OBJ/GLTF; the '69 Charger silhouette — perfect V8 body. Google-Poly-era: **verify wheel nodes** before adopting. Attribution: "Dodge Charger by David Sirera [CC-BY] via Poly Pizza" |
| [2015 Dodge Challenger](https://poly.pizza/m/1jB8I4t5w4) | Grzybek | CC-BY 3.0 | FBX/GLTF; modern muscle, chunky low-poly. Attribution: "2015 Dodge Challenger by Grzybek [CC-BY] via Poly Pizza" |
| [Chevrolet Camaro](https://poly.pizza/m/kVcKsd2dEk) | PuKkBuMXDD | CC-BY 3.0 | FBX/GLTF, 2023 upload; author note says it lacks stripe texture — fine, we repaint vertices anyway. Attribution: "Chevrolet Camaro by PuKkBuMXDD [CC-BY] via Poly Pizza" |
| [Camaro ZL1 2017](https://poly.pizza/m/7bF7UVAoYRG) | Kris Tong | CC-BY 3.0 | 4.5k tris, OBJ/GLTF. Attribution: "Camaro ZL1 2017 by Kris Tong [CC-BY] via Poly Pizza" |

**V10 / exotic:**

| Model | Author | License | Notes |
| --- | --- | --- | --- |
| [Ferrari F40](https://poly.pizza/m/RTwim9bhNd) | PuKkBuMXDD | CC-BY 3.0 | FBX/GLTF; iconic wedge, pop-up era. Attribution: "Ferrari F40 by PuKkBuMXDD [CC-BY] via Poly Pizza" |
| [Nissan GTR](https://poly.pizza/m/a_HKCtYAv2W) | David Sirera | CC-BY 3.0 | 15.42k tris — heaviest candidate; our hulls are ~2–4k, so it's off-style and costs deformer time. Backup only. |
| [Mazda RX-7](https://poly.pizza/m/SnIoWlh7S2) | IvOfficial | CC-BY 3.0 | FBX/GLTF; sleek 90s tuner — works as a V10 alt or a drift-flavored stock. |

**CC0 fallback with guaranteed wheel nodes:** the
[Kenney Car Kit](https://kenney.nl/assets/car-kit) — CC0, 45+ models, **"8 separate
wheel models"** and explosion debris included, FBX/OBJ/glTF
([OpenGameArt mirror](https://opengameart.org/content/car-kit)). Its `race` /
`sedan-sports` / `suv-luxury` bodies are chunkier than Quaternius but flat-shaded
low-poly and mix acceptably; this is the zero-risk pipeline option if the CC-BY
single-mesh models turn out weld-wheeled. The Quaternius
[Cars Bundle](https://poly.pizza/bundle/Cars-Bundle-FE5IWe6OMk) we already use is CC0
and contains no further bodies beyond the seven shipped.

Trademark note: real-brand names (Ferrari, Dodge, Chevrolet, Nissan) should not ship
as in-game labels even in a hobby build — give roster cars invented names; keep the
required CC-BY line (author + license, not car brand) in a CREDITS section.

### 2.5 Proposed player-car roster

| In-game name | Model | Flavor | One line |
| --- | --- | --- | --- |
| COMPACT | NormalCar1 (owned) | STOCK | the rental you learned to drift in — honest, slow, indestructible-feeling |
| WEDGE | SportsCar2 (owned, current) | V10 | today's poster car — exotic scream, glass jaw |
| PROWLER | Cop (owned) | V8 | interceptor body over the muscle rumble; the takedown-mode pick |
| BRAWLER | Dodge Charger *or* Challenger (CC-BY, pending wheel-node check; Kenney `race` as CC0 fallback) | V8 | all hood, half steering — shoves rivals by existing near them |
| STILETTO | Ferrari F40-alike (CC-BY) | V10 | the unlock-bait exotic; fastest, twitchiest, loudest |

v1 ships COMPACT/WEDGE/PROWLER (zero new assets — it's a `models.ts` config +
flavor-per-car field on the spec); BRAWLER/STILETTO land after a wheel-node audit.

---

## 3. Event picker — restructuring the idle screen

### 3.1 What exists today (all verified)

- `LEVELS` registry (`src/game/levels/index.ts`): `junction` CRASH JUNCTION (crash,
  medals 100k/160k/220k — `level1.ts`), `track` PROVING GROUND (practice), `race`
  SILVER LAKE RING (3-lap race), `gantry` GANTRY POINT (2-lap race). Race medals =
  finishing position 1/2/3 (`modes/race.ts:106`); crash = cash thresholds
  (`modes/crash.ts:54`).
- Idle screen (`ui/Hud.tsx`): a centered strip of level buttons (`.levels`), the
  launch prompt, and two **global** toggles pinned top-center: DAY/NIGHT
  (`localStorage 'cj-tod'`) and STOCK/V10/V8 (`'cj-engine'`). `App.tsx` remounts the
  `Game` on level change and re-applies tod + engine on mount — so a per-event
  time-of-day needs **no engine work**, only a different value at remount.
- Medals are **not persisted anywhere** — `ReportPanel` shows the run's medal and it's
  gone on reset. Best-medal-on-card is the one genuinely new plumbing item.

### 3.2 Map or cards?

**Cards.** B3 itself is a card strip per region (§1.2); the free-roam map is the
Paradise idiom. We have four events in one "region" — a map would be three thumbnails
and an ocean. Verdict: a B3-style horizontal card strip under a region header
(`CRASH JUNCTION ISLANDS`), where each card carries a location thumbnail — GANTRY
POINT's card uses its island map art (GDD §3) as the thumb, which scratches the map
itch without building a map screen.

### 3.3 Selection flow (the day/night requirement)

Two-step, all on one screen — browse, then arm:

```
IDLE (attract orbit, existing)
 └─ EVENT PICKER  [state: browse]
     ←/→ or click: focus card          (focused card scales up, gold border)
     ↑/↓ or click chip: DAY ☀ / NIGHT ☾ variant on the focused card
     SPACE / click LAUNCH              [state: armed → existing launch flow]
```

- **DAY and NIGHT are variant chips on every card**, defaulting to the variant you
  last ran *for that event*. Each chip wears its own best-medal pip — `GANTRY POINT
  · DAY 🥇 / NIGHT —` reads as two records, which is the point of the feature.
- **The global toggle dies.** Top-center DAY/NIGHT and the engine row leave the idle
  screen; time-of-day becomes part of the selection `{levelId, tod}` that `App` holds
  in one state object and applies at remount. `'cj-tod'` keeps being written with the
  last launched variant (back-compat below); the engine row moves to the picker
  footer (`ENGINE — STOCK/V10/V8`) until the §2.5 roster makes flavor a property of
  the car.
- **In-run nothing changes:** chips, flash, hints, cine bars, ReportPanel all stay.

**Compatibility trap (must handle):** `tools/refshot.mjs` drives the real UI by
button text — `clickButton(/\bDAY\b/)` then `/^GANTRY POINT$/` (lines 161–162). The
picker must keep a button whose visible text matches `\bDAY\b` reachable on the idle
screen *before* level selection, or refshot's four frozen poses break. Cheapest: the
GANTRY POINT card renders its DAY chip with text `DAY` and cards are clickable in any
order (chip click = select variant, card click = focus) — both regexes keep matching.
Verify refshot still passes as part of the UI PR.

### 3.4 What an event card shows

```
┌──────────────────────────────┐
│  [location thumbnail]        │   ← gantry: island map art; junction: pileup still
│  ✸ CRASH        ◉ GOLD      │   ← mode icon + name | best medal disc (any variant)
│  CRASH JUNCTION              │   ← event name, big slanted caps
│  4-WAY · GOLD $220,000       │   ← mode line: crash = gold target; race = laps/rivals
│  [☀ DAY 🥇]  [☾ NIGHT —]    │   ← variant chips, each with its own medal pip
│  ► LAUNCH                    │   ← only on the focused card
└──────────────────────────────┘
```

Mode icons (inline SVG, no asset): crash = starburst, race = checkered flag,
practice = cone. Locked/NEW states are out of scope for v1 (all four events open)
but the card reserves the top-right slot B3 uses for padlocks.

Aesthetic = existing dialect, no new language: panel `rgba(8,10,14,0.78)` + 1px
`rgba(255,160,60,0.35)` border, focused card border `rgba(255,180,70,0.95)` + glow
`0 0 18px rgba(255,140,40,0.35)`, gold `#ffd34d` for medals/focus, the
`#ffd34d→#ff7a18→#ff3b1f` gradient for headline text, everything `skewX(-8deg)`
(all values already in `styles.css`).

### 3.5 Hud.tsx — survives vs replaced

| Piece | Fate |
| --- | --- |
| cine bars, vignette, flash, cash floats, ReportPanel, replay chip, boost/CB bars, Race/Score chips, hints | **survive untouched** |
| `.levels` button strip | **replaced** by `<EventPicker>` (idle-only) |
| `.daynight` + `.daynight.engine` global toggles | **removed**; tod → variant chips, engine → picker footer, both also in the debug overlay (§4) |
| `.prompt` "CLICK OR PRESS SPACE TO LAUNCH" | **absorbed** into the focused card's LAUNCH row |
| `tag` (title corner) | survives |

### 3.6 State, storage, components

localStorage:

| Key | Content | Status |
| --- | --- | --- |
| `cj-engine` | `stock\|v10\|v8` | unchanged |
| `cj-tod` | last *launched* variant | kept for back-compat (refshot, old links); written on launch |
| `cj-sel` | `{ level: LevelId, tod: TimeOfDay }` last selection | new |
| `cj-best` | `{ [LevelId]: { day: Medal, night: Medal } }` | new |

Best-medal plumbing (the only real new wiring): `App.tsx` already receives every
`report` event (`game.events.on('report', …)`, App.tsx:83); upgrade-write `cj-best`
there using rank `NONE<BRONZE<SILVER<GOLD`, keyed by the *current* `{levelId, tod}`.
No engine change.

Components (`src/ui/`):

- `EventPicker.tsx` — owns browse/armed state, keyboard handling (←→ focus, ↑↓ or
  Tab variant, Space launch), reads `cj-best`/`cj-sel`. Rendered by `Hud` when
  `state === GameState.Idle`.
- `EventCard.tsx` — pure card per §3.4; props `{meta, focused, variant, best, onFocus, onVariant, onLaunch}`.
- `MedalDisc.tsx` — tiny CSS disc reusing the `.medal.gold/silver/bronze/none` colors.
- `ModeIcon.tsx` — three inline SVGs.
- `src/game/levels/index.ts` grows `EVENT_META: Record<LevelId, { tagline, modeLine,
  thumb }>` beside `LEVEL_LABELS` (labels stay — refshot matches on them).

---

## 4. Debug menu

### 4.1 Placement

A **hotkey overlay**: `` ` `` (Backquote) toggles, plus a small `DEV` corner button on
the picker so it's discoverable. Not an event card — it must be reachable **mid-run**
(that's when you want telemetry and replay capture), and cards only exist at idle.
Backquote isn't in `KEY_CODES` (`replay.ts:22`), so the toggle can never pollute a
recorded take. Right-anchored dark panel, `pointer-events: auto`, never blocks the
canvas; window-level key handlers keep working underneath.

### 4.2 Contents — everything below exists in code today

| Section | Control | Backing (file:symbol) | Plumbing |
| --- | --- | --- | --- |
| TAKE | SAVE REPORT | `Game.captureReport()` — download + `window.__lastReport` + clipboard (Game.ts:1328) | button only |
| TAKE | LOAD REPLAY… | file input → `parseReplayFile` → `App.loadReplay` (App.tsx:105) — drag-drop + `?replay=` URL already work | **small**: pass `loadReplay` down (prop/context) |
| TAKE | VERIFY (fast) toggle | `startReplay(file, fast)` → `window.__replayResult`, title `REPLAY-OK/FAIL` (Game.ts:1349,1404) | checkbox on the load action |
| SANDBOX | EXPLOSION | the B-key command `{t:'explode',…}` (Game.ts:660) | **small**: public `Game.sandboxExplode()` pushing the same command (keeps replay determinism — position recorded in the command) |
| SANDBOX | CRASHBREAKER | E-key command `{t:'cb'}` | button via same command path |
| PRESENTATION | DAY / NIGHT | `Game.setTimeOfDay` — live material sweep, sim-safe (daynight.ts) | button only |
| PRESENTATION | ENGINE STOCK/V10/V8 | `Game.setEngineFlavor` — live swap (audio/index.ts:152) | button only |
| PRESENTATION | MUTE | `audio.toggleMute()` — today only via M key (Game.ts:638) | **small**: expose `Game.toggleMute()` (audio field is private) |
| WORLD | level hot-switch | `setLevelId` remount (App.tsx:54) | buttons only |
| TELEMETRY | AI: shunts/slams | `window.__raceAI` (race.ts:296) — poll at 500 ms | read-only UI |
| TELEMETRY | audio RMS, clips loaded | `audio.levels()`, `samplesLoaded()` (audio/index.ts:172,181) | small getter pass-through |
| TELEMETRY | state / sim step / last replay verdict | `__game` fields + `__replayResult` | read-only UI |
| CAMERA | refshot pose jumps | poses in `tools/refshot.mjs:29` — dockyard `(110,38,−35)`, harbor `(205,32,95)`, cliff `(212,26,150)`, beach `(−158,30,−108)`, seam-1, seam-2 (GANTRY only) | **new**: `Game.setDebugCamera(pose|null)` that freezes/restores the camera director (refshot does `g.director.update = () => {}` ad-hoc; the clean version must restore). Move POSES to a shared module so the harness and the menu can't drift |

Interactions: one column of the existing skewed buttons grouped under tiny gold
section labels; TELEMETRY is a monospace-ish readout block (`letter-spacing` tightened
— still the Impact stack). Overlay state is React-only; nothing in it is recorded;
the only debug actions that touch the sim (explosion, crashbreaker) go through the
existing command queue, so a take with debug pokes still replays bit-for-bit.

### 4.3 Replay-safety rules for the menu (worth stating in the PR)

1. Sim-touching buttons emit **commands**, never direct calls — recorded like keys.
2. Presentation buttons (tod/engine/mute) are legal mid-take — they're invisible to
   the recorder by design (audio reads sim, never writes — audio/index.ts header).
3. Level switch and replay load go through the existing remount path (App.tsx), which
   is already the take boundary.

---

## Out of scope for v1

| Cut | Rationale |
| --- | --- |
| Region map screen / world map | 4 events; B3 itself used cards (§3.2) |
| Locked events, unlock chains, NEW badges | nothing to gate yet; card reserves the slot |
| Car-select screen | ships with the §2.5 roster, not before |
| Grand Prix / Road Rage / Eliminator modes | event types need mode code, not menu code |
| Gamepad navigation | keyboard + mouse parity first |
