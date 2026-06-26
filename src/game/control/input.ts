export interface ControlInput {
  steer: number; // -1..1
  throttle: boolean; // engine acceleration — separate from boost
  boost: boolean;
  brake: boolean;
}
