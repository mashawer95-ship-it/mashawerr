# 📱 Flutter Integration Guide: Product Item Pickup & Delivery Photos

هذا الدليل مخصص لمطور تطبيق فلاتر (Flutter) لعرض صور الاستلام والتسليم الخاطة بكل منتج بعينه داخل تفاصيل وقوائم طلبات البيزنيس.

---

## 📡 1. حقول الاستجابة المرجعة من الباك إند (JSON Structure)

عند طلب أي أوردر بيزنيس، يعيد الباك إند مصفوفة المنتجات `items` حيث يحتوي كل عنصر فيها على صور الاستلام والتسليم الخاصة به:

```json
{
  "orderId": "1045",
  "isBusinessOrder": true,
  "pickupPhotoUrl": "https://mashawerr-api.onrender.com/uploads/pod/pickup_main.jpg",
  "deliveryPhotoUrl": "https://mashawerr-api.onrender.com/uploads/pod/delivery_main.jpg",
  "items": [
    {
      "product": "65b10f229...",
      "name": "قميص قطني فاخر",
      "price": 5.0,
      "quantity": 2,
      "subtotal": 10.0,
      "productImage": "https://mashawerr-api.onrender.com/uploads/products/shirt.jpg",
      "pickupPhotoUrl": "https://mashawerr-api.onrender.com/uploads/pod/pickup_shirt.jpg",
      "deliveryPhotoUrl": "https://mashawerr-api.onrender.com/uploads/pod/delivery_shirt.jpg",
      "itemPhotoBefore": "https://mashawerr-api.onrender.com/uploads/pod/pickup_shirt.jpg",
      "itemPhotoAfter": "https://mashawerr-api.onrender.com/uploads/pod/delivery_shirt.jpg"
    },
    {
      "product": "65b10f983...",
      "name": "حذاء رياضي",
      "price": 15.0,
      "quantity": 1,
      "subtotal": 15.0,
      "productImage": "https://mashawerr-api.onrender.com/uploads/products/shoes.jpg",
      "pickupPhotoUrl": null,
      "deliveryPhotoUrl": null
    }
  ]
}
```

---

## 🛠️ 2. نموذج البيانات في فلاتر (Dart Model)

```dart
class OrderItem {
  final String productId;
  final String name;
  final double price;
  final int quantity;
  final double subtotal;
  final String? productImage;
  final String? pickupPhotoUrl;   // صورة الاستلام الخاصة بهذا المنتج
  final String? deliveryPhotoUrl; // صورة التسليم الخاصة بهذا المنتج

  OrderItem({
    required this.productId,
    required this.name,
    required this.price,
    required this.quantity,
    required this.subtotal,
    this.productImage,
    this.pickupPhotoUrl,
    this.deliveryPhotoUrl,
  });

  factory OrderItem.fromJson(Map<String, dynamic> json) {
    return OrderItem(
      productId: json['product']?.toString() ?? json['_id']?.toString() ?? '',
      name: json['name'] ?? 'منتج',
      price: (json['price'] ?? 0).toDouble(),
      quantity: json['quantity'] ?? 1,
      subtotal: (json['subtotal'] ?? 0).toDouble(),
      productImage: json['productImage'] ?? json['image'],
      pickupPhotoUrl: json['pickupPhotoUrl'] ?? json['pickupPhoto'] ?? json['itemPhotoBefore'],
      deliveryPhotoUrl: json['deliveryPhotoUrl'] ?? json['deliveryPhoto'] ?? json['itemPhotoAfter'],
    );
  }
}
```

---

## 🎨 3. كود واجهة فلاتر لعرض الصور تحت كل منتج (Widget UI)

```dart
import 'package:flutter/material';

class ProductItemCard extends StatelessWidget {
  final OrderItem item;

  const ProductItemCard({Key? key, required this.item}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(14.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 🛍️ صف بيانات المنتج الرئيسي
            Row(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: item.productImage != null && item.productImage!.isNotEmpty
                      ? Image.network(
                          item.productImage!,
                          width: 54,
                          height: 54,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => _buildPlaceholder(),
                        )
                      : _buildPlaceholder(),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item.name,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'الكمية: x${item.quantity}',
                        style: TextStyle(color: Colors.grey[700], fontSize: 13),
                      ),
                    ],
                  ),
                ),
                Text(
                  '${item.subtotal.toStringAsFixed(3)} د.ك',
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                    color: Colors.green,
                  ),
                ),
              ],
            ),

            // 📷 صور إثبات التوصيل للمنتج (استلام وتسليم)
            if (item.pickupPhotoUrl != null || item.deliveryPhotoUrl != null) ...[
              const SizedBox(height: 12),
              const Divider(height: 1),
              const SizedBox(height: 10),
              const Text(
                '📷 صور التوصيل لهذا المنتج:',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 13,
                  color: Colors.amber,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  // 🟢 صورة الاستلام (قبل)
                  if (item.pickupPhotoUrl != null)
                    Expanded(
                      child: Column(
                        children: [
                          const Text(
                            'صورة الاستلام (قبل)',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(height: 4),
                          GestureDetector(
                            onTap: () => _showFullImage(context, item.pickupPhotoUrl!),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: Image.network(
                                item.pickupPhotoUrl!,
                                height: 110,
                                width: double.infinity,
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),

                  if (item.pickupPhotoUrl != null && item.deliveryPhotoUrl != null)
                    const SizedBox(width: 8),

                  // 🔵 صورة التسليم (بعد)
                  if (item.deliveryPhotoUrl != null)
                    Expanded(
                      child: Column(
                        children: [
                          const Text(
                            'صورة التسليم (بعد)',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(height: 4),
                          GestureDetector(
                            onTap: () => _showFullImage(context, item.deliveryPhotoUrl!),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: Image.network(
                                item.deliveryPhotoUrl!,
                                height: 110,
                                width: double.infinity,
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildPlaceholder() {
    return Container(
      width: 54,
      height: 54,
      color: Colors.grey[200],
      child: const Icon(Icons.shopping_bag, color: Colors.grey),
    );
  }

  void _showFullImage(BuildContext context, String imageUrl) {
    showDialog(
      context: context,
      builder: (_) => Dialog(
        child: InteractiveViewer(
          child: Image.network(imageUrl),
        ),
      ),
    );
  }
}
```
