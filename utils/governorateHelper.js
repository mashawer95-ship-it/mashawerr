/**
 * utils/governorateHelper.js
 * Comprehensive normalization and detection for Egyptian governorates.
 */

'use strict';

const EGYPT_GOVERNORATES = [
    { name: 'سوهاج', keywords: ['سوهاج', 'sohag', 'جرجا', 'طهطا', 'المراغة', 'اخميم', 'طما', 'المنشاة', 'البلينا', 'ساقلتة', 'جهينة', 'دار السلام'] },
    { name: 'القاهرة', keywords: ['القاهرة', 'القاهره', 'cairo', 'المعادي', 'مدينة نصر', 'التجمع', 'مصر الجديدة', 'الزمالك', 'شبرا'] },
    { name: 'الجيزة', keywords: ['الجيزة', 'الجيزه', 'giza', 'الدقي', 'المهندسين', 'الهرم', 'فيصل', 'أكتوبر', 'اكتوبر', 'زايد'] },
    { name: 'الإسكندرية', keywords: ['الإسكندرية', 'الاسكندرية', 'الإسكندريه', 'الاسكندريه', 'alexandria', 'alex', 'سموحة', 'ميامي'] },
    { name: 'الدقهلية', keywords: ['الدقهلية', 'الدقهليه', 'dakahlia', 'mansoura', 'المنصورة', 'المنصوره'] },
    { name: 'البحر الأحمر', keywords: ['البحر الأحمر', 'البحر الاحمر', 'red sea', 'hurghada', 'الغردقة', 'الغردقه', 'الجونة'] },
    { name: 'البحيرة', keywords: ['البحيرة', 'البحيره', 'beheira', 'damanhur', 'دمنهور'] },
    { name: 'الفيوم', keywords: ['الفيوم', 'fayoum', 'faiyum'] },
    { name: 'الغربية', keywords: ['الغربية', 'الغربيه', 'gharbia', 'tanta', 'طنطا', 'المحلة'] },
    { name: 'الإسماعيلية', keywords: ['الإسماعيلية', 'الاسماعيلية', 'الإسماعيليه', 'الاسماعيليه', 'ismailia'] },
    { name: 'المنوفية', keywords: ['المنوفية', 'المنوفيه', 'monufia', 'menofia', 'شبين الكوم', 'قويسنا', 'منوف'] },
    { name: 'المنيا', keywords: ['المنيا', 'minya', 'ملوي', 'مغاغة'] },
    { name: 'القليوبية', keywords: ['القليوبية', 'القليوبيه', 'qalyubia', 'بنها', 'شبرا الخيمة', 'قليوب'] },
    { name: 'الوادي الجديد', keywords: ['الوادي الجديد', 'new valley', 'الخارجة', 'الداخلة'] },
    { name: 'السويس', keywords: ['السويس', 'suez'] },
    { name: 'أسوان', keywords: ['أسوان', 'اسوان', 'aswan', 'إدفو', 'كوم امبو'] },
    { name: 'أسيوط', keywords: ['أسيوط', 'اسيوط', 'assiut', 'asyut', 'ديروط', 'منفلوط'] },
    { name: 'بني سويف', keywords: ['بني سويف', 'beni suef', 'الواسطى'] },
    { name: 'بورسعيد', keywords: ['بورسعيد', 'port said', 'بورفؤاد'] },
    { name: 'دمياط', keywords: ['دمياط', 'damietta', 'رأس البر'] },
    { name: 'الشرقية', keywords: ['الشرقية', 'الشرقيه', 'sharqia', 'zagazig', 'الزقازيق', 'العاشر من رمضان'] },
    { name: 'جنوب سيناء', keywords: ['جنوب سيناء', 'south sinai', 'sharm', 'شرم الشيخ', 'دهب', 'نويبع', 'طابا'] },
    { name: 'كفر الشيخ', keywords: ['كفر الشيخ', 'kafr el sheikh', 'kafr el-sheikh', 'دسوق'] },
    { name: 'مطروح', keywords: ['مطروح', 'مرسى مطروح', 'matrouh', 'الساحل الشمالي', 'العلمين'] },
    { name: 'قنا', keywords: ['قنا', 'qena', 'نجع حمادي', 'قوص'] },
    { name: 'شمال سيناء', keywords: ['شمال سيناء', 'north sinai', 'arish', 'العريش'] },
    { name: 'الأقصر', keywords: ['الأقصر', 'الاقصر', 'luxor', 'إسنا', 'ارمنت'] },
];

/**
 * Normalizes Egyptian governorate names for accurate comparison
 * (strips "محافظة", normalizes alef, taa marbuta, yaa, diacritics, whitespace)
 */
function normalizeGovernorate(gov) {
    if (!gov || typeof gov !== 'string') return '';
    return gov
        .trim()
        .toLowerCase()
        .replace(/محافظ[ةه]\s*/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[\u064B-\u065F]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

/**
 * Detects Egyptian governorate from arbitrary address or text.
 * Returns the standardized Arabic governorate name or null.
 */
function detectGovernorateFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase();
    const normalized = normalizeGovernorate(text);

    for (const gov of EGYPT_GOVERNORATES) {
        const normGovName = normalizeGovernorate(gov.name);
        if (normalized.includes(normGovName)) {
            return gov.name;
        }
        for (const kw of gov.keywords) {
            const normKw = normalizeGovernorate(kw);
            if (normKw && normalized.includes(normKw)) {
                return gov.name;
            }
            if (lower.includes(kw.toLowerCase())) {
                return gov.name;
            }
        }
    }
    return null;
}

module.exports = {
    EGYPT_GOVERNORATES,
    normalizeGovernorate,
    detectGovernorateFromText,
};
