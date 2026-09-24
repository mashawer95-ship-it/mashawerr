const mongoose = require('mongoose');
const { StoreOrder } = require('../middlewares/StoreOrder');

class BusinessOrderTracker {
    /**
     * Builds the complete sequential stops for a store/business order (or group).
     * Order with N items => 2N Sequential Tasks/Stops:
     * - Pickup 1, Pickup 2, ... Pickup N
     * - Delivery 1, Delivery 2, ... Delivery N
     *
     * @param {string|number} orderIdOrGroup - Order ID, StoreOrder ID, or parentGroupId
     * @returns {Promise<Object|null>}
     */
    static async getOrderTrack(orderIdOrGroup) {
        if (!orderIdOrGroup || mongoose.connection.readyState !== 1) return null;

        let subOrders = [];
        const strId = String(orderIdOrGroup).trim();
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(strId);

        if (isUUID) {
            subOrders = await StoreOrder.find({ parentGroupId: strId }).sort({ subOrderIndex: 1, createdAt: 1 }).lean();
        } else if (mongoose.isValidObjectId(strId)) {
            const o = await StoreOrder.findById(strId).lean();
            if (o?.parentGroupId) {
                subOrders = await StoreOrder.find({ parentGroupId: o.parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 }).lean();
            } else if (o) {
                subOrders = [o];
            }
        } else if (!isNaN(Number(strId))) {
            const numId = Number(strId);
            const allByStoreId = await StoreOrder.find({
                $or: [{ storeOrderId: numId }, { orderId: numId }]
            }).sort({ subOrderIndex: 1, createdAt: 1 }).lean();

            if (allByStoreId.length > 0 && allByStoreId[0]?.parentGroupId) {
                subOrders = await StoreOrder.find({ parentGroupId: allByStoreId[0].parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 }).lean();
            } else {
                subOrders = allByStoreId;
            }
        }

        if (!subOrders || subOrders.length === 0) return null;

        const items = [];
        let globalTaskIdx = 0;

        const isReturn = subOrders.some(s => s.isReturnOrder === true || (typeof s.status === 'string' && s.status.startsWith('return_')) || s.status === 'returned');
        const customerName = (subOrders[0]?.userInfo?.firstName || '') + ' ' + (subOrders[0]?.userInfo?.lastName || '');
        const cleanCustomerName = customerName.trim() || 'العميل';
        const returnReason = subOrders[0]?.returnDetails?.reason || '';

        for (const sub of subOrders) {
            const subItems = Array.isArray(sub.items) && sub.items.length > 0 ? sub.items : [{}];
            const subId = String(sub._id || sub.storeOrderId);
            const agentName = sub.agentName || sub.associationName || 'متجر';
            const subStatus = sub.status || 'pending';

            for (let i = 0; i < subItems.length; i++) {
                const item = subItems[i];
                const itemPickupLoc = (item.pickupLocation?.lat && item.pickupLocation?.lng)
                    ? item.pickupLocation
                    : sub.pickupLocation;
                const itemDeliveryLoc = (item.deliveryLocation?.lat && item.deliveryLocation?.lng)
                    ? item.deliveryLocation
                    : sub.deliveryLocation;

                let isPickedUp = false;
                let isDelivered = false;

                if (isReturn) {
                    // For returns: picked up from client when return_delivering or returned
                    isPickedUp = subStatus === 'return_delivering' || subStatus === 'returned' || item.status === 'return_delivering' || item.status === 'returned';
                    isDelivered = subStatus === 'returned' || item.status === 'returned';
                } else {
                    isPickedUp = item.isPickedUp === true ||
                        item.status === 'shipped' ||
                        item.status === 'delivering' ||
                        item.status === 'delivered' ||
                        (subItems.length === 1 && (sub.isPickedUp === true || sub.status === 'shipped' || sub.status === 'delivering' || sub.status === 'delivered'));

                    isDelivered = item.isDelivered === true ||
                        item.status === 'delivered' ||
                        item.status === 'completed' ||
                        (subItems.length === 1 && (sub.isDelivered === true || sub.status === 'delivered' || sub.status === 'completed'));
                }

                items.push({
                    globalTaskIndex: globalTaskIdx,
                    subOrderId: subId,
                    storeOrderId: sub.storeOrderId || sub.orderId,
                    itemIndex: i,
                    name: item.name || `منتج ${globalTaskIdx + 1}`,
                    agentName: agentName,
                    pickupLocation: itemPickupLoc,
                    deliveryLocation: itemDeliveryLoc,
                    isPickedUp: Boolean(isPickedUp),
                    isDelivered: Boolean(isDelivered),
                    status: item.status || sub.status
                });
                globalTaskIdx++;
            }
        }

        const totalItems = items.length;
        const stops = [];

        if (isReturn) {
            // 🔄 Inverted Sequence for Return Orders:
            // Phase 1: Pickups from Customer (واجهة عميل)
            for (let j = 0; j < totalItems; j++) {
                const it = items[j];
                stops.push({
                    stopIndex: j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'PICKUP',
                    isReturnStop: true,
                    isClientInterface: true,
                    isAgentInterface: false,
                    roleLabel: 'واجهة عميل (استلام من العميل)',
                    interfaceNotice: 'تنبيه: أنت الآن في واجهة العميل - استلم المنتجات المرتجعة وحصّل رسوم التوصيل',
                    title: `استلام مرتجع ${j + 1}: ${cleanCustomerName}`,
                    subtitle: returnReason ? `السبب: ${returnReason}` : it.name,
                    location: it.deliveryLocation, // Customer's address is the PICKUP point
                    isCompleted: it.isPickedUp || it.isDelivered,
                    subOrderId: it.subOrderId,
                    storeOrderId: it.storeOrderId,
                    itemIndex: it.itemIndex,
                    productName: it.name,
                    contactName: cleanCustomerName,
                    contactPhone: subOrders[0]?.userInfo?.phone || '',
                });
            }

            // Phase 2: Deliveries to Agent/Store (واجهة وكيل)
            for (let j = 0; j < totalItems; j++) {
                const it = items[j];
                stops.push({
                    stopIndex: totalItems + j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'DELIVERY',
                    isReturnStop: true,
                    isClientInterface: false,
                    isAgentInterface: true,
                    roleLabel: 'واجهة وكيل (تسليم للمتجر)',
                    interfaceNotice: 'تنبيه: أنت الآن في واجهة الوكيل - سلّم الشحنة المرتجعة للمتجر',
                    title: `تسليم مرتجع ${j + 1}: ${it.agentName || 'الوكيل'}`,
                    subtitle: it.name,
                    location: it.pickupLocation, // Store's address is the DELIVERY point
                    isCompleted: it.isDelivered,
                    subOrderId: it.subOrderId,
                    storeOrderId: it.storeOrderId,
                    itemIndex: it.itemIndex,
                    productName: it.name,
                    contactName: it.agentName || 'الوكيل',
                    contactPhone: '',
                });
            }
        } else {
            // 📦 Normal Delivery Sequence:
            // 1. Pickups Phase (from Agent/Store)
            for (let j = 0; j < totalItems; j++) {
                const it = items[j];
                stops.push({
                    stopIndex: j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'PICKUP',
                    isReturnStop: false,
                    isClientInterface: false,
                    isAgentInterface: true,
                    roleLabel: 'واجهة متجر (استلام)',
                    title: `استلام ${j + 1}: ${it.agentName || 'متجر'}`,
                    subtitle: it.name,
                    location: it.pickupLocation,
                    isCompleted: it.isPickedUp || it.isDelivered,
                    subOrderId: it.subOrderId,
                    storeOrderId: it.storeOrderId,
                    itemIndex: it.itemIndex,
                    productName: it.name
                });
            }

            // 2. Deliveries Phase (to Customer)
            for (let j = 0; j < totalItems; j++) {
                const it = items[j];
                stops.push({
                    stopIndex: totalItems + j,
                    taskIndex: j,
                    orderIndex: j + 1,
                    type: 'DELIVERY',
                    isReturnStop: false,
                    isClientInterface: true,
                    isAgentInterface: false,
                    roleLabel: 'واجهة عميل (تسليم)',
                    title: `تسليم ${j + 1}: ${it.name}`,
                    subtitle: it.agentName,
                    location: it.deliveryLocation,
                    isCompleted: it.isDelivered,
                    subOrderId: it.subOrderId,
                    storeOrderId: it.storeOrderId,
                    itemIndex: it.itemIndex,
                    productName: it.name
                });
            }
        }

        const firstIncompleteIdx = stops.findIndex(s => !s.isCompleted);
        const isAllCompleted = firstIncompleteIdx === -1;
        const allPickupsDone = stops.filter(s => s.type === 'PICKUP').every(s => s.isCompleted);

        const currentStopIndex = isAllCompleted ? stops.length - 1 : firstIncompleteIdx;
        const currentStop = isAllCompleted ? null : stops[currentStopIndex];
        const phase = isAllCompleted ? 'COMPLETED' : currentStop.type;

        return {
            orderId: subOrders[0].storeOrderId || subOrders[0].orderId,
            parentGroupId: subOrders[0].parentGroupId,
            representativeId: subOrders[0].representativeId,
            customerId: subOrders[0].userId || subOrders[0].clientId,
            totalItems,
            totalStops: stops.length,
            stops,
            currentStopIndex,
            currentStop,
            phase,
            allPickupsDone,
            isAllCompleted
        };
    }
}

module.exports = { BusinessOrderTracker };
