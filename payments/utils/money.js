/**
 * payments/utils/money.js
 * Safe integer-based money utilities for EGP amounts.
 *
 * Conversion table:
 *   1 EGP = 1000 fils (DB internal unit, milli-EGP)
 *   1 EGP = 100 piastres (Paymob's "amount_cents")
 *   1 piastre = 10 fils
 *
 * So: fils → piastres: divide by 10 (integer division)
 *     piastres → fils: multiply by 10
 */

'use strict';

const { EGP_PIASTRES_PER_UNIT } = require('../constants/paymentConstants');

/** 1 EGP stored in DB = 1000 fils */
const FILS_PER_EGP = 1000;

/** 1 EGP = 100 piastres (Paymob unit) */
const PIASTRES_PER_EGP = EGP_PIASTRES_PER_UNIT;

/** 1 piastre = 10 fils */
const FILS_PER_PIASTRE = 10;

/**
 * Convert a DB fils amount to Paymob piastres.
 * filsToEgpPiastres(50000) → 5000 piastres (50 EGP)
 * filsToEgpPiastres(1500)  → 150 piastres (1.5 EGP)
 *
 * @param {number} fils - Non-negative integer
 * @returns {number} Integer piastres
 */
function filsToEgpPiastres(fils) {
    if (typeof fils !== 'number' || !isFinite(fils) || fils < 0) {
        throw new Error(`[money] Invalid fils amount: ${fils}`);
    }
    const piastres = Math.round(fils / FILS_PER_PIASTRE);
    if (piastres < 1) {
        throw new Error(`[money] Amount too small after conversion: ${fils} fils → ${piastres} piastres`);
    }
    return piastres;
}

/** Alias: more explicit name */
const filsToPiastres = filsToEgpPiastres;

/**
 * Convert a plain EGP decimal amount to integer piastres.
 * egpToPiastres(50.00) → 5000
 *
 * @param {number} egp
 * @returns {number} Integer piastres
 */
function egpToPiastres(egp) {
    if (typeof egp !== 'number' || !isFinite(egp) || egp < 0) {
        throw new Error(`[money] Invalid EGP amount: ${egp}`);
    }
    return Math.round(egp * PIASTRES_PER_EGP);
}

/**
 * Convert Paymob piastres back to DB fils.
 * piastresToFils(5000) → 50000 fils
 *
 * @param {number} piastres - Integer
 * @returns {number} Integer fils
 */
function piastresToFils(piastres) {
    if (!Number.isInteger(piastres) || piastres < 0) {
        throw new Error(`[money] Invalid piastres: ${piastres}`);
    }
    return piastres * FILS_PER_PIASTRE;
}

/**
 * Convert piastres to EGP decimal (display only — never use for calculations).
 * @param {number} piastres
 * @returns {number} EGP with 2 decimal places
 */
function piastresToEgp(piastres) {
    return Number((piastres / PIASTRES_PER_EGP).toFixed(2));
}

/**
 * Convert fils to EGP decimal (display only).
 * @param {number} fils
 * @returns {number} EGP with 3 decimal places
 */
function filsToEgp(fils) {
    return Number((fils / FILS_PER_EGP).toFixed(3));
}

/**
 * Validate a piastres amount is a positive integer.
 * @param {number} piastres
 * @returns {boolean}
 */
function isValidPiastres(piastres) {
    return Number.isInteger(piastres) && piastres > 0;
}

/**
 * Validate a fils amount is a positive integer.
 * @param {number} fils
 * @returns {boolean}
 */
function isValidFils(fils) {
    return Number.isInteger(fils) && fils > 0;
}

module.exports = {
    filsToEgpPiastres,
    filsToPiastres,    // alias
    piastresToFils,
    egpToPiastres,
    piastresToEgp,
    filsToEgp,
    isValidPiastres,
    isValidFils,
    FILS_PER_EGP,
    PIASTRES_PER_EGP,
    FILS_PER_PIASTRE,
};
