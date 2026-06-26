import { GameState, type RaceDef } from '../types';
import { LAUNCH_SPEED, OFF_TRACK_RESCUE_SECS } from '../constants';
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
  private handbackSpeed = 0; // player speed when the takedown cam was earned
  private offTrackTime = 0; // continuous seconds the live player has been stranded
  private camBeat = false; // takedown cam running — its own handback rescues

  constructor(def: RaceDef, private host: ModeHost) {
    const rivals = def.rivals.map((r) => {
      const a = host.spawnVehicle({ variant: 'sedan', color: r.color, x: 0, z: 0, dir: { x: 0, z: 1 }, speed: 0 });
      a.scripted = null; // rivals are driven by the RaceDirector, not traffic AI
      a.body.allowSleep = false; // a dozing racer ignores velocity writes
      a.body.wakeUp();
      return { actor: a, skill: r.skill, aggression: r.aggression };
    });
    this.director = new RaceDirector(
      def, host.player, rivals, host.events,
      (pos) => this.onRaceFinish(pos),
      (a) => host.repairActor(a), // taken-down rivals respawn good as new
    );
    // force-port: hand the director the height sampler so its rivals can run
    // the shared force solver (stepVehicleForces needs heightAt). Same sampler
    // the player controller uses, so determinism is unaffected.
    this.director.heightAt = host.heightAt;
  }

  fixedStep(dt: number, state: GameState): void {
    this.director.step(dt, state);
    // stranded rescue: a pileup launch can throw a live car clean over the
    // barrier — it self-rights on the grass, but the circuit is walled, so
    // there is no way back. Crashes and the cam beat have their own
    // respawns; this covers the un-crashed player. Timed, not instant:
    // brushing the off-track slack mid-race must not teleport anyone.
    const p = this.host.player;
    const stranded =
      state === GameState.Launch && !p.crashed && !this.camBeat && this.director.playerOffTrackDistance() > 0;
    this.offTrackTime = stranded ? this.offTrackTime + dt : 0;
    if (this.offTrackTime >= OFF_TRACK_RESCUE_SECS) {
      this.offTrackTime = 0;
      this.director.respawnPlayer(this.host.control);
      this.host.repairActor(p);
      this.host.events.emit('flash', 'BACK ON TRACK');
    }
  }

  playerCanCrash(): boolean {
    return true;
  }

  resolveContact(ctx: ContactContext): ContactOutcome {
    const out = resolveRaceContact(ctx);
    if (out.takedownCam) {
      const v = this.host.player.body.velocity;
      this.handbackSpeed = Math.hypot(v.x, v.z);
      this.camBeat = true;
    }
    return out;
  }

  autopilotHeading(): number | null {
    return this.director.playerAimHeading();
  }

  playerOffTrackDistance(): number {
    return this.director.playerOffTrackDistance();
  }

  /** The cam beat is over — if it left the player thrown over the barrier,
   *  beached on the grass or ground to a halt, the reset-pair puts them
   *  back on the track carrying the speed they had at the takedown. */
  onTakedownCamOver(): void {
    this.camBeat = false;
    const p = this.host.player;
    if (p.crashed) return; // the crash flow has its own respawn
    const v = p.body.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (this.director.playerOffTrackDistance() > 0 || sp < 8) {
      this.director.respawnPlayer(this.host.control, Math.min(Math.max(this.handbackSpeed, 10), LAUNCH_SPEED));
      this.host.repairActor(this.host.player);
    }
  }

  allowCrashbreaker(): boolean {
    return false; // no crashbreakers in a race, Burnout-style
  }

  onCrashTimeOver(): 'settle' | 'resume' {
    // the crash cam is just a beat — reset-pair respawn back onto the
    // track, good as new, and keep racing
    this.director.respawnPlayer(this.host.control);
    this.host.repairActor(this.host.player);
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
