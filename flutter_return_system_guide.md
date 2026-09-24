# 📱 دليل فلاتر الاحترافي: نظام استرجاع طلبات المتاجر (Flutter Clean Architecture)
**نسخة معمارية متقدمة مصممة لملايين المستخدمين (High Concurrency & Clean Code)**

---

## 🏛️ معمارية الطبقات (Layered Architecture Diagram)

```
┌────────────────────────────────────────────────────────┐
│                   Presentation Layer                   │
│   ReturnButton ➔ ReturnRequestBottomSheet ➔ ReturnCubit │
└───────────────────────────┬────────────────────────────┘
                            │ (Calls UseCases)
┌───────────────────────────▼────────────────────────────┐
│                      Domain Layer                      │
│   UseCases (CheckEligibility, SubmitReturn)           │
│   Entities (ReturnEligibility, ReturnDetails)          │
│   IReturnRepository (Abstract Interface)               │
└───────────────────────────▲────────────────────────────┘
                            │ (Implemented by Data Layer)
┌───────────────────────────┴────────────────────────────┐
│                       Data Layer                       │
│   ReturnRepositoryImpl                                 │
│   ReturnRemoteDataSource (Dio / HTTP / Interceptors)   │
│   Models & DTOs (ReturnEligibilityModel, Json Mappers) │
└────────────────────────────────────────────────────────┘
```

---

## 1️⃣ الطبقة الأولى: Domain Layer (Entities & UseCases)

### Entity: `ReturnEligibility`
```dart
import 'package:equatable/equatable.dart';

class ReturnEligibility extends Equatable {
  final bool isEligible;
  final double hoursRemaining;
  final DateTime? deliveredAt;
  final DateTime? deadline;
  final int deliveryPriceFils;
  final String deliveryPriceKWD;
  final String feeWarningNotice;
  final List<ReturnItemEntity> items;

  const ReturnEligibility({
    required this.isEligible,
    required this.hoursRemaining,
    this.deliveredAt,
    this.deadline,
    required this.deliveryPriceFils,
    required this.deliveryPriceKWD,
    required this.feeWarningNotice,
    required this.items,
  });

  @override
  List<Object?> get props => [isEligible, hoursRemaining, deliveryPriceFils, items];
}

class ReturnItemEntity extends Equatable {
  final String productId;
  final String name;
  final double price;
  final int quantity;
  final String? productImage;
  final int itemIndex;

  const ReturnItemEntity({
    required this.productId,
    required this.name,
    required this.price,
    required this.quantity,
    this.productImage,
    required this.itemIndex,
  });

  @override
  List<Object?> get props => [productId, name, price, quantity];
}
```

### Abstract Repository Contract: `IReturnRepository`
```dart
import 'package:dartz/dartz.dart';

abstract class IReturnRepository {
  Future<Either<Failure, ReturnEligibility>> checkEligibility(String orderId);
  Future<Either<Failure, bool>> submitReturnRequest({
    required String orderId,
    required String reason,
    required bool agreeToDeliveryFee,
    List<Map<String, dynamic>>? items,
  });
}
```

### UseCases:
```dart
class CheckReturnEligibilityUseCase {
  final IReturnRepository repository;
  CheckReturnEligibilityUseCase(this.repository);

  Future<Either<Failure, ReturnEligibility>> call(String orderId) async {
    return await repository.checkEligibility(orderId);
  }
}

class SubmitReturnRequestUseCase {
  final IReturnRepository repository;
  SubmitReturnRequestUseCase(this.repository);

  Future<Either<Failure, bool>> call({
    required String orderId,
    required String reason,
    required bool agreeToDeliveryFee,
    List<Map<String, dynamic>>? items,
  }) async {
    if (reason.trim().isEmpty) {
      return Left(ValidationFailure('سبب الاسترجاع مطلوب'));
    }
    if (!agreeToDeliveryFee) {
      return Left(ValidationFailure('يجب الموافقة على دفع رسوم التوصيل'));
    }
    return await repository.submitReturnRequest(
      orderId: orderId,
      reason: reason,
      agreeToDeliveryFee: agreeToDeliveryFee,
      items: items,
    );
  }
}
```

---

## 2️⃣ الطبقة الثانية: Data Layer (Models & DataSources)

### Model: `ReturnEligibilityModel`
```dart
class ReturnEligibilityModel extends ReturnEligibility {
  const ReturnEligibilityModel({
    required super.isEligible,
    required super.hoursRemaining,
    super.deliveredAt,
    super.deadline,
    required super.deliveryPriceFils,
    required super.deliveryPriceKWD,
    required super.feeWarningNotice,
    required super.items,
  });

  factory ReturnEligibilityModel.fromJson(Map<String, dynamic> json) {
    return ReturnEligibilityModel(
      isEligible: json['eligible'] == true,
      hoursRemaining: (json['hoursRemaining'] as num?)?.toDouble() ?? 0.0,
      deliveredAt: json['deliveredAt'] != null ? DateTime.tryParse(json['deliveredAt']) : null,
      deadline: json['deadline'] != null ? DateTime.tryParse(json['deadline']) : null,
      deliveryPriceFils: json['deliveryPriceFils'] ?? 0,
      deliveryPriceKWD: json['deliveryPriceKWD']?.toString() ?? '0.000',
      feeWarningNotice: json['feeWarningNotice'] ?? '',
      items: (json['items'] as List<dynamic>?)
              ?.map((item) => ReturnItemModel.fromJson(item))
              .toList() ??
          [],
    );
  }
}

class ReturnItemModel extends ReturnItemEntity {
  const ReturnItemModel({
    required super.productId,
    required super.name,
    required super.price,
    required super.quantity,
    super.productImage,
    required super.itemIndex,
  });

  factory ReturnItemModel.fromJson(Map<String, dynamic> json) {
    return ReturnItemModel(
      productId: json['productId']?.toString() ?? '',
      name: json['name'] ?? '',
      price: (json['price'] as num?)?.toDouble() ?? 0.0,
      quantity: json['quantity'] ?? 1,
      productImage: json['productImage'],
      itemIndex: json['itemIndex'] ?? 1,
    );
  }
}
```

### Remote DataSource: `ReturnRemoteDataSource`
```dart
import 'package:dio/dio.dart';

class ReturnRemoteDataSource {
  final Dio dio;
  ReturnRemoteDataSource(this.dio);

  Future<ReturnEligibilityModel> checkEligibility(String orderId) async {
    try {
      final response = await dio.get('/api/store/orders/$orderId/return-eligibility');
      return ReturnEligibilityModel.fromJson(response.data);
    } on DioException catch (e) {
      if (e.response?.data?['code'] == 'RETURN_WINDOW_EXPIRED') {
        throw ReturnWindowExpiredException(
          e.response?.data?['message'] ?? 'تعديت الحد الأقصى لمده الاسترجاع',
        );
      }
      throw ServerException(e.response?.data?['message'] ?? 'حدث خطأ في السيرفر');
    }
  }

  Future<bool> requestReturn({
    required String orderId,
    required String reason,
    required bool agreeToFee,
    List<Map<String, dynamic>>? items,
  }) async {
    try {
      final response = await dio.post(
        '/api/store/orders/$orderId/request-return',
        data: {
          'reason': reason,
          'agreeToDeliveryFee': agreeToFee,
          if (items != null) 'items': items,
        },
      );
      return response.data['succeeded'] == true;
    } on DioException catch (e) {
      throw ServerException(e.response?.data?['message'] ?? 'فشل تقديم طلب الاسترجاع');
    }
  }
}
```

---

## 3️⃣ الطبقة الثالثة: Presentation Layer (State Management - Cubit)

### Cubit States:
```dart
abstract class ReturnState extends Equatable {
  const ReturnState();
  @override
  List<Object?> get props => [];
}

class ReturnInitial extends ReturnState {}
class ReturnCheckingEligibility extends ReturnState {}

class ReturnEligibleState extends ReturnState {
  final ReturnEligibility eligibility;
  const ReturnEligibleState(this.eligibility);
  @override
  List<Object?> get props => [eligibility];
}

class ReturnExpiredState extends ReturnState {
  final String message;
  const ReturnExpiredState(this.message);
  @override
  List<Object?> get props => [message];
}

class ReturnSubmitting extends ReturnState {}

class ReturnSuccess extends ReturnState {
  final String message;
  const ReturnSuccess(this.message);
  @override
  List<Object?> get props => [message];
}

class ReturnError extends ReturnState {
  final String error;
  const ReturnError(this.error);
  @override
  List<Object?> get props => [error];
}
```

### ReturnCubit:
```dart
import 'package:flutter_bloc/flutter_bloc.dart';

class ReturnCubit extends Cubit<ReturnState> {
  final CheckReturnEligibilityUseCase checkEligibilityUseCase;
  final SubmitReturnRequestUseCase submitReturnUseCase;

  ReturnCubit({
    required this.checkEligibilityUseCase,
    required this.submitReturnUseCase,
  }) : super(ReturnInitial());

  Future<void> checkEligibility(String orderId) async {
    emit(ReturnCheckingEligibility());
    final result = await checkEligibilityUseCase(orderId);
    result.fold(
      (failure) {
        if (failure is ReturnWindowExpiredFailure) {
          emit(ReturnExpiredState(failure.message));
        } else {
          emit(ReturnError(failure.message));
        }
      },
      (eligibility) {
        if (eligibility.isEligible) {
          emit(ReturnEligibleState(eligibility));
        } else {
          emit(ReturnExpiredState('تعديت الحد الأقصى لمده الاسترجاع'));
        }
      },
    );
  }

  Future<void> submitReturn({
    required String orderId,
    required String reason,
    required bool agreeToFee,
    List<Map<String, dynamic>>? items,
  }) async {
    emit(ReturnSubmitting());
    final result = await submitReturnUseCase(
      orderId: orderId,
      reason: reason,
      agreeToDeliveryFee: agreeToFee,
      items: items,
    );
    result.fold(
      (failure) => emit(ReturnError(failure.message)),
      (_) => emit(const ReturnSuccess('تم تقديم طلب الاسترجاع بنجاح وتحويل الطلب إلى قيد الانتظار')),
    );
  }
}
```

---

## 4️⃣ واجهات العميل (Customer App UI Components)

### 1. زر المرتجع الذكي مع فحص الصلاحية (`ReturnActionButton`)
```dart
class ReturnActionButton extends StatelessWidget {
  final String orderId;
  final bool canReturn;
  final double remainingHours;
  final VoidCallback onOpenReturnSheet;

  const ReturnActionButton({
    super.key,
    required this.orderId,
    required this.canReturn,
    required this.remainingHours,
    required this.onOpenReturnSheet,
  });

  @override
  Widget build(BuildContext context) {
    if (!canReturn) {
      return OutlinedButton.icon(
        onPressed: () {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('⚠️ تعديت الحد الأقصى لمده الاسترجاع (48 ساعة من تاريخ الاستلام)'),
              backgroundColor: Colors.redAccent,
            ),
          );
        },
        icon: const Icon(Icons.history, color: Colors.grey, size: 18),
        label: const Text('غير متاح للاسترجاع', style: TextStyle(color: Colors.grey)),
        style: OutlinedButton.styleFrom(
          side: const BorderSide(color: Colors.grey),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      );
    }

    return ElevatedButton.icon(
      onPressed: onOpenReturnSheet,
      icon: const Icon(Icons.replay_rounded, color: Colors.white, size: 20),
      label: Text(
        'مرتجع (${remainingHours.toStringAsFixed(0)} ساعة متبقية)',
        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
      ),
      style: ElevatedButton.styleFrom(
        backgroundColor: const Color(0xFF7C3AED), // Premium Purple
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        elevation: 3,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    );
  }
}
```

### 2. شاشة الاسترجاع المنبثقة التفاعلية (`ReturnRequestBottomSheet`)
```dart
class ReturnRequestBottomSheet extends StatefulWidget {
  final String orderId;
  final ReturnEligibility eligibility;

  const ReturnRequestBottomSheet({
    super.key,
    required this.orderId,
    required this.eligibility,
  });

  @override
  State<ReturnRequestBottomSheet> createState() => _ReturnRequestBottomSheetState();
}

class _ReturnRequestBottomSheetState extends State<ReturnRequestBottomSheet> {
  final _reasonController = TextEditingController();
  bool _agreedToFee = false;
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'طلب استرجاع المنتجات',
                    style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                'يمكنك تقديم طلب استرجاع المنتجات خلال 48 ساعة من تاريخ الاستلام.',
                style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
              ),
              const SizedBox(height: 18),

              // Product Mini-List
              Text('المنتجات المراد إرجاعها:', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: widget.eligibility.items.length,
                separatorBuilder: (_, __) => const Divider(height: 12),
                itemBuilder: (context, index) {
                  final item = widget.eligibility.items[index];
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: item.productImage != null
                          ? Image.network(item.productImage!, width: 48, height: 48, fit: BoxFit.cover)
                          : Container(width: 48, height: 48, color: Colors.grey.shade200, child: const Icon(Icons.shopping_bag)),
                    ),
                    title: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('الكمية: ${item.quantity} | السعر: ${item.price} د.ك'),
                  );
                },
              ),
              const SizedBox(height: 20),

              // Reason Input
              TextFormField(
                controller: _reasonController,
                maxLines: 3,
                validator: (val) => (val == null || val.trim().isEmpty) ? 'يرجى كتابة سبب الاسترجاع بوضوح' : null,
                decoration: InputDecoration(
                  labelText: 'سبب الاسترجاع *',
                  hintText: 'اكتب سبب طلب الاسترجاع (مثل: عيب صناعة، مقاس غير مناسب...)',
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                  filled: true,
                  fillColor: Colors.grey.shade50,
                ),
              ),
              const SizedBox(height: 20),

              // ⚠️ Fee Warning Banner Card
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.amber.shade50,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.amber.shade300, width: 1.2),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.info_outline_rounded, color: Colors.amber, size: 22),
                        const SizedBox(width: 8),
                        Text(
                          'سعر توصيل المرتجع: ${widget.eligibility.deliveryPriceKWD} د.ك',
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Colors.black87),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'تنبيه: سيتم تطبيق رسوم التوصيل على رحلة إرجاع المنتجات وستكون ملزماً بدفعها للمندوب عند الاستلام.',
                      style: TextStyle(fontSize: 13, color: Colors.grey.shade800, height: 1.4),
                    ),
                    const SizedBox(height: 10),
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _agreedToFee,
                      activeColor: const Color(0xFF7C3AED),
                      onChanged: (val) => setState(() => _agreedToFee = val ?? false),
                      title: const Text(
                        'أوافق على دفع سعر التوصيل للمندوب عند استلام الشحنة المرتجعة',
                        style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                      ),
                      controlAffinity: ListTileControlAffinity.leading,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              // Confirm Button
              BlocConsumer<ReturnCubit, ReturnState>(
                listener: (context, state) {
                  if (state is ReturnSuccess) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(state.message), backgroundColor: Colors.green),
                    );
                  } else if (state is ReturnError) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(state.error), backgroundColor: Colors.red),
                    );
                  }
                },
                builder: (context, state) {
                  final isLoading = state is ReturnSubmitting;
                  return SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton(
                      onPressed: (_agreedToFee && !isLoading)
                          ? () {
                              if (_formKey.currentState?.validate() == true) {
                                context.read<ReturnCubit>().submitReturn(
                                      orderId: widget.orderId,
                                      reason: _reasonController.text.trim(),
                                      agreeToFee: _agreedToFee,
                                    );
                              }
                            }
                          : null,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF7C3AED),
                        disabledBackgroundColor: Colors.grey.shade300,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      ),
                      child: isLoading
                          ? const CircularProgressIndicator(color: Colors.white)
                          : const Text(
                              'تأكيد طلب الاسترجاع',
                              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white),
                            ),
                    ),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

---

## 5️⃣ واجهات المندوب (Representative App UI Dual-Interfaces)

عندما يكون الطلب مرتجعاً (`isReturnOrder == true`):
يتم عرض بطاقتين واضحتين تماماً لمنع أي التباس لدى المندوب:

```dart
class RepresentativeReturnDualCard extends StatelessWidget {
  final Map<String, dynamic> task;

  const RepresentativeReturnDualCard({super.key, required this.task});

  @override
  Widget build(BuildContext context) {
    final pickup = task['pickupLocation'];
    final delivery = task['deliveryLocation'];
    final isReturn = task['isReturnTask'] == true;

    return Card(
      elevation: 4,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Prominent Return Badge
            if (isReturn)
              Container(
                margin: const EdgeInsets.bottom: 16),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(
                  color: Colors.purple.shade50,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.purple.shade300),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.sync_alt_rounded, color: Colors.purple, size: 20),
                    SizedBox(width: 8),
                    Text(
                      'طلب مرتجع: استلام من العميل ➔ تسليم للوكيل/المتجر',
                      style: TextStyle(fontWeight: FontWeight.bold, color: Colors.purple),
                    ),
                  ],
                ),
              ),

            // 🟢 Section 1: Pickup from Customer (واجهة عميل)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.green.shade50.withOpacity(0.6),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Colors.green.shade300),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const CircleAvatar(
                        radius: 12,
                        backgroundColor: Colors.green,
                        child: Text('1', style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        pickup['roleLabel'] ?? 'واجهة عميل (استلام من العميل)',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.green, fontSize: 14),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text('العنوان: ${pickup['streetName']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  if (pickup['phoneNumber']?.isNotEmpty == true)
                    Text('هاتف العميل: ${pickup['phoneNumber']}', style: TextStyle(color: Colors.grey.shade800)),
                  const SizedBox(height: 4),
                  const Text('⚠️ المطلوب: استلام المنتجات المرتجعة وتحصيل رسوم التوصيل نقداً', style: TextStyle(color: Colors.teal, fontSize: 12, fontWeight: FontWeight.bold)),
                ],
              ),
            ),
            const SizedBox(height: 14),

            // 🔴 Section 2: Delivery to Store/Agent (واجهة وكيل)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.blue.shade50.withOpacity(0.6),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Colors.blue.shade300),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const CircleAvatar(
                        radius: 12,
                        backgroundColor: Colors.blue,
                        child: Text('2', style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        delivery['roleLabel'] ?? 'واجهة وكيل (تسليم للمتجر)',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.blue, fontSize: 14),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text('وجهة التسليم: ${delivery['streetName']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  const Text('المطلوب: تسليم المنتجات المرتجعة للوكيل وتوثيق صورة التسليم', style: TextStyle(color: Colors.blueGrey, fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
```
