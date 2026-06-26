// Barrel for the car-select showroom. The implementation lives in
// ./garageScene/* — this file preserves the original public import surface
// ("./garageScene") unchanged so importers (src/ui/CarSelect.tsx) need no
// change. Split purely to keep every module under the line budget; no
// behaviour, constant, shader, draw order, or order-of-operations was touched.
export { GARAGE_DEFAULT_COLOR } from './garageScene/constants';
export { GarageScene } from './garageScene/scene';
