import EventEmitter from 'events';
import { DriverPose } from '../../domain/entities/DriverPose';
import { GenerateRouteCommand, RouteGeneratedEvent } from '../../domain/entities/CommandsEvents';

/**
 * Internal CQRS Event Bus to decouple engines.
 */
export class TripEventBus extends EventEmitter {
  // --- COMMANDS ---
  public emitCommand(commandName: 'GenerateRouteCommand', payload: GenerateRouteCommand): void {
    this.emit(commandName, payload);
  }

  public onCommand(commandName: 'GenerateRouteCommand', listener: (payload: GenerateRouteCommand) => void): void {
    this.on(commandName, listener);
  }

  // --- EVENTS ---
  public emitPose(pose: DriverPose): void {
    this.emit('trip.driver.location', pose);
  }

  public emitRouteGenerated(event: RouteGeneratedEvent): void {
    this.emit('trip.route.generated', event);
  }

  public onPose(listener: (pose: DriverPose) => void): void {
    this.on('trip.driver.location', listener);
  }

  public onRouteGenerated(listener: (event: RouteGeneratedEvent) => void): void {
    this.on('trip.route.generated', listener);
  }
}
