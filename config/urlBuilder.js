/**
 * Builds a full public URL for an uploaded file.
 *
 * Priority order:
 *  1. process.env.HOST  – set this in Render/server env vars to:
 *       https://mashawerr.onrender.com
 *  2. x-forwarded-proto header – Render & most reverse proxies set this,
 *     so we get "https" even though req.protocol itself says "http".
 *  3. Fallback: req.protocol + host (works in local dev).
 *
 * If `img` is already an absolute URL it is returned as-is.
 * If `img` is null/undefined, null is returned.
 *
 * @param {import('express').Request} req
 * @param {string|null|undefined} img  Relative path (e.g. "profiles/foo.png") OR absolute URL
 * @param {string} [prefix='/uploads'] Path segment between base and img
 * @returns {string|null}
 */
function buildUrl(req, img, prefix = '/uploads') {
    if (!img) return null;

    // Already an absolute URL – return as-is
    if (img.startsWith('http://') || img.startsWith('https://')) return img;

    // 1. Explicit HOST env var (set this on Render!)
    if (process.env.HOST) {
        const base = process.env.HOST.replace(/\/$/, '');
        return `${base}${prefix}/${img}`;
    }

    // 2. Forwarded protocol header (Render / nginx / any reverse proxy)
    const forwardedProto = req?.headers ? req.headers['x-forwarded-proto'] : null;
    const proto = forwardedProto
        ? forwardedProto.split(',')[0].trim()   // take first value if multiple
        : (req?.protocol || 'https');

    // 3. Forwarded host (optional – rare, but handles proxied hosts)
    const host = req?.headers?.['x-forwarded-host'] || (typeof req?.get === 'function' ? req.get('host') : 'mashawerr.onrender.com');

    return `${proto}://${host}${prefix}/${img}`;
}

module.exports = { buildUrl };
