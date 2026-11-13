'use strict';
// OpenID Connect sign-in (authorization code flow with PKCE): discovery, ID token checks, nothing else.
// Only RS256 and ES256 signatures are accepted. "none" and shared-secret algorithms are refused.

const crypto = require('node:crypto');

const cache = new Map(); // url -> { at, value }
async function getJson(url, ttl = 600000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const value = await res.json();
  cache.set(url, { at: Date.now(), value });
  return value;
}

async function discover(issuer) {
  const base = issuer.replace(/\/+$/, '');
  const doc = await getJson(`${base}/.well-known/openid-configuration`);
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!doc[k]) throw new Error(`The provider's discovery document has no ${k}`);
  if (doc.issuer.replace(/\/+$/, '') !== base) throw new Error('The provider reports a different issuer than the address you entered');
  return doc;
}

const b64u = (s) => Buffer.from(s, 'base64url');
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

// Throws with a readable reason; returns the claims when everything checks out.
async function verifyIdToken(token, { issuer, jwksUri, clientId, nonce, now = Date.now() }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('The ID token is malformed');
  let header, claims;
  try { header = JSON.parse(b64u(parts[0])); claims = JSON.parse(b64u(parts[1])); } catch { throw new Error('The ID token is malformed'); }
  if (!['RS256', 'ES256'].includes(header.alg)) throw new Error(`The ID token uses an unsupported signature (${header.alg})`);
  let jwks = await getJson(jwksUri, 300000);
  let jwk = (jwks.keys || []).find((k) => k.kid === header.kid && (!k.use || k.use === 'sig')) || (!header.kid && (jwks.keys || []).length === 1 ? jwks.keys[0] : null);
  if (!jwk) { cache.delete(jwksUri); jwks = await getJson(jwksUri, 300000); jwk = (jwks.keys || []).find((k) => k.kid === header.kid); } // keys may have rotated
  if (!jwk) throw new Error('The ID token is signed with a key the provider does not publish');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, b64u(parts[2]));
  if (!ok) throw new Error('The ID token signature is not valid');
  if (String(claims.iss || '').replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new Error('The ID token was issued by someone else');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('The ID token is for a different application');
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new Error('The ID token was issued to a different application');
  if (!(claims.exp * 1000 > now - 60000)) throw new Error('The ID token has expired');
  if (claims.nbf && claims.nbf * 1000 > now + 60000) throw new Error('The ID token is not valid yet');
  if (!claims.sub) throw new Error('The ID token has no subject');
  if (claims.nonce !== nonce) throw new Error('The ID token does not belong to this sign-in attempt');
  return claims;
}

module.exports = { discover, verifyIdToken, pkceChallenge, getJson, clearCache: () => cache.clear() };
