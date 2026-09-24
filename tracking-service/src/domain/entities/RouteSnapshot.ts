export enum RouteState {
  DRIVER_TO_PICKUP = 'driver_to_pickup',
  DRIVER_TO_DESTINATION = 'driver_to_destination',
}

export enum RouteGenerationReason {
  ORDER_ACCEPTED = 'order_accepted',
  DRIVER_ARRIVED = 'driver_arrived',
  ORDER_PICKED_UP = 'order_picked_up',
  OFF_ROUTE = 'off_route',
  DESTINATION_CHANGED = 'destination_changed',
  CONNECTION_RESTORED = 'connection_restored'
}

export interface RouteSnapshot {
  routeId: string;
  version: number;
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  checksum: string;
  generatedAt: number;
  expiresAt: number;
  generationReason: RouteGenerationReason;
  destinationType: 'pickup' | 'delivery';
  
  // Optional detailed fields
  legs?: any[];
  steps?: any[];
  corridor?: {lat: number, lng: number}[];
  bounds?: any;
  traffic?: any;
  trafficDelay?: number;
  bearing?: number;
}
