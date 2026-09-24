import { DriverPose } from '../entities/DriverPose';
import { DeviationEngine } from './DeviationEngine';
import { TripRouteStore } from '../repositories/TripRouteStore';

/**
 * MapMatchingEngine snaps the raw GPS to the nearest point on the Polyline Graph.
 * Phase 1: Passing Raw GPS directly to the client to ensure pipeline stability.
 */
export class MapMatchingEngine {
  constructor(
    private deviationEngine: DeviationEngine,
    private routeStore: TripRouteStore
  ) {}

  public async match(pose: DriverPose): Promise<void> {
    const routeSnapshot = await this.routeStore.getRouteSnapshot(pose.tripId);
    
    // Phase 1 Implementation: Pass Raw GPS directly
    pose.matchedLat = pose.rawLat; 
    pose.matchedLng = pose.rawLng;
    
    if (routeSnapshot) {
      pose.bearing = routeSnapshot.bearing || pose.heading;
      pose.routeVersion = routeSnapshot.version;
    } else {
      pose.routeVersion = 0;
    }

    await this.deviationEngine.evaluate(pose, routeSnapshot);
  }
}
