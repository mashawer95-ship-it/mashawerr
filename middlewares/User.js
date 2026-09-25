const mongoose = require("mongoose");
const joi = require('joi');

// user schema
const UserSchema = new mongoose.Schema({
    email:{
        type:String,
        required:true,
        trim:true,
        minlength:5,
        maxlength:100,
        unique:true
},
 firstName:{
        type:String,
        required:true,
        trim:true,
        minlength:2,
        maxlength:100,
},
 lastName:{
        type:String,
        required:true,
        trim:true,
        minlength:2,
        maxlength:100,
},
 phone:{
        type:String,
        required:false,
        trim:true,
        minlength:7,
        maxlength:15,
        default: null,
},
 password:{
        type:String,
        required:false,
        trim:true,
        minlength:1,
        default: null,
},
 googleId:{
        type:String,
        default:null,
        unique:true,
        sparse:true,
},
 isProfileCompleted:{
        type:Boolean,
        default:false,
},
 deviceId: {
        type: String,
        default: null,
        trim: true,
        description: 'Physical hardware device ID associated with the user',
},
 governorate: {
        type: String,
        default: null,
        trim: true,
        description: 'المحافظة (محافظات مصر)',
 },
 gender: {
        type: String,
        enum: ['male', 'female', 'ذكر', 'أنثى', null],
        default: 'male',
        trim: true,
        description: 'النوع (ذكر / أنثى)',
 },
 // ─── حالة الحساب الجديدة (Active / Blocked) ──────────────────────────────
 status: {
        type: String,
        enum: ['active', 'blocked'],
        default: 'active',
        description: 'Account status: active or blocked. Blocked users cannot access protected APIs.'
 },
 isAdmin:{
        type:Boolean,
        default:false
},
 userType:{
        type:String,
        default:'NormalUser',
        trim:true,
},
 isVerified:{
        type:Boolean,
        default:false
},
  emailVerificationCode:{
        type:String,
        default:null
},
 emailVerificationExpires:{
        type:Date,
        default:null
},
 emailVerificationTokenHash:{
        type:String,
        default:null,
        index:true
},
 emailVerificationUsed:{
        type:Boolean,
        default:false
},
 otpResendCount:{
        type:Number,
        default:0
},
 otpResendLastAt:{
        type:Date,
        default:null
},
 passwordResetCode: { type: String, default: null },
 passwordResetTokenHash: { type: String, default: null, index: true },
 passwordResetExpires: { type: Date, default: null },
 passwordResetUsed: { type: Boolean, default: false },
 passwordChangedAt: { type: Date, default: null },
 profileImage: { type: String, default: null },
 // ─── حالة الحساب ──────────────────────────────────────────────────────────
 isSuspended: {
        type: Boolean,
        default: false,
        description: 'إذا كانت true، الحساب موقوف ولا يمكن تسجيل الدخول',
 },
 isAvailable: {
        type: Boolean,
        default: false,
        description: 'Representative availability – true = accepting orders, false = offline',
 },
 // ─── بيانات المركبة (للمندوب) ────────────────────────────────────────────
 vehicleNumber:       { type: String, default: null, trim: true },
 vehicleColor:        { type: String, default: null, trim: true },
 vehicleModel:        { type: String, default: null, trim: true },
 vehicleImage:        { type: String, default: null }, // relative path or full URL
 vehicleTypeId:       { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleType', default: null },
 vehicleTypeName:     { type: String, default: null, trim: true },
  preferredOrderTypes: { type: [String], default: ['delivery'] },
  canEditVehicleInfo: {
         type: Boolean,
         default: false,
         description: 'إذا كانت true، يمكن للمندوب تعديل بيانات المركبة حتى لو كانت مكتملة',
  },
 
 // ─── تتبع الموقع الحي (للمناديب الأونلاين) ──────────────────────────────
 lastLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    updatedAt: { type: Date, default: null }
 },

 // ─── Refresh Token Security (Token Family Tracking) ───────────────────────
 // UUID of the current active refresh token family.
 // When a replay attack is detected (reuse of a revoked refresh token),
 // ALL tokens in this family are revoked and this is reset to null.
 refreshTokenFamily: {
     type: String,
     default: null,
     description: 'Active refresh token family UUID – used for replay attack detection',
 }
} ,{timestamps:true});

UserSchema.set('toJSON', {
    transform(_doc, ret) {
        if (typeof ret.userType === 'string') {
            ret.userType = ret.userType.trim();
        }
        if (ret.isAdmin) {
            ret.userType = 'Admin';
        } else if (ret.userType == null || ret.userType === '') {
            ret.userType = 'NormalUser';
        }
        return ret;
    },
});

// User model
const User = mongoose.model("User", UserSchema);
// validate Register user
function validateRegisterUser(object){
    const schema=joi.object({
        firstName: joi.string().trim().min(2).max(100).required(),
        lastName: joi.string().trim().min(2).max(100).required(),
        email: joi.string().trim().min(5).max(100).email().required(),
        phone: joi.string().trim().min(7).max(15).required(),
        password: joi.string().trim().min(6).required(),
        confirmPassword: joi.string().valid(joi.ref('password')).required().messages({
            'any.only': 'Passwords do not match',
        }),
        deviceId: joi.string().trim().allow('', null).optional(),
        fcmToken: joi.string().trim().allow('', null).optional(),
        governorate: joi.string().trim().allow('', null).optional(),
        gender: joi.string().valid('male', 'female', 'ذكر', 'أنثى').allow('', null).optional(),
    }).unknown(true);
    return schema.validate(object);
}
// validate login user
function validateLoginUser(object){
    const schema=joi.object({
        email:joi.string().trim().min(5).max(100).email().required(),
        password:joi.string().trim().min(6).required(),
        deviceId: joi.string().trim().allow('', null).optional(),
        fcmToken: joi.string().trim().allow('', null).optional(),
    }).unknown(true);
    return schema.validate(object);
}
// validate Change Password (by userId + old + new)
function validateChangePasswordByUserId(object) {
    const schema = joi.object({
        userId: joi.string().trim().length(24).pattern(/^[0-9a-fA-F]{24}$/).required().messages({ 'string.pattern.base': 'userId must be a valid 24-character hex id' }),
        oldPassword: joi.string().trim().min(6).required(),
        newPassword: joi.string().trim().min(1).required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate Change Password (single password - e.g. for profile update)
function validateChangePassword(object){
    const schema=joi.object({
        password:joi.string().trim().min(6).required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate verify email (OTP)
function validateVerifyEmail(object) {
    const schema = joi.object({
        email: joi.string().trim().min(5).max(100).email().required(),
        code: joi.string().trim().length(6).pattern(/^\d+$/).required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate resend OTP
function validateResendOtp(object) {
    const schema = joi.object({
        email: joi.string().trim().min(5).max(100).email().required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate forgot password (email only)
function validateForgotPassword(object) {
    const schema = joi.object({
        email: joi.string().trim().min(5).max(100).email().required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate verify reset code (email + OTP)
function validateVerifyResetCode(object) {
    const schema = joi.object({
        email: joi.string().trim().min(5).max(100).email().required(),
        code: joi.string().trim().length(6).pattern(/^\d+$/).required(),
    }).unknown(true);
    return schema.validate(object);
}
// validate reset password (token/resetToken + newPassword + confirmPassword)
function validateResetPassword(object) {
    const schema = joi.object({
        token: joi.string().trim().optional(),
        resetToken: joi.string().trim().optional(),
        newPassword: joi.string().trim().min(6).required(),
        confirmPassword: joi.string().valid(joi.ref('newPassword')).optional().messages({
            'any.only': 'Passwords do not match',
        }),
    }).or('token', 'resetToken').unknown(true);
    return schema.validate(object);
}
// validate Update user
function validateUpdateUser(object){
    const schema=joi.object({
        firstName: joi.string().trim().min(2).max(100),
        lastName: joi.string().trim().min(2).max(100),
        phone: joi.string().trim().min(7).max(15),
        governorate: joi.string().trim().allow('', null).optional(),
        gender: joi.string().valid('male', 'female', 'ذكر', 'أنثى').allow('', null).optional(),
    }).unknown(true);
    return schema.validate(object);
}
module.exports = {
    User,
    validateRegisterUser,
    validateLoginUser,
    validateUpdateUser,
    validateChangePassword,
    validateChangePasswordByUserId,
    validateVerifyEmail,
    validateResendOtp,
    validateForgotPassword,
    validateVerifyResetCode,
    validateResetPassword,
};