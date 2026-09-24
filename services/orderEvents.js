/**
 * orderEvents.js
 * EventEmitter singleton for order lifecycle events in Mashawerr API.
 */

const EventEmitter = require('events');

class OrderEventEmitter extends EventEmitter {}

const orderEvents = new OrderEventEmitter();

module.exports = {
    orderEvents,
};
