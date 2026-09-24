import { TripEventBus } from '../../application/events/TripEventBus';
import { RouteGenerationReason } from '../entities/RouteSnapshot';

/**
 * Listens to external events (Order Accepted, Driver Arrived, etc.)
 * and decides when to trigger a GenerateRouteCommand.
 */
export class TripLifecycleEngine {
  constructor(private eventBus: TripEventBus) {}

  public onOrderAccepted(
    tripId: string, 
    driverLat: number, 
    driverLng: number, 
    pickupLat: number, 
    pickupLng: number
  ): void {
    console.log(`[TRIP_LIFECYCLE] onOrderAccepted called for trip: ${tripId}. Driver: ${driverLat},${driverLng} Pickup: ${pickupLat},${pickupLng}`);
    // Determine reason and issue command
    this.eventBus.emitCommand('GenerateRouteCommand', {
      tripId,
      originLat: driverLat,
      originLng: driverLng,
      destinationLat: pickupLat,
      destinationLng: pickupLng,
      destinationId: 'pickup_location',
      reason: RouteGenerationReason.ORDER_ACCEPTED,
      destinationType: 'pickup'
    });
  }

  public onDriverArrived(
    tripId: string, 
    driverLat: number, 
    driverLng: number, 
    deliveryLat: number, 
    deliveryLng: number
  ): void {
    this.eventBus.emitCommand('GenerateRouteCommand', {
      tripId,
      originLat: driverLat,
      originLng: driverLng,
      destinationLat: deliveryLat,
      destinationLng: deliveryLng,
      destinationId: 'delivery_location',
      reason: RouteGenerationReason.DRIVER_ARRIVED,
      destinationType: 'delivery'
    });
  }
}
