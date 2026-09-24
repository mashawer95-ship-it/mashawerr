import { GenerateRouteCommand } from '../entities/CommandsEvents';
import { RouteSnapshot } from '../entities/RouteSnapshot';
import { IRouteProvider } from '../../application/interfaces/IRouteProvider';
import { VersionService } from '../../application/services/VersionService';
import crypto from 'crypto';

/**
 * RoutingEngine acts as a pure calculator. 
 * It receives origin/destination, calls the Provider, and returns a RouteSnapshot.
 * NO SOCKETS. NO REDIS. Pure Logic.
 */
export class RoutingEngine {
  constructor(
    private routeProvider: IRouteProvider,
    private versionService: VersionService
  ) {}

  public async generateRoute(command: GenerateRouteCommand): Promise<RouteSnapshot | null> {
    try {
      console.log(`[ROUTING_ENGINE] generating route for trip: ${command.tripId}. Provider: ${this.routeProvider.getName()}`);
      // 1. Fetch from Provider (The provider handles its own Fallback internally)
      const rawRoute = await this.routeProvider.getDirections(
        command.originLat, 
        command.originLng, 
        `${command.destinationLat},${command.destinationLng}`
      );
      console.log(`[ROUTING_ENGINE] Successfully generated route from provider. Raw length: ${rawRoute.polyline.length}`);

      // 2. Determine Version
      const newVersion = await this.versionService.getNextRouteVersion(command.tripId);
      
      // 3. Checksum for Client-Side caching
      const checksum = crypto.createHash('sha1').update(rawRoute.polyline).digest('hex');

      // 4. Build Snapshot
      const snapshot: RouteSnapshot = {
        routeId: `r_${crypto.randomBytes(4).toString('hex')}`,
        version: newVersion,
        provider: this.routeProvider.getName(),
        encodedPolyline: rawRoute.polyline,
        distanceMeters: rawRoute.distance,
        durationSeconds: rawRoute.duration,
        checksum,
        generatedAt: Date.now(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000, // 12 hours TTL
        generationReason: command.reason,
        destinationType: command.destinationType,
        
        // Detailed fields
        legs: rawRoute.legs,
        steps: rawRoute.steps,
        corridor: this.buildCorridorPolygon(rawRoute.polyline),
        bounds: rawRoute.bounds,
        traffic: rawRoute.traffic,
        trafficDelay: 0,
      };

      return snapshot;
    } catch (error) {
      console.error(`[RoutingEngine] Failed to generate route from provider:`, error);
      return null;
    }
  }

  private buildCorridorPolygon(polyline: string): {lat: number, lng: number}[] {
    // Stub: Expand polyline into a 25m wide polygon using turf.js buffer
    return [];
  }
}
