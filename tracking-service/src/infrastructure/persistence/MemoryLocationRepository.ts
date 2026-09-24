import { ILocationRepository } from '../../domain/repositories/ILocationRepository';
import { Location } from '../../domain/entities/Location';

/**
 * In-memory location repository ready to be swapped with a Redis implementation.
 * Stores only the latest location per driver.
 */
export class MemoryLocationRepository implements ILocationRepository {
  private store: Map<string, Location> = new Map();

  async updateDriverLocation(driverId: string, location: Location): Promise<void> {
    this.store.set(driverId, location);
    console.log(`[POSE_REDIS] Saved driver location in MemoryRepository for driver ${driverId}`);
  }

  async getDriverLocation(driverId: string): Promise<Location | null> {
    return this.store.get(driverId) || null;
  }
}
