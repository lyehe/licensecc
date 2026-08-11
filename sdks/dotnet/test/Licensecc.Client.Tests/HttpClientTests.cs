using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Licensecc.Client;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests
{
    /// <summary>
    /// Tests the thin HTTP wrapper against a stubbed HttpMessageHandler (no network). Confirms the
    /// request path, JSON body, bearer header, and the flat {ok, code, ...} response parsing for the
    /// six client-facing endpoints.
    /// </summary>
    [TestClass]
    public sealed class HttpClientTests
    {
        private sealed class StubHandler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, (HttpStatusCode, string)> _respond;
            public HttpRequestMessage? LastRequest { get; private set; }
            public string? LastBody { get; private set; }
            public int Calls { get; private set; }

            public StubHandler(Func<HttpRequestMessage, (HttpStatusCode, string)> respond)
            {
                _respond = respond;
            }

            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Calls++;
                LastRequest = request;
                LastBody = request.Content == null ? null : await request.Content.ReadAsStringAsync().ConfigureAwait(false);
                (HttpStatusCode status, string body) = _respond(request);
                return new HttpResponseMessage(status)
                {
                    Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
                };
            }
        }

        [TestMethod]
        public async Task VerifyAsync_PostsToV1Verify_ParsesAssertion()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK,
                "{\"ok\":true,\"code\":\"entitlement_ok\",\"assertion\":\"lccoa1.aaa.bbb\",\"server_time\":1700}"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com");

            IReadOnlyDictionary<string, object?> body = RequestBody.New()
                .Set("project", "DEFAULT")
                .Set("feature", "EXPORT")
                .Set("license_fingerprint", new string('a', 64))
                .Set("nonce", new string('c', 64))
                .Build();

            BackendResponse response = await client.VerifyAsync(body);

            Assert.AreEqual("https://verifier.example.com/v1/verify", handler.LastRequest!.RequestUri!.ToString());
            Assert.AreEqual(HttpMethod.Post, handler.LastRequest!.Method);
            StringAssert.Contains(handler.LastBody!, "\"project\":\"DEFAULT\"");
            StringAssert.Contains(handler.LastBody!, "\"license_fingerprint\":\"" + new string('a', 64) + "\"");
            Assert.IsTrue(response.Ok);
            Assert.AreEqual("entitlement_ok", response.Code);
            Assert.AreEqual("lccoa1.aaa.bbb", response.GetString("assertion"));
            Assert.AreEqual(1700L, response.GetInt64("server_time"));
        }

        [TestMethod]
        public async Task VerifyAsync_SoftDenial_Returns200WithOkFalse()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK,
                "{\"ok\":false,\"code\":\"entitlement_denied\",\"server_time\":1700}"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com");

            BackendResponse response = await client.VerifyAsync(RequestBody.New().Build());
            Assert.AreEqual(200, response.HttpStatus);
            Assert.IsFalse(response.Ok);
            Assert.AreEqual("entitlement_denied", response.Code);
        }

        [TestMethod]
        public async Task ActivateAsync_AppliesBearerHeader_AndPostsToV1Activate()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK,
                "{\"ok\":true,\"lic\":\"<v201 lease>\",\"server_time\":1700,\"renew_by\":1800,\"valid_to_epoch\":2000}"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com")
            {
                AuthorizationBearer = "lcca_secret",
            };

            BackendResponse response = await client.ActivateAsync(RequestBody.New()
                .Set("project", "DEFAULT").Set("feature", "EXPORT")
                .Set("license_fingerprint", new string('a', 64))
                .Set("device_key_id", "sha256:" + new string('1', 64))
                .Build());

            Assert.AreEqual("https://verifier.example.com/v1/activate", handler.LastRequest!.RequestUri!.ToString());
            Assert.IsTrue(handler.LastRequest!.Headers.TryGetValues("Authorization", out IEnumerable<string>? auth));
            Assert.AreEqual("Bearer lcca_secret", System.Linq.Enumerable.First(auth!));
            Assert.IsTrue(response.Ok);
            Assert.AreEqual("<v201 lease>", response.GetString("lic"));
        }

        [TestMethod]
        public async Task MeterAsync_PostsExactBody_AppliesBearer_AndParsesSoftDenial()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK,
                "{\"ok\":false,\"code\":\"quota_exceeded\",\"units_consumed\":5,\"quota\":5}"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com")
            {
                AuthorizationBearer = "lcca_secret",
            };

            IReadOnlyDictionary<string, object?> body = RequestBody.New()
                .Set("project", "DEFAULT")
                .Set("feature", "EXPORT")
                .Set("license_fingerprint", new string('a', 64))
                .Set("units", 3)
                .Build();

            BackendResponse response = await client.MeterAsync(body);

            Assert.AreEqual("https://verifier.example.com/v1/meter", handler.LastRequest!.RequestUri!.ToString());
            Assert.AreEqual(HttpMethod.Post, handler.LastRequest!.Method);
            using (JsonDocument document = JsonDocument.Parse(handler.LastBody!))
            {
                JsonElement root = document.RootElement;
                Assert.AreEqual("DEFAULT", root.GetProperty("project").GetString());
                Assert.AreEqual("EXPORT", root.GetProperty("feature").GetString());
                Assert.AreEqual(new string('a', 64), root.GetProperty("license_fingerprint").GetString());
                Assert.AreEqual(3, root.GetProperty("units").GetInt32());
            }
            Assert.IsTrue(handler.LastRequest.Headers.TryGetValues("Authorization", out IEnumerable<string>? auth));
            Assert.AreEqual("Bearer lcca_secret", System.Linq.Enumerable.First(auth!));
            Assert.IsFalse(response.Ok);
            Assert.AreEqual("quota_exceeded", response.Code);
        }

        [TestMethod]
        public async Task ReportAsync_GetsExactQuery_AppliesBearer_AndParsesFlatResponse()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK,
                "{\"ok\":true,\"project\":\"DEFAULT\",\"feature\":\"EXPORT\",\"from\":1700,\"to\":1800,\"peak_concurrent\":2}"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com")
            {
                AuthorizationBearer = "lcca_secret",
            };

            BackendResponse response = await client.ReportAsync("DEFAULT", "EXPORT", new string('a', 64), 1700, 1800);

            Assert.AreEqual(
                "https://verifier.example.com/v1/admin/report?project=DEFAULT&feature=EXPORT&license_fingerprint=" + new string('a', 64) + "&from=1700&to=1800",
                handler.LastRequest!.RequestUri!.ToString());
            Assert.AreEqual(HttpMethod.Get, handler.LastRequest!.Method);
            Assert.IsNull(handler.LastBody);
            Assert.IsTrue(handler.LastRequest.Headers.TryGetValues("Authorization", out IEnumerable<string>? auth));
            Assert.AreEqual("Bearer lcca_secret", System.Linq.Enumerable.First(auth!));
            Assert.IsTrue(response.Ok);
            Assert.AreEqual(2L, response.GetInt64("peak_concurrent"));
        }

        [TestMethod]
        public async Task ReportAsync_DoesNotRetryAndParsesMalformedBody()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.BadGateway, "<html>502 Bad Gateway</html>"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com");

            BackendResponse response = await client.ReportAsync("DEFAULT", "EXPORT", new string('a', 64));

            Assert.AreEqual(1, handler.Calls);
            Assert.AreEqual(502, response.HttpStatus);
            Assert.IsFalse(response.Ok);
            Assert.AreEqual("malformed_response", response.Code);
        }

        [TestMethod]
        public async Task AllSeatEndpoints_RouteToDocumentedPaths()
        {
            var routed = new List<string>();
            var handler = new StubHandler(req =>
            {
                routed.Add(req.RequestUri!.AbsolutePath);
                return (HttpStatusCode.OK, "{\"ok\":true,\"server_time\":1}");
            });
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com");
            IReadOnlyDictionary<string, object?> body = RequestBody.New().Set("seat_id", "abc").Build();

            await client.RenewAsync(body);
            await client.CheckoutAsync(body);
            await client.HeartbeatAsync(body);
            await client.ReleaseAsync(body);

            CollectionAssert.AreEqual(
                new[] { "/v1/renew", "/v1/checkout", "/v1/heartbeat", "/v1/release" },
                routed);
        }

        [TestMethod]
        public async Task MalformedResponseBody_DoesNotThrow_ReturnsSyntheticCode()
        {
            var handler = new StubHandler(_ => (HttpStatusCode.BadGateway, "<html>502 Bad Gateway</html>"));
            using var http = new HttpClient(handler);
            var client = new LicensingBackendClient(http, "https://verifier.example.com");

            BackendResponse response = await client.VerifyAsync(RequestBody.New().Build());
            Assert.AreEqual(502, response.HttpStatus);
            Assert.IsFalse(response.Ok);
            Assert.AreEqual("malformed_response", response.Code);
        }
    }
}
