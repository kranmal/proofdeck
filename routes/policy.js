'use strict';
// Sign-in policy: require two-factor sign-in for admins or everyone, and (when single sign-on is set up) stop
// SSO-linked people from using a password. Admins always keep password sign-in, so a broken provider cannot lock
// everyone out. People who sign in through the provider are not asked for our second factor: the provider has
// already done that step.

function install(ctx) {
  const { route, q, str, HttpError, notifier } = ctx;
  const read = () => { try { return { require2fa: 'off', ssoOnly: false, ...JSON.parse(notifier.settings('security_policy') || '{}') }; } catch { return { require2fa: 'off', ssoOnly: false }; } };
  ctx.signInPolicy = read;
  ctx.mustSetup2fa = (u) => {
    if (!u || u.totp_enabled || u.oidc_sub) return false;
    const p = read().require2fa;
    return p === 'all' || (p === 'admins' && u.role === 'admin');
  };

  route('GET', '/api/settings/security', () => read(), { admin: true });
  route('PUT', '/api/settings/security', ({ body }) => {
    const require2fa = str(body.require2fa, 'off');
    if (!['off', 'admins', 'all'].includes(require2fa)) throw new HttpError(400, 'Choose off, admins or everyone');
    const ssoOnly = !!body.ssoOnly;
    if (ssoOnly && !ctx.ssoInfo().enabled) throw new HttpError(400, 'Set up and turn on single sign-on first');
    q('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('security_policy', JSON.stringify({ require2fa, ssoOnly }));
    return { require2fa, ssoOnly };
  }, { admin: true });
}

module.exports = { install };
