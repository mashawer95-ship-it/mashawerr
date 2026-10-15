const mongoose = require('mongoose');
const { Order } = require('../middlewares/Order');
// BusinessOrderTracker removed – delivery-only

class DeliveryOrderTracker {
    /**
     * Builds the complete sequential stops for a regular delivery order based on:
     * 1. allLocationsInOrder (as configured by customer in multi_destination_search_page)
     * 2. tasks array (if allLocationsInOrder is not present)
     * 3. root pickup / delivery locations (fallback)
     *
     * @param {string|number} orderId - Numeric orderId, ObjectId string, or Order document
     * @returns {Promise<Object|null>}
     */
    static async getOrderTrack(orderId) {
        if (!orderId) return null;

        let order = null;

        if (typeof orderId === 'object' && (orderId._id || orderId.orderId != null || Array.isArray(orderId.allLocationsInOrder))) {
            order = orderId;
        } else {
            const strId = String(orderId).trim();
            if (mongoose.isValidObjectId(strId)) {
                order = await Order.findById(strId).lean();
            }
            if (!order && !isNaN(Number(strId))) {
                order = await Order.findOne({ orderId: Number(strId) }).lean();
            }
        }

        if (!order) return null;
        // BusinessOrderTracker delegation removed – delivery-only

        const stops = [];
        const allLocs = Array.isArray(order.allLocationsInOrder) ? order.allLocationsInOrder : [];
        const tasks = Array.isArray(order.tasks) ? order.tasks : [];

        function parseLatLng(loc) {
            if (!loc) return null;
            let lat = loc.lat ?? loc.latitude ?? loc.fromLatitude ?? loc.toLatitude;
            let lng = loc.lng ?? loc.longitude ?? loc.fromLongitude ?? loc.toLongitude;
            if ((lat == null || lng == null) && loc.latLng) {
                lat = loc.latLng.lat ?? loc.latLng.latitude;
                lng = loc.latLng.lng ?? loc.latLng.longitude;
            }
            if ((lat == null || lng == null) && loc.location) {
                lat = loc.location.lat ?? loc.location.latitude;
                lng = loc.location.lng ?? loc.location.longitude;
                if (Array.isArray(loc.location.coordinates) && loc.location.coordinates.length >= 2) {
                    lng = loc.location.coordinates[0];
                    lat = loc.location.coordinates[1];
                }
            }
            if ((lat == null || lng == null) && Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
                lng = loc.coordinates[0];
                lat = loc.coordinates[1];
            }
            if (lat != null && lng != null) {
                const numLat = Number(lat);
                const numLng = Number(lng);
                if (!isNaN(numLat) && !isNaN(numLng) && !(numLat === 0 && numLng === 0)) {
                    return { lat: numLat, lng: numLng };
                }
            }
            return null;
        }

        if (allLocs.length > 0) {
            let pickupCounter = 0;
            let deliveryCounter = 0;
            const totalPickupStops = allLocs.filter(l => l && (l.isFrom === true || l.isFrom === 'true')).length;

            for (let i = 0; i < allLocs.length; i++) {
                const loc = allLocs[i];
                if (!loc) continue;

                const isPickup = loc.isFrom === true;
                if (isPickup) {
                    pickupCounter++;
                } else {
                    deliveryCounter++;
                }

                // Extract LatLng
                const coords = parseLatLng(loc);
                const lat = coords?.lat ?? null;
                const lng = coords?.lng ?? null;

                const name = loc.name || loc.address || (isPickup ? `نقطة استلام ${pickupCounter}` : `نقطة تسليم ${deliveryCounter}`);
                const address = loc.address || loc.name || '';
                const title = isPickup
                    ? (pickupCounter > 1 ? `استلام ${pickupCounter}: ${name}` : `استلام 1: ${name}`)
                    : (deliveryCounter > 1 ? `تسليم ${deliveryCounter}: ${name}` : `تسليم 1: ${name}`);

                // Determine isCompleted status:
                // In multi-destination routes, each pickup stop relies on its own isCompleted status.
                // Single pickup routes can infer pickup completion from delivering status.
                let isCompleted = Boolean(loc.isCompleted === true);
                const orderStatus = String(order.status || '').toLowerCase();
                if (!isCompleted && isPickup) {
                    if (['delivered', 'completed'].includes(orderStatus)) {
                        isCompleted = true;
                    } else if (totalPickupStops === 1 && ['delivering', 'returned'].includes(orderStatus)) {
                        isCompleted = true;
                    }
                }
                if (!isCompleted && !isPickup) {
                    if (['delivered', 'completed'].includes(orderStatus)) {
                        isCompleted = true;
                    }
                }

                stops.push({
                    stopIndex: i,
                    taskIndex: isPickup ? (pickupCounter - 1) : (deliveryCounter - 1),
                    orderIndex: i + 1,
                    type: isPickup ? 'PICKUP' : 'DELIVERY',
                    title: title,
                    subtitle: address || name,
                    location: coords ? { lat, lng } : null,
                    lat: lat,
                    lng: lng,
                    latitude: lat,
                    longitude: lng,
                    isCompleted: isCompleted,
                    orderId: order.orderId,
                    name: name,
                    address: address,
                    isFrom: isPickup,
                });
            }
        } else if (tasks.length > 0) {
            // Pickups first, then Deliveries
            for (let j = 0; j < tasks.length; j++) {
                const t = tasks[j];
                const isPickedUp = Boolean(
                    t.isPickedUp === true ||
                    t.taskStatus === 'picked_up' ||
                    t.taskStatus === 'completed' ||
                    t.pickedUpAt != null ||
                    order.status === 'delivering' ||
                    order.status === 'delivered' ||
                    order.status === 'completed'
                );

                const pickupCoords = parseLatLng(t.pickupLocation) || parseLatLng({ lat: t.fromLatitude, lng: t.fromLongitude }) || parseLatLng(t);
                const pLat = pickupCoords?.lat ?? null;
                const pLng = pickupCoords?.lng ?? null;

                stops.push({
                    stopIndex: j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'PICKUP',
                    title: tasks.length > 1 ? `استلام ${j + 1}` : 'استلام 1',
                    subtitle: t.googleMapAddressFrom || t.pickupLocation?.streetName || '',
                    location: pickupCoords ? { lat: pLat, lng: pLng } : null,
                    lat: pLat,
                    lng: pLng,
                    latitude: pLat,
                    longitude: pLng,
                    isCompleted: isPickedUp,
                    orderId: order.orderId,
                    taskId: t.taskId,
                });
            }

            for (let j = 0; j < tasks.length; j++) {
                const t = tasks[j];
                const isDelivered = Boolean(
                    t.taskStatus === 'completed' ||
                    t.deliveredAt != null ||
                    order.status === 'delivered' ||
                    order.status === 'completed'
                );

                const dropCoords = parseLatLng(t.deliveryLocation) || parseLatLng({ lat: t.toLatitude, lng: t.toLongitude }) || parseLatLng(t);
                const dLat = dropCoords?.lat ?? null;
                const dLng = dropCoords?.lng ?? null;

                stops.push({
                    stopIndex: tasks.length + j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'DELIVERY',
                    title: tasks.length > 1 ? `تسليم ${j + 1}` : 'تسليم 1',
                    subtitle: t.googleMapAddressTo || t.deliveryLocation?.streetName || '',
                    location: dropCoords ? { lat: dLat, lng: dLng } : null,
                    lat: dLat,
                    lng: dLng,
                    latitude: dLat,
                    longitude: dLng,
                    isCompleted: isDelivered,
                    orderId: order.orderId,
                    taskId: t.taskId,
                });
            }
        } else {
            // Basic 2-stop single pickup / single drop
            const isPickedUp = Boolean(order.status === 'delivering' || order.status === 'delivered' || order.status === 'completed' || order.pickupPhoto || order.itemPhotoBefore);
            const isDelivered = Boolean(order.status === 'delivered' || order.status === 'completed' || order.deliveryPhoto || order.itemPhotoAfter);

            const pickupCoords = parseLatLng(order.pickupLocation) || parseLatLng({ lat: order.fromLatitude, lng: order.fromLongitude }) || parseLatLng(order);
            const pLat = pickupCoords?.lat ?? null;
            const pLng = pickupCoords?.lng ?? null;

            stops.push({
                stopIndex: 0,
                taskIndex: 0,
                orderIndex: 1,
                type: 'PICKUP',
                title: 'استلام 1',
                subtitle: order.googleMapAddressFrom || '',
                location: pickupCoords ? { lat: pLat, lng: pLng } : null,
                lat: pLat,
                lng: pLng,
                latitude: pLat,
                longitude: pLng,
                isCompleted: isPickedUp,
                orderId: order.orderId,
            });

            const dropCoords = parseLatLng(order.deliveryLocation) || parseLatLng({ lat: order.toLatitude, lng: order.toLongitude }) || parseLatLng(order);
            const dLat = dropCoords?.lat ?? null;
            const dLng = dropCoords?.lng ?? null;

            stops.push({
                stopIndex: 1,
                taskIndex: 0,
                orderIndex: 2,
                type: 'DELIVERY',
                title: 'تسليم 1',
                subtitle: order.googleMapAddressTo || '',
                location: dropCoords ? { lat: dLat, lng: dLng } : null,
                lat: dLat,
                lng: dLng,
                latitude: dLat,
                longitude: dLng,
                isCompleted: isDelivered,
                orderId: order.orderId,
            });
        }

        const orderStatus = String(order.status || '').toLowerCase();
        const isOrderTerminal = ['delivered', 'completed'].includes(orderStatus);
        const firstIncompleteIdx = stops.findIndex(s => !s.isCompleted);

        // 🔒 STRICT: An order in active delivery/transit status CANNOT be marked completed!
        let isAllCompleted = false;
        if (isOrderTerminal) {
            isAllCompleted = true;
        } else if (['delivering', 'accepted', 'waiting', 'assigned', 'processing'].includes(orderStatus)) {
            isAllCompleted = false;
        } else {
            isAllCompleted = firstIncompleteIdx === -1;
        }

        const pickupStops = stops.filter(s => s.type === 'PICKUP');
        const allPickupsDone = pickupStops.length > 0 && (
            pickupStops.every(s => s.isCompleted) ||
            (pickupStops.length === 1 && ['delivering', 'delivered', 'completed'].includes(orderStatus))
        );

        let currentStopIndex = 0;
        if (isAllCompleted) {
            currentStopIndex = stops.length > 0 ? stops.length - 1 : 0;
        } else if (firstIncompleteIdx !== -1) {
            currentStopIndex = firstIncompleteIdx;
        } else {
            const lastDropIdx = stops.map(s => s.type).lastIndexOf('DELIVERY');
            currentStopIndex = lastDropIdx !== -1 ? lastDropIdx : (stops.length > 0 ? stops.length - 1 : 0);
        }

        const currentStop = isAllCompleted ? null : stops[currentStopIndex];
        const phase = isAllCompleted ? 'COMPLETED' : (currentStop ? currentStop.type : (allPickupsDone ? 'DELIVERY' : 'PICKUP'));

        return {
            orderId: order.orderId,
            representativeId: order.representativeId,
            customerId: order.clientId || order.userId,
            totalStops: stops.length,
            stops,
            currentStopIndex,
            currentStop,
            phase,
            allPickupsDone,
            isAllCompleted,
        };
    }
}

module.exports = { DeliveryOrderTracker };
