import { Location } from '../entities/Location';

export interface ILocationRepository {
  updateDriverLocation(driverId: string, location: Location): Promise<void>;
  getDriverLocation(driverId: string): Promise<Location | null>;
}
