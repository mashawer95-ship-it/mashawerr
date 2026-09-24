import { RouteGenerationReason, RouteSnapshot } from './RouteSnapshot';

export interface GenerateRouteCommand {
  tripId: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  destinationId: string;
  reason: RouteGenerationReason;
  destinationType: 'pickup' | 'delivery';
}

export interface RouteGeneratedEvent {
  tripId: string;
  snapshot: RouteSnapshot;
}
