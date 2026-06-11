import type { GameState } from '../types';
import { resolveJunctionContact, type ContactContext, type ContactOutcome } from '../collision';
import type { Medal } from '../events';
import { Scoreboard } from '../score';
import { updateTraffic } from '../traffic';
import { countWrecked, type GameMode, type ModeHost } from './mode';

/** The cash-for-carnage mode: scripted traffic feeds the junction, every
 *  impact draws damage money, and the run is medalled against thresholds
 *  once the wreckage settles. */
export class CrashMode implements GameMode {
  readonly score: Scoreboard;

  constructor(
    private medals: { bronze: number; silver: number; gold: number },
    private host: ModeHost,
  ) {
    this.score = new Scoreboard(host.events, (p) => host.project(p));
  }

  fixedStep(_dt: number, state: GameState, simTime: number): void {
    updateTraffic(this.host.actors, state, simTime, this.host.heightAt);
  }

  playerCanCrash(): boolean {
    return true;
  }

  resolveContact(ctx: ContactContext): ContactOutcome {
    return resolveJunctionContact(ctx, true);
  }

  autopilotHeading(): number | null {
    return null; // no takedown cam at the junction
  }

  playerOffTrackDistance(): number {
    return 0; // the junction is open ground
  }

  onTakedownCamOver(): void {}

  allowCrashbreaker(): boolean {
    return true;
  }

  onCrashTimeOver(): 'settle' | 'resume' {
    return 'settle';
  }

  onSettled(): void {
    const total = this.score.total;
    const m = this.medals;
    const medal: Medal = total >= m.gold ? 'GOLD' : total >= m.silver ? 'SILVER' : total >= m.bronze ? 'BRONZE' : 'NONE';
    this.host.finish({ kind: 'crash', total: Math.round(total), wrecked: countWrecked(this.host.actors), medal });
  }
}
