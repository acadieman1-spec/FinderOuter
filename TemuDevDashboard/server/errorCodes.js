/**
 * errorCodes.js — Temu Open Platform gateway error reference.
 *
 * Codes and messages are taken from the documented common-error-code table so
 * the dashboard can explain raw gateway failures in plain language instead of
 * showing a bare number.
 */

export const GATEWAY_ERRORS = {
  1000000: { msg: 'SUCCESS', meaning: 'Request accepted.', hint: 'No action needed.' },
  2000000: { msg: 'BUSINESS_EXCEPTION', meaning: 'Calling the internal API failed.', hint: 'Usually transient — retry, then check the endpoint params.' },
  3000000: { msg: 'BAD_PARAMS', meaning: 'Bad parameters.', hint: 'Check required business params for this type.' },
  3000001: { msg: 'SIGN_UNVALID', meaning: 'Sign invalid.', hint: 'Recalculate sign: sort all params by key, wrap with app_secret head+tail, MD5, upper-case.' },
  3000002: { msg: 'there is no type in body.', meaning: 'API type is missing.', hint: 'Add "type": e.g. bg.order.list.v2.get.' },
  3000003: { msg: 'type not exists', meaning: 'API type does not exist.', hint: 'Verify the endpoint name against the catalogue.' },
  3000004: { msg: 'type has been sunset', meaning: 'API type retired.', hint: 'Migrate to the current version of this endpoint.' },
  3000010: { msg: 'there is no timestamp in body.', meaning: 'timestamp is missing.', hint: 'Send Unix seconds (10 digits).' },
  3000011: { msg: 'timestamp is invalid.', meaning: 'timestamp is in the future.', hint: 'Clock skew: must be within ±300s of server time.' },
  3000012: { msg: 'timestamp is expired.', meaning: 'timestamp is too old.', hint: 'Must be within 300 seconds of now; sync your clock (NTP).' },
  3000013: { msg: 'there is no data_type in body.', meaning: 'data_type is missing.', hint: 'Send "data_type": "JSON".' },
  3000014: { msg: 'data_type is invalid', meaning: 'data_type value not accepted.', hint: 'Only "JSON" (case-insensitive) is supported.' },
  3000019: { msg: 'there is no client_id in body.', meaning: 'app_key is missing.', hint: 'Add app_key from the Partner Platform app.' },
  3000020: { msg: 'client_id not exists.', meaning: 'app_key unknown.', hint: 'Check the key and the regional host (US/EU/Global) it belongs to.' },
  3000021: { msg: "client_id don't have this api permission.", meaning: 'app_key lacks permission for this type.', hint: 'Request the API scope for your app in the Partner Platform.' },
  3000022: { msg: 'client_id have been suspended', meaning: 'App suspended.', hint: 'Contact Temu partner support to restore the app.' },
  3000025: { msg: 'there is no app_key in body.', meaning: 'app_key is missing.', hint: 'Add app_key to the request body.' },
  3000026: { msg: 'app_key not exists.', meaning: 'app_key unknown.', hint: 'Verify the app_key/region pairing.' },
  3000027: { msg: "app_key don't have this api permission.", meaning: 'app_key lacks permission for this type.', hint: 'Add the scope in the Partner Platform.' },
  3000028: { msg: 'app_key have been suspended', meaning: 'App suspended.', hint: 'Contact Temu partner support.' },
  3000030: { msg: 'there is no access_token in body.', meaning: 'access_token is missing.', hint: 'Add the seller-authorised access_token.' },
  3000031: { msg: 'access_token not exists.', meaning: 'access_token unknown.', hint: 'Generate a fresh token via bg.open.accesstoken.create.' },
  3000032: { msg: "access_token don't have this api access", meaning: 'Token not authorised for this API.', hint: 'Ask the seller to authorise this API scope, then refresh the token.' },
  3000033: { msg: 'access_token and app_key are not mapping.', meaning: 'Token belongs to a different app.', hint: 'Use the token issued for this app_key.' },
  3000034: { msg: 'access_token is expired or have been refreshed', meaning: 'Token expired or rotated.', hint: 'Re-run the authorisation flow and store the new token.' },
  3000040: { msg: 'there is no sign in body.', meaning: 'sign is missing.', hint: 'Include the MD5 signature in the body.' },
  4000000: { msg: 'SYSTEM_EXCEPTION', meaning: 'Temu-side system error.', hint: 'Retry with backoff; it is not your payload.' },
  4000004: { msg: 'RATE_LIMIT_EXCEED_EXCEPTION', meaning: 'Rate limit exceeded.', hint: 'Default is 20 QPS per app_key — throttle or request a higher quota.' },
  5000000: { msg: 'AUTHORIZE_NOT_ALLOW', meaning: 'Merchant not authorised / token check failed.', hint: 'Re-authorise the app in the seller center.' },
  5000001: { msg: 'ROUTER_NOT_ALLOW', meaning: 'File-upload route must contain "upload".', hint: 'Upload endpoints use a different route.' },
  5000002: { msg: 'NOT_SUPPORT_STAGING_ENV', meaning: 'Not the formal environment.', hint: 'Check the request header environment.' },
  5000003: { msg: 'NOT_IN_IP_WHITE_LIST', meaning: 'Requesting IP not whitelisted.', hint: 'Add the server IP in the Partner Platform app settings.' },
  6000001: { msg: 'RPC_INTERFACE_NOT_FOUND', meaning: 'Internal API missing.', hint: 'Likely an endpoint-name typo.' },
  7000000: { msg: 'BUSINESS_SERVICE_ERROR', meaning: 'Business service error.', hint: 'Retry; if persistent, contact partner support.' },
};

/** Error codes worth retrying with backoff. */
export const RETRYABLE = new Set([2000000, 4000004, 4000000, 7000000]);

/** Decode a gateway/business error code into something a human can act on. */
export function decodeError(errorCode, errorMsg, extraTable) {
  if (errorCode === undefined || errorCode === null) return null;
  const code = Number(errorCode);
  if (!Number.isFinite(code) || code === 1000000) return null;

  const known = GATEWAY_ERRORS[code];
  const business = Array.isArray(extraTable) ? extraTable.find((e) => Number(e.code) === code) : null;

  return {
    code,
    raw: errorMsg || known?.msg || business?.message || '',
    meaning: known?.meaning || business?.message || 'Endpoint-specific error.',
    hint: known?.hint || 'See the endpoint documentation for this error code.',
    scope: known ? 'gateway' : business ? 'endpoint' : 'unknown',
    retryable: RETRYABLE.has(code) || code === 4000000,
  };
}

export function isRetryable(errorCode) {
  const code = Number(errorCode);
  return code === 2000000 || code === 4000000 || code === 7000000;
}
