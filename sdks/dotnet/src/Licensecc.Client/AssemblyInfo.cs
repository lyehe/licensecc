using System.Runtime.CompilerServices;

// The test project exercises the shared internal core (canonical base64, parse_uint64, key-id digest)
// directly for fail-closed edge-case parity, in addition to the public verifier surface.
[assembly: InternalsVisibleTo("Licensecc.Client.Tests")]
