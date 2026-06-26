/** The nose or tail face of the body: the outermost FACE_DEPTH slice. */
export interface PanelFace {
  halfW: number;
  y0: number;
  y1: number;
}

/** A lid's resting surface (hood or rear deck), probed along the
 *  centerline: height at the band's midpoint + slope along z. */
export interface LidFit {
  y: number;
  slope: number;
}

/** Where doors live: the z band (between the arches; ahead of them on the
 *  bus), the side plane, and the sill→window-line vertical span. */
export interface DoorFit {
  x: number;
  z0: number;
  z1: number;
  sillY: number;
  waistY: number;
}

/** Where the bodywork actually is, measured off the normalized baked body
 *  in group space. buildPanels rigs the detachable panels to these instead
 *  of the procedural-hull guesses: doors on the side plane between sill and
 *  window line, bonnet/boot lying on the probed hood/deck surfaces,
 *  bumpers wrapping the true nose/tail faces. */
export interface PanelMetrics {
  minY: number;
  maxY: number;
  noseZ: number; // forward is -z
  tailZ: number;
  door: DoorFit;
  bonnet: LidFit;
  boot: LidFit;
  nose: PanelFace;
  tail: PanelFace;
}
