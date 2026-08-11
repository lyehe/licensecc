using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Licensecc.Client
{
    /// <summary>
    /// The parsed flat <c>{ ok, code?, ... }</c> response every client-facing licensing-backend
    /// endpoint returns. <see cref="Fields"/> exposes the full decoded JSON object so callers can read
    /// endpoint-specific fields (e.g. <c>assertion</c>, <c>lic</c>, <c>seat_id</c>, <c>server_time</c>).
    /// </summary>
    public sealed class BackendResponse
    {
        internal BackendResponse(int httpStatus, bool ok, string? code, IReadOnlyDictionary<string, object?> fields, string rawBody)
        {
            HttpStatus = httpStatus;
            Ok = ok;
            Code = code;
            Fields = fields;
            RawBody = rawBody;
        }

        /// <summary>The HTTP status code. Note: some endpoints return 200 with <c>ok:false</c> (soft denial).</summary>
        public int HttpStatus { get; }

        /// <summary>The <c>ok</c> flag from the body. False on any soft/hard denial.</summary>
        public bool Ok { get; }

        /// <summary>The machine-readable <c>code</c> (e.g. <c>entitlement_ok</c>, <c>entitlement_denied</c>), or null.</summary>
        public string? Code { get; }

        /// <summary>The full decoded JSON body. Numbers are <c>double</c>; strings/bools/nulls as-is.</summary>
        public IReadOnlyDictionary<string, object?> Fields { get; }

        /// <summary>The raw response body text (for diagnostics).</summary>
        public string RawBody { get; }

        /// <summary>Convenience: read a string field (e.g. <c>assertion</c>, <c>lic</c>) or null.</summary>
        public string? GetString(string key) =>
            Fields.TryGetValue(key, out object? v) ? v as string : null;

        /// <summary>Convenience: read an integer field (e.g. <c>server_time</c>) or null.</summary>
        public long? GetInt64(string key) =>
            Fields.TryGetValue(key, out object? v) && v is double d ? (long?)d : null;
    }

    /// <summary>
    /// A thin, hand-written wrapper over the licensecc licensing-backend HTTP API
    /// (<c>services/cloudflare-licensing-backend</c>). Each method POSTs the documented JSON body and
    /// returns the flat <see cref="BackendResponse"/>. This wrapper covers the HTTP + token contract
    /// ONLY — it performs no binary anti-tamper or hardware fingerprinting (those stay in the C++ SDK).
    ///
    /// Auth headers (Authorization: Bearer, request-proof fields, etc.) are the caller's responsibility:
    /// pass account-token bearer via <see cref="AuthorizationBearer"/>, and include request-proof fields
    /// directly in the body dictionaries where the endpoint accepts them.
    /// </summary>
    public sealed class LicensingBackendClient
    {
        private readonly HttpClient _http;
        private readonly Uri _baseUri;

        /// <summary>Optional <c>Authorization: Bearer &lt;token&gt;</c> applied to lease/seat/report calls.</summary>
        public string? AuthorizationBearer { get; set; }

        /// <summary>
        /// Construct against a base URL (e.g. <c>https://licensecc-online-verifier.example.workers.dev</c>).
        /// The caller owns the <see cref="HttpClient"/> lifetime; this wrapper does not dispose it.
        /// </summary>
        public LicensingBackendClient(HttpClient httpClient, string baseUrl)
        {
            _http = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
            if (string.IsNullOrEmpty(baseUrl))
            {
                throw new ArgumentException("baseUrl is required", nameof(baseUrl));
            }

            _baseUri = new Uri(baseUrl.TrimEnd('/') + "/", UriKind.Absolute);
        }

        /// <summary>POST /v1/verify — client-facing online verification; returns a signed lccoa1
        /// assertion (ok:true, code:entitlement_ok) or a denial. 200 may carry ok:false (soft denial).</summary>
        public Task<BackendResponse> VerifyAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/verify", body, applyBearer: false, ct);

        /// <summary>POST /v1/activate — hardware-bound sliding-window lease issuance (v201). Returns a
        /// signed lease in the <c>lic</c> field on success.</summary>
        public Task<BackendResponse> ActivateAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/activate", body, applyBearer: true, ct);

        /// <summary>POST /v1/renew — hardware-bound lease renewal (v201).</summary>
        public Task<BackendResponse> RenewAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/renew", body, applyBearer: true, ct);

        /// <summary>POST /v1/checkout — concurrent/floating seat checkout; returns a short-TTL lccoa1
        /// assertion plus <c>seat_id</c>.</summary>
        public Task<BackendResponse> CheckoutAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/checkout", body, applyBearer: true, ct);

        /// <summary>POST /v1/heartbeat — renew a live seat's heartbeat deadline; returns an updated assertion.</summary>
        public Task<BackendResponse> HeartbeatAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/heartbeat", body, applyBearer: true, ct);

        /// <summary>POST /v1/release — release a seat (idempotent).</summary>
        public Task<BackendResponse> ReleaseAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/release", body, applyBearer: true, ct);

        /// <summary>POST /v1/meter — record metered units for an entitlement. The body follows the
        /// MeterRequest schema; the account bearer is applied to this report-scoped operation.</summary>
        public Task<BackendResponse> MeterAsync(IReadOnlyDictionary<string, object?> body, CancellationToken ct = default) =>
            PostAsync("v1/meter", body, applyBearer: true, ct);

        /// <summary>GET /v1/admin/report — return the usage summary for an entitlement over an
        /// optional Unix-second window. The flat response remains a BackendResponse so endpoint-specific
        /// report fields are available through <see cref="BackendResponse.Fields"/>.</summary>
        public Task<BackendResponse> ReportAsync(
            string project,
            string feature,
            string licenseFingerprint,
            long? fromEpoch = null,
            long? toEpoch = null,
            CancellationToken ct = default)
        {
            var query = new Dictionary<string, object?>
            {
                ["project"] = project,
                ["feature"] = feature,
                ["license_fingerprint"] = licenseFingerprint,
                ["from"] = fromEpoch,
                ["to"] = toEpoch,
            };
            return GetAsync("v1/admin/report", query, applyBearer: true, ct);
        }

        /// <summary>
        /// Build the JSON request, POST it, and parse the flat response. Exposed so callers/tests can
        /// hit any endpoint with an arbitrary body.
        /// </summary>
        public async Task<BackendResponse> PostAsync(string relativePath, IReadOnlyDictionary<string, object?> body,
            bool applyBearer, CancellationToken ct = default)
        {
            if (body == null)
            {
                throw new ArgumentNullException(nameof(body));
            }

            string json = Json.Serialize(body);
            using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(_baseUri, relativePath)))
            {
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
                if (applyBearer && !string.IsNullOrEmpty(AuthorizationBearer))
                {
                    request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + AuthorizationBearer);
                }

                using (HttpResponseMessage response = await _http.SendAsync(request, ct).ConfigureAwait(false))
                {
                    string bodyText = await ReadBodyAsync(response).ConfigureAwait(false);
                    return ParseResponse((int)response.StatusCode, bodyText);
                }
            }
        }

        /// <summary>
        /// Build the query string, issue a GET, and parse the flat response. Exposed alongside
        /// <see cref="PostAsync"/> so callers/tests can hit an endpoint with arbitrary query fields.
        /// Null query values are omitted.
        /// </summary>
        public async Task<BackendResponse> GetAsync(string relativePath, IReadOnlyDictionary<string, object?> query,
            bool applyBearer, CancellationToken ct = default)
        {
            if (query == null)
            {
                throw new ArgumentNullException(nameof(query));
            }

            string queryString = BuildQueryString(query);
            string target = relativePath + (queryString.Length == 0 ? string.Empty : "?" + queryString);
            using (var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_baseUri, target)))
            {
                if (applyBearer && !string.IsNullOrEmpty(AuthorizationBearer))
                {
                    request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + AuthorizationBearer);
                }

                using (HttpResponseMessage response = await _http.SendAsync(request, ct).ConfigureAwait(false))
                {
                    string bodyText = await ReadBodyAsync(response).ConfigureAwait(false);
                    return ParseResponse((int)response.StatusCode, bodyText);
                }
            }
        }

        private static string BuildQueryString(IReadOnlyDictionary<string, object?> query)
        {
            var builder = new StringBuilder();
            foreach (KeyValuePair<string, object?> pair in query)
            {
                if (pair.Value == null)
                {
                    continue;
                }

                if (builder.Length > 0)
                {
                    builder.Append('&');
                }
                builder.Append(Uri.EscapeDataString(pair.Key));
                builder.Append('=');
                builder.Append(Uri.EscapeDataString(Convert.ToString(pair.Value, CultureInfo.InvariantCulture) ?? string.Empty));
            }
            return builder.ToString();
        }

        private static async Task<string> ReadBodyAsync(HttpResponseMessage response)
        {
            return await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        }

        internal static BackendResponse ParseResponse(int httpStatus, string bodyText)
        {
            // Fail-soft on a non-JSON body: surface it as ok:false with a synthetic code so the caller
            // never sees an exception from an unexpected gateway/error page.
            object? parsed;
            try
            {
                parsed = Json.Parse(bodyText);
            }
            catch (FormatException)
            {
                var fallback = new Dictionary<string, object?> { ["ok"] = false, ["code"] = "malformed_response" };
                return new BackendResponse(httpStatus, false, "malformed_response", fallback, bodyText);
            }

            if (!(parsed is Dictionary<string, object?> obj))
            {
                var fallback = new Dictionary<string, object?> { ["ok"] = false, ["code"] = "malformed_response" };
                return new BackendResponse(httpStatus, false, "malformed_response", fallback, bodyText);
            }

            bool ok = obj.TryGetValue("ok", out object? okValue) && okValue is bool b && b;
            string? code = obj.TryGetValue("code", out object? codeValue) ? codeValue as string : null;
            return new BackendResponse(httpStatus, ok, code, obj, bodyText);
        }
    }

    /// <summary>
    /// Small fluent builder for request-body dictionaries, so callers can assemble the documented
    /// fields without hand-managing a dictionary. Pure convenience; the wrapper accepts any
    /// IReadOnlyDictionary directly.
    /// </summary>
    public sealed class RequestBody
    {
        private readonly Dictionary<string, object?> _fields = new Dictionary<string, object?>();

        public static RequestBody New() => new RequestBody();

        public RequestBody Set(string key, string? value)
        {
            _fields[key] = value;
            return this;
        }

        public RequestBody Set(string key, long value)
        {
            _fields[key] = value;
            return this;
        }

        public RequestBody Set(string key, bool value)
        {
            _fields[key] = value;
            return this;
        }

        public IReadOnlyDictionary<string, object?> Build() => _fields;
    }
}
