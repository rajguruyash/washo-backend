import bikeBody from '../assets/services/bike-body-wash.webp';
import carBody from '../assets/services/car-body-wash.webp';
import carDeep from '../assets/services/car-deep-cleaning.webp';
import suvDeep from '../assets/services/suv-deep-cleaning.webp';
import type { VehicleType } from './types';

/** WASHO's own photography for each service, keyed by the service code in the database. */
export const SERVICE_PHOTOS: Record<string, string> = {
  'bike-body-wash': bikeBody,
  'car-body-wash': carBody,
  'car-deep-cleaning': carDeep,
  'suv-deep-cleaning': suvDeep,
};

/** One representative photo per vehicle for the combo packs. */
export const VEHICLE_PHOTOS: Record<VehicleType, string> = { bike: bikeBody, car: carBody, suv: suvDeep };

export const servicePhoto = (code: string): string | undefined => SERVICE_PHOTOS[code];
