import { IRouteProvider, RawRouteResponse } from './IRouteProvider';

export class GoogleRouteProvider implements IRouteProvider {
  private fallbackProvider: IRouteProvider | null = null;

  constructor(fallbackProvider?: IRouteProvider) {
    if (fallbackProvider) {
      this.fallbackProvider = fallbackProvider;
    }
  }

  public getName(): string {
    return 'GoogleRoutes';
  }

  public async getDirections(originLat: number, originLng: number, destination: string): Promise<RawRouteResponse> {
    try {
      console.log(`[GOOGLE_PROVIDER] Fetching route from Google for ${originLat},${originLng} to ${destination}`);
      
      // In a real implementation, make the HTTP call to Google Routes API here.
      // const response = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes', { ... });
      console.log(`[GOOGLE_PROVIDER] RETURNING STUB ROUTE! (This was found in audit)`);
      
      // Stub implementation simulating a successful Google API response
      return {
        polyline: 'encoded_polyline_from_google',
        distance: 2500, // meters
        duration: 600, // seconds
        legs: [],
        steps: [],
        bounds: {},
        traffic: {},
        bearing: 0
      };

    } catch (error) {
      console.error(`[GoogleRouteProvider] Failed to fetch route from Google Maps API:`, error);
      
      if (this.fallbackProvider) {
        console.log(`[GoogleRouteProvider] Falling back to ${this.fallbackProvider.getName()}...`);
        return this.fallbackProvider.getDirections(originLat, originLng, destination);
      }
      
      throw new Error('All route providers failed');
    }
  }
}

// A simple fallback provider example (e.g. OSRM or Mapbox)
export class OSRMFallbackProvider implements IRouteProvider {
  public getName(): string {
    return 'OSRM';
  }

  public async getDirections(originLat: number, originLng: number, destination: string): Promise<RawRouteResponse> {
    console.log(`[OSRMFallbackProvider] Fetching route from OSRM...`);
    // Stub implementation
    return {
      polyline: 'encoded_polyline_from_osrm',
      distance: 2600,
      duration: 650,
      legs: [],
      steps: [],
      bounds: {},
      traffic: {},
      bearing: 0
    };
  }
}
