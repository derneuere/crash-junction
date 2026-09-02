export interface ControlInput {
  steer: number; // -1..1
  throttle: boolean; // engine acceleration — separate from boost
  boost: boolean;
  brake: boolean;
  /** Scripted drivers (rivals, traffic) brake and steer through corners with
   *  no drift INTENT — set this so a brake-while-steering never latches the
   *  tap-to-drift state machine. Burnout's AI runs on its own reduced-drift
   *  handling; here the AI simply corners on grip. Absent = player semantics. */
  noDrift?: boolean;
}
