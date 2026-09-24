export enum RouteGenerationReason {
  TRIP_STARTED = 'TripStarted',
  PICKUP_DONE = 'PickupDone',
  DESTINATION_CHANGED = 'DestinationChanged',
  OFF_ROUTE = 'OffRoute',
  TRAFFIC = 'Traffic',
  MANUAL = 'Manual',
}

export interface RouteSession {
  routeId: string;
  tripId: string;
  version: number;
  provider: string;
  generation: number;
  reason: RouteGenerationReason;
  createdAt: number;
}
