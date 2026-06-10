import type { GameState } from '../types';
import { resolveJunctionContact, type ContactContext, type ContactOutcome } from '../collision';
import { Scoreboard } from '../score';
import { updateTraffic } from '../traffic';
import type { GameMode, ModeHost } from './mode';

/** The proving ground: nothing to lose. The player can never wreck —
 *  crashes scuff and shed panels but driving continues, so there's no
 *  crashtime and no report. Scoring stays live for fun feedback (the pad's
 *  multiplier rings and barrels still pay). */
export class PracticeMode implements GameMode {
  readonly score: Scoreboard;

  constructor(private host: ModeHost) {
    this.score = new Scoreboard(host.events, (p) => host.project(p));
  }

  fixedStep(_dt: number, state: GameState, simTime: number): void {
    // no traffic on the pad today — kept so a future practice level with
    // traffic behaves like any other level
    updateTraffic(this.host.actors, state, simTime, this.host.heightAt);
  }

  playerCanCrash(): boolean {
    return false;
  }

  resolveContact(ctx: ContactContext): ContactOutcome {
    return resolveJunctionContact(ctx, false); // junction rules, immortal player
  }

  autopilotHeading(): number | null {
    return null;
  }

  allowCrashbreaker(): boolean {
    return true; // unreachable anyway: the crashbreaker needs a wrecked player
  }

  onCrashTimeOver(): 'settle' | 'resume' {
    return 'settle'; // unreachable: the player never crashes
  }

  onSettled(): void {
    // unreachable: practice never leaves Launch — no report
  }
}
