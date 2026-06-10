import type { GameState, RaceDef } from '../types';
import { resolveRaceContact, type ContactContext, type ContactOutcome } from '../collision';
import type { Medal } from '../events';
import { RaceDirector } from '../race';
import { countWrecked, type GameMode, type ModeHost } from './mode';

/** The circuit race: rivals on the loop, position decides the medal. Cash
 *  is not a thing here — no scoreboard, no crashbreaker; a crash is just a
 *  cinematic beat before the reset-pair respawn puts you back on track. */
export class RaceMode implements GameMode {
  readonly score = null;
  private director: RaceDirector;

  constructor(def: RaceDef, private host: ModeHost) {
    const rivals = def.rivals.map((r) => {
      const a = host.spawnVehicle({ variant: 'sedan', color: r.color, x: 0, z: 0, dir: { x: 0, z: 1 }, speed: 0 });
      a.scripted = null; // rivals are driven by the RaceDirector, not traffic AI
      a.body.allowSleep = false; // a dozing racer ignores velocity writes
      a.body.wakeUp();
      return { actor: a, skill: r.skill };
    });
    this.director = new RaceDirector(def, host.player, rivals, host.events, (pos) => this.onRaceFinish(pos));
  }

  fixedStep(dt: number, state: GameState): void {
    this.director.step(dt, state);
  }

  playerCanCrash(): boolean {
    return true;
  }

  resolveContact(ctx: ContactContext): ContactOutcome {
    return resolveRaceContact(ctx);
  }

  autopilotHeading(): number | null {
    return this.director.playerAimHeading();
  }

  allowCrashbreaker(): boolean {
    return false; // no crashbreakers in a race, Burnout-style
  }

  onCrashTimeOver(): 'settle' | 'resume' {
    // the crash cam is just a beat — reset-pair respawn back onto the
    // track, good as new, and keep racing
    this.director.respawnPlayer(this.host.control);
    this.host.repairPlayer();
    return 'resume';
  }

  onSettled(): void {
    // unreachable: a race crash always respawns instead of settling
  }

  private onRaceFinish(position: number): void {
    const medal: Medal = position === 1 ? 'GOLD' : position === 2 ? 'SILVER' : position === 3 ? 'BRONZE' : 'NONE';
    this.host.finish({ kind: 'race', position, wrecked: countWrecked(this.host.actors), medal });
  }
}
