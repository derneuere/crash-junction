import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineFlavor } from '../game/audio';
import type { TimeOfDay } from '../game/daynight';
import { LEVEL_LABELS, type LevelId } from '../game/levels';
import { parseReplayFile, type ReplayFile } from '../game/replay';
import { GameState } from '../game/types';
import { synthKey } from './keys';

// The Backquote debug overlay (research doc §4). Reachable mid-run — that's
// when you want telemetry and replay capture — so it lives beside the Hud,
// not on an event card. Backquote is NOT in replay.ts KEY_CODES, so toggling
// it can never pollute a recorded take.
//
// Replay-safety rules (doc §4.3): sim-touching buttons (explosion,
// crashbreaker, launch-adjacent) fire SYNTHETIC KEYS so they ride the
// command queue and get recorded; presentation buttons (tod/engine/mute) are
// legal mid-take by design; level switches go through App's remount, which
// is already the take boundary.

/** Structural view of window.__game — the dev handle Game.ts publishes. The
 *  fields are TS-private on the class, but this overlay deliberately works
 *  through the same runtime surface the console and tools/refshot.mjs use,
 *  so Game.ts needs no code for it. */
interface DebugGame {
  captureReport(note?: string): unknown;
  camera: {
    position: { set(x: number, y: number, z: number): void };
    lookAt(x: number, y: number, z: number): void;
  };
  director: { update?: (...args: never[]) => void };
  audio?: { levels(): number; samplesLoaded(): number };
  simTime?: number;
  levelId?: string;
}

const getGame = (): DebugGame | null =>
  (window as unknown as { __game?: DebugGame }).__game ?? null;

interface ReplayVerdict {
  ok: boolean;
  aborted: boolean;
  framesPlayed: number;
  framesTotal: number;
  diverged: unknown;
}

/** MIRROR of tools/refshot.mjs POSES (the frozen contract). The harness is a
 *  plain .mjs the UI can't import without dragging tools/ into the bundle —
 *  if a pose ever moves there (it shouldn't: they're frozen), move it here
 *  too. All GANTRY POINT world coordinates. */
const REFSHOT_POSES: Record<string, { cam: [number, number, number]; look: [number, number, number] }> = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  cliff: { cam: [212, 26, 150], look: [275, 2, 212] },
  beach: { cam: [-158, 30, -108], look: [-235, 0, -185] },
  'seam-1': { cam: [243, 14, 178], look: [288, 6, 214] },
  'seam-2': { cam: [-218, 22, 40], look: [-285, 0, -10] },
};

interface DebugOverlayProps {
  open: boolean;
  onClose: () => void;
  state: GameState;
  levelId: LevelId;
  timeOfDay: TimeOfDay;
  engineSound: EngineFlavor;
  onSetTimeOfDay: (t: TimeOfDay) => void;
  onSetEngineSound: (f: EngineFlavor) => void;
  onSelectLevel: (id: LevelId) => void;
  onLoadReplay: (file: ReplayFile, fast: boolean) => void;
}

interface Telemetry {
  simTime: number;
  rms: number;
  clips: number;
  ai: string;
  replay: string;
}

export function DebugOverlay({
  open, onClose, state, levelId, timeOfDay, engineSound,
  onSetTimeOfDay, onSetEngineSound, onSelectLevel, onLoadReplay,
}: DebugOverlayProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [verify, setVerify] = useState(false);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [pose, setPose] = useState<string | null>(null); // active refshot pose
  const frozen = useRef(false); // director.update shadowed on the live Game

  /** Un-freeze the camera director: refshot freezes by shadowing the
   *  instance's update with a no-op own property; deleting it restores the
   *  prototype method — the clean version of the harness's ad-hoc trick. */
  const release = useCallback(() => {
    if (!frozen.current) return;
    frozen.current = false;
    setPose(null);
    const g = getGame();
    if (g) delete g.director.update;
  }, []);

  // the frozen director would stall the takedown cam and the respawn flow —
  // pose jumps are an IDLE dressing tool, so launching auto-releases, and a
  // remount (level/car switch) drops the shadow with the old Game instance
  useEffect(() => {
    if (state !== GameState.Idle) release();
  }, [state, release]);
  useEffect(() => {
    frozen.current = false;
    setPose(null);
  }, [levelId]);

  // telemetry poll while open — read-only peeks at the dev handles
  useEffect(() => {
    if (!open) return;
    const read = () => {
      const g = getGame();
      const w = window as unknown as {
        __raceAI?: { shunts: number; slams: number };
        __replayResult?: ReplayVerdict;
      };
      const ai = w.__raceAI;
      const rr = w.__replayResult;
      setTele({
        simTime: g?.simTime ?? 0,
        rms: g?.audio?.levels() ?? 0,
        clips: g?.audio?.samplesLoaded() ?? 0,
        ai: ai ? `${ai.shunts} SHUNTS · ${ai.slams} SLAMS` : '—',
        replay: rr
          ? rr.ok
            ? `OK · ${rr.framesPlayed}/${rr.framesTotal} FRAMES`
            : rr.aborted
              ? `STOPPED AT ${rr.framesPlayed}/${rr.framesTotal}`
              : 'DIVERGED'
          : '—',
      });
    };
    read();
    const id = window.setInterval(read, 500);
    return () => window.clearInterval(id);
  }, [open]);

  const jumpTo = (name: string) => {
    const g = getGame();
    if (!g || state !== GameState.Idle) return;
    if (!frozen.current) {
      frozen.current = true;
      g.director.update = () => {}; // freeze: the idle orbit must not fight the pose
    }
    const p = REFSHOT_POSES[name];
    g.camera.position.set(p.cam[0], p.cam[1], p.cam[2]);
    g.camera.lookAt(p.look[0], p.look[1], p.look[2]);
    setPose(name);
  };

  const onFilePicked = (file: File | undefined) => {
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          onLoadReplay(parseReplayFile(text), verify);
        } catch (err) {
          alert(`Could not load replay: ${(err as Error).message}`);
        }
      },
      () => alert('Could not read the replay file'),
    );
  };

  if (!open) return null;

  return (
    <div className="debug">
      <div className="dbgHead">
        <span>DEBUG</span>
        <span className="dbgKey">` TOGGLES</span>
        <button onClick={onClose} title="Close">&times;</button>
      </div>

      <div className="dbgSection">TAKE</div>
      <div className="dbgRow">
        <button onClick={() => getGame()?.captureReport()} title="Download the current take as a bug report (R)">
          SAVE REPORT
        </button>
        <button onClick={() => fileRef.current?.click()} title="Replay a saved bug-report JSON">
          LOAD REPLAY&hellip;
        </button>
        <label className="dbgCheck" title="Fast-forward and write the verdict to window.__replayResult">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> VERIFY
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            onFilePicked(e.target.files?.[0]);
            e.target.value = ''; // re-picking the same file must re-fire
          }}
        />
      </div>

      <div className="dbgSection">SANDBOX</div>
      <div className="dbgRow">
        <button onClick={() => synthKey('KeyB')} title="Sandbox explosion (B) — recorded via the command queue">
          EXPLOSION
        </button>
        <button onClick={() => synthKey('KeyE')} title="Detonate a charged crashbreaker (E)">
          CRASHBREAKER
        </button>
      </div>

      <div className="dbgSection">PRESENTATION</div>
      <div className="dbgRow">
        <button className={timeOfDay === 'day' ? 'active' : undefined} onClick={() => onSetTimeOfDay('day')}>
          DAY
        </button>
        <button className={timeOfDay === 'night' ? 'active' : undefined} onClick={() => onSetTimeOfDay('night')}>
          NIGHT
        </button>
        <button onClick={() => synthKey('KeyM')} title="Toggle mute (M)">
          MUTE
        </button>
      </div>
      <div className="dbgRow">
        {(['stock', 'v10', 'v8'] as const).map((f) => (
          <button
            key={f}
            className={engineSound === f ? 'active' : undefined}
            onClick={() => onSetEngineSound(f)}
            title="Engine flavor override — picking a car resets it to the car's voice"
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="dbgSection">WORLD</div>
      <div className="dbgRow">
        {(Object.keys(LEVEL_LABELS) as LevelId[]).map((id) => (
          <button
            key={id}
            className={id === levelId ? 'active' : undefined}
            onClick={() => onSelectLevel(id)}
            title="Hot-switch: remounts the Game (the take boundary)"
          >
            {LEVEL_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="dbgSection">TELEMETRY</div>
      <div className="dbgTele">
        <div>STATE&nbsp;&nbsp;{GameState[state]} &middot; {levelId} &middot; t={tele ? tele.simTime.toFixed(1) : '0.0'}s</div>
        <div>AI&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{tele?.ai ?? '—'}</div>
        <div>AUDIO&nbsp;&nbsp;RMS {tele ? tele.rms.toFixed(3) : '—'} &middot; {tele?.clips ?? 0} CLIPS</div>
        <div>REPLAY&nbsp;{tele?.replay ?? '—'}</div>
      </div>

      <div className="dbgSection">CAMERA &middot; REFSHOT POSES</div>
      <div className="dbgNote">GANTRY POINT coords &middot; idle only (a frozen director stalls cam beats)</div>
      <div className="dbgRow">
        {Object.keys(REFSHOT_POSES).map((name) => (
          <button
            key={name}
            className={pose === name ? 'active' : undefined}
            disabled={state !== GameState.Idle}
            onClick={() => jumpTo(name)}
          >
            {name.toUpperCase()}
          </button>
        ))}
        <button disabled={!pose} onClick={release} title="Restore the camera director">
          RELEASE
        </button>
      </div>
    </div>
  );
}
