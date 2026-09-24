# 📱 Flutter Team Prompt: Ultra-Senior Tracking & Navigation Architecture

## 🌟 The Vision (Thin Intelligent Client)
نظام التتبع تم نقله ليكون **Server-Authoritative**. السيرفر هو من يحسب المسارات والانحرافات. ومع ذلك، تطبيق Flutter **ليس مجرد عارض غبي (Viewer)**، بل هو **Thin Intelligent Client**.
السيرفر يرسل البيانات الأساسية، وتطبيق Flutter مسؤول عن المهام المعقدة لضمان تجربة مستخدم تضاهي Uber: 
**Prediction, Animation, Interpolation, Dead Reckoning, Marker Physics, and Camera Control.**

---

## 🏛️ البنية الهندسية داخل فلاتر (The Flutter Pipeline)
ممنوع توصيل الـ `Socket` مباشرة بـ `GoogleMap`. يجب بناء محركات (Engines) مستقلة تماماً وتعمل بتسلسل:
`Socket` ➔ `TripSyncEngine` ➔ `RouteRenderEngine` ➔ `DriverPoseEngine` ➔ `PredictionEngine` ➔ `MarkerPhysicsEngine` ➔ `CameraEngine` ➔ `RenderingEngine` ➔ `GoogleMap`

---

## 🛠️ تفاصيل المحركات والمهام (Core Engines & Requirements)

### 1️⃣ نموذج البيانات الموحد (MarkerPose)
يجب أن تعتمد كل المحركات على كيان واحد متكامل يسمى `MarkerPose` بدلاً من تمرير الإحداثيات منفردة:
```dart
class MarkerPose {
  final LatLng position;
  final double heading;
  final double bearing;
  final double speed;
  final MotionState motionState;
  final double acceleration;
  final double turnRate;
  final int timestamp;
  final int sequence;
}
```

### 2️⃣ محرك الـ Pose والـ Buffer (Pose Buffer)
- **لا تحرك الماركر فور استلام الموقع.**
- `DriverPoseEngine` يجب أن يمتلك **Pose Buffer** يحتفظ بآخر 5 Poses.
- هذا يمنع الـ Lag ويسمح للمحرك بعمل Interpolation سلس بين النقاط.

### 3️⃣ محرك التوقع (Prediction Engine & Dead Reckoning)
- لا تقم بعمل `setState` أو `Animation` خطي بسيط.
- استخدم **Constant Velocity Prediction** ثم **Constant Turn Rate Prediction** مع **Acceleration Compensation**.
- إذا تأخر السيرفر عن إرسال التحديث لمدة ثانية، يجب أن يستمر الماركر بالحركة محلياً بناءً على الفيزياء. عند وصول تحديث جديد، يصحح المحرك مساره بانسيابية (بدون Jumps أو قفزات).

### 4️⃣ محرك الكاميرا (Camera Engine)
- **ممنوع ربط الكاميرا بالماركر بشكل مباشر (Hard Lock).**
- الكاميرا تمر بـ `CameraPredictor` ➔ `CameraDamping` ➔ `CameraOffset`.
- **Camera Offset:** السيارة يجب أن تكون دائماً في **الثلث السفلي** من الشاشة (وليس المنتصف) لكشف الطريق أمام السائق.
- **Physics (Second Order Motion):** لو الماركر التف بسرعة (Turn)، الكاميرا يجب أن تتبعه بنعومة وتأخير طفيف (Damping) لمنع دوار الحركة (Motion Sickness) للمستخدم.

### 5️⃣ محرك رسم المسار (Route Render Engine)
- **Layering:** يجب فصل الطبقات (Trip Route, Customer, Driver, Traffic, Destination) ولا تخلط ببعضها.
- **Polyline Cache:** قم ببناء `PolylineCache`. إذا استلمت `routeVersion` و `checksum` مطابق لما تم فك تشفيره مسبقاً، تجاهل الـ Decode تماماً.
- **Route Transitions:** عند حدوث Reroute، **لا تمسح المسار القديم فجأة.** قم بعمل (Cross-Fade). اجعل المسار القديم يتلاشى (Fade Out) بينما يظهر المسار الجديد (Animate In). هذا ما يفعله Google Maps.

### 6️⃣ آلة حالة الماركر (Marker State Machine)
التحكم بحالة الماركر لا يجب أن يكون بـ `if/else`. استخدم `MarkerState`:
- `Idle`, `Following`, `Predicting`, `Reconnecting`, `WaitingRoute`, `Transitioning`.

### 7️⃣ حلقة الرسم (Rendering Loop - 60FPS)
- **لا تستخدم `setState()` كلما جاء تحديث من الـ Socket.**
- استخدم `Ticker` يعمل بـ **60 إطار في الثانية (60 FPS)**.
- الـ Ticker يسحب البيانات من `AnimationEngine` ويوجهها لـ `MapRenderer` مباشرة لضمان نعومة استثنائية.

### 8️⃣ جودة الرسم (Rendering Quality)
- قم بتصنيف جودة الاتصال بناءً على تواتر وصول الـ Poses إلى: `Excellent`, `Good`, `Poor`.
- إذا كانت الجودة `Poor`، قم بزيادة الـ Damping (التنعيم/اللزوجة) في الـ Animation Engine لتقليل الاهتزازات.

### 9️⃣ التعافي من انقطاع الاتصال (Socket Recovery)
- إذا انقطع الـ Socket، **لا تمسح الخريطة.**
- بمجرد الـ `Reconnect`، اشترك في الرحلة واستقبل الـ Snapshot من السيرفر.
- قم بعمل `Resume Animation` لاستكمال الحركة من آخر مكان معروف للمكان الجديد بانسيابية تامة.

---
**رسالة الختام:**
أنتم تبنون تطبيقا ينافس عمالقة الصناعة. هذا المعمار (Pipeline) المكون من عدة Engines منفصلة سيجعل الكود قابلاً للاختبار (Testable)، قابلاً للصيانة، ويقدم تجربة بصرية ونافيجيشن (Navigation) حريرية (Silky Smooth) للمستخدمين.
