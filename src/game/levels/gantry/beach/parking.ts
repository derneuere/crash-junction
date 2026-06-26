import type { DecalDef } from '../../../types';

// The motel lot's parking bays: white stripes stepped along the village
// road's bearing (dir (0.316,-0.948) at the motel corner), each stripe's
// length pointing across the lot toward the building.
const BAY_DIR = { x: 0.316, z: -0.948 };
const BAY_YAW = Math.atan2(-BAY_DIR.x, -BAY_DIR.z); // stripe length faces the motel
export const parkingBays = (): DecalDef[] => {
  const bays: DecalDef[] = [];
  for (let i = 0; i < 6; i++) {
    bays.push({
      x: -168.5 + BAY_DIR.x * 3.4 * i,
      z: -139 + BAY_DIR.z * 3.4 * i,
      w: 0.35,
      l: 5.5,
      yaw: BAY_YAW,
    });
  }
  return bays;
};
