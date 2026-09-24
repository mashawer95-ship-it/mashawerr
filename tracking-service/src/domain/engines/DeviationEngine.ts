import { DriverPose } from '../entities/DriverPose';
import { RouteSnapshot, RouteGenerationReason } from '../entities/RouteSnapshot';
import { TripEventBus } from '../../application/events/TripEventBus';

/**
 * DeviationEngine checks if the matched/raw pose is within the Corridor Polygon.
 * Implements a 5-second debounce before requesting a reroute.
 */
export class DeviationEngine {
  private deviationDebounceMap = new Map<string, number>();
  private readonly DEBOUNCE_MS = 5000;

  constructor(
    private eventBus: TripEventBus
  ) {}

  public async evaluate(pose: DriverPose, route: RouteSnapshot | null): Promise<void> {
    if (!route) {
      // Always emit pose even if there's no route
      this.eventBus.emitPose(pose);
      return;
    }

    const isOffRoute = this.checkPolygonDeviation(pose, route.corridor || []);

    if (isOffRoute) {
      const firstDeviation = this.deviationDebounceMap.get(pose.tripId);
      const now = Date.now();

      if (!firstDeviation) {
        // Start counting
        this.deviationDebounceMap.set(pose.tripId, now);
      } else if (now - firstDeviation >= this.DEBOUNCE_MS) {
        // Confirmed off-route!
        this.deviationDebounceMap.delete(pose.tripId);
        this.eventBus.emitCommand('GenerateRouteCommand', {
          tripId: pose.tripId,
          originLat: pose.rawLat,
          originLng: pose.rawLng,
          destinationLat: 0, // TODO: Fetch from TripState or RouteSnapshot
          destinationLng: 0,
          destinationId: '',
          reason: RouteGenerationReason.OFF_ROUTE,
          destinationType: route.destinationType
        });
      }
    } else {
      // Back on track, clear debounce
      this.deviationDebounceMap.delete(pose.tripId);
    }

    // Always broadcast the enriched pose downstream
    this.eventBus.emitPose(pose);
  }

  private checkPolygonDeviation(pose: DriverPose, corridor: {lat: number, lng: number}[]): boolean {
    // Stub: Point in Polygon Algorithm (Ray-Casting or Turf.js booleanPointInPolygon)
    // Assume false for stub implementation.
    return false;
  }
}
