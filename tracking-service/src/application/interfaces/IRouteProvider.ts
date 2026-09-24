export interface RawRouteResponse {
  polyline: string;
  legs: any[];
  steps: any[];
  bounds: any;
  traffic: any;
  bearing: number;
  distance: number;
  duration: number;
}

export interface IRouteProvider {
  getName(): string;
  getDirections(originLat: number, originLng: number, destination: string): Promise<RawRouteResponse>;
}
