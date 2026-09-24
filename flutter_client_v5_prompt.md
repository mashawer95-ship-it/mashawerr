# 🚀 Flutter Client V5 - Updated Integration Prompt
**نسخة محدّثة بعد آخر تعديلات الباك إند (2026-07-11)**
قم بنسخ هذا البرومبت وإعطائه للذكاء الاصطناعي أو المبرمج المسؤول عن كود Flutter.

---

## 🎯 الهدف المعماري
السيرفر هو الـ **Authority** الوحيد. فلاتر = **Thin Intelligent Client**.
- لا يستدعي Google Directions API إطلاقاً.
- لا يحسب مسارات.
- فقط يستقبل ويرسم.

---

## 🔌 تفاصيل الاتصال بالـ Socket.IO

### الـ URL
```
ws://<TRACKING_SERVICE_HOST>:<PORT>
```
> tracking-service هو **سيرفر منفصل** عن الـ Main API.

### 1. الاتصال والانضمام للغرفة
```dart
// بعد قبول الطلب مباشرة
socket.connect();

// ✅ الحدث الصحيح هو: 'join_trip' (وليس 'subscribe')
socket.emit('join_trip', {'tripId': orderId.toString()});

// استقبال تأكيد الاشتراك
socket.on('subscribed', (data) {
  // data = { tripId: '123', hasLocation: false }
  // hasLocation = false تعني أن المندوب لم يبدأ البث بعد
  // ابقَ في شاشة Loading حتى يصل trip.route.updated
});
```

---

### 2. استقبال مسار الرحلة → `trip.route.updated`
```dart
// ⚠️ مهم: السيرفر يُرسل Object وليس String مباشرة
socket.on('trip.route.updated', (data) {
  // data هو Map<String, dynamic>
  final String encodedPolyline = data['encodedPolyline'] as String;

  // 1. فكّ تشفير الـ Polyline
  final List<LatLng> points = PolylinePoints()
      .decodePolyline(encodedPolyline)
      .map((p) => LatLng(p.latitude, p.longitude))
      .toList();

  // 2. ارسم على الخريطة
  setState(() {
    _polylines = {
      Polyline(
        polylineId: const PolylineId('route'),
        points: points,
        color: Colors.blue,
        width: 5,
      ),
    };
    _isLoadingRoute = false; // أخفِ شاشة Loading
  });
});
```

---

### 3. استقبال موقع المندوب → `trip.driver.location`
```dart
socket.on('trip.driver.location', (data) {
  // data = DriverPose object
  // {
  //   "tripId": "123",
  //   "matchedLat": 26.3394,
  //   "matchedLng": 31.8859,
  //   "bearing": 120.5,
  //   "speed": 15.2,           // km/h
  //   "motionState": "moving", // "moving" | "stopped" | "turning" | "high_speed"
  //   "routeVersion": 1
  // }

  final pose = DriverPose.fromJson(data);

  // 1. حدّث DriverPoseEngine بآخر إحداثيات حقيقية
  _driverPoseEngine.update(pose);

  // 2. PredictionEngine يستخدم speed + bearing للحساب بين التحديثات
  // 3. RenderingEngine (Ticker 60fps) يرسم الـ Marker بنعومة
});
```

---

## 📋 قائمة التغييرات المطلوبة في الكود

### ❌ احذف فوراً
- أي كود `http.get` أو `http.post` لـ Google Directions API أثناء التتبع.
- أي استخدام لـ `flutter_polyline_points` لجلب مسارات (يمكن الإبقاء عليه لفكّ التشفير فقط).

### ✅ عدّل
1. **حدث الانضمام**: من `'subscribe'` إلى `'join_trip'`.
2. **استقبال المسار**: من `data as String` إلى `data['encodedPolyline'] as String`.

### ✅ أضف
1. **شاشة Loading** (`_isLoadingRoute = true`) تظهر فوق الخريطة عند فتح صفحة التتبع لطلب مقبول، وتختفي عند وصول `trip.route.updated`.
2. **استقبال حدث `subscribed`** لتعرف أن الاتصال تم بنجاح.
3. **`DriverPoseEngine`**: يخزن آخر `matchedLat`, `matchedLng`, `bearing`, `speed`.
4. **`PredictionEngine` (Dead Reckoning)**: يحسب الموقع المتوقع بين التحديثات (لأن السيرفر يرسل كل 1-3 ثانية فقط).
5. **`RenderingEngine`**: مرتبط بـ `Ticker` يعمل 60fps لتحريك الـ Marker بنعومة.

---

## 🗺️ تدفق البيانات الكامل (Full Data Flow)

```
Driver App يرسل GPS
    ↓ (Socket.IO → tracking-service)
MapMatchingEngine → DriverPose (matched to road)
    ↓ (TripEventBus)
TripBroadcastService (Adaptive Rate: 300ms - 3000ms)
    ↓ (Socket.IO → trip:${orderId} room)
Flutter Client يستقبل 'trip.driver.location'
    ↓
DriverPoseEngine → PredictionEngine → RenderingEngine (60fps)
    ↓
Marker يتحرك بنعومة على الخريطة

─────────────────────────────────────────────

OrderController.acceptOrder() (Main API)
    ↓ (Redis Pub/Sub → trip:events channel)
tracking-service (server.ts listener)
    ↓
TripLifecycleEngine → RouteCoordinator → RoutingEngine
    ↓ (Google Routes API)
RouteSnapshot (encodedPolyline)
    ↓ (RedisTripRouteStore → TripEventBus)
TripBroadcastService
    ↓ (Socket.IO → trip:${orderId} room)
Flutter Client يستقبل 'trip.route.updated'
    ↓
{ encodedPolyline: "encoded_string..." }
    ↓
RouteRenderEngine → Polyline على الخريطة
```

---

## ⚠️ ملاحظات مهمة

1. **`tripId` = `orderId`**: الغرفة هي `trip:${orderId}` - استخدم رقم الأوردر.
2. **Race Condition**: قد يصل `trip.driver.location` قبل `trip.route.updated` - تعامل معه بـ Loading state.
3. **Adaptive Rate**: السيرفر يرسل `trip.driver.location` بمعدلات مختلفة:
   - متوقف: كل 3 ثوانٍ
   - متحرك: كل ثانية
   - منعطف: كل 300ms
   - سرعة عالية: كل 500ms
   
   لذلك **PredictionEngine ضروري** لتجنب تقطّع حركة الماركر.
