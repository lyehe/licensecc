using System;
using System.IO;
using System.Linq;
using System.Reflection;

namespace Licensecc.Client.Tests
{
    /// <summary>
    /// Resolves and reads the repo's golden vectors under <c>test/vectors/</c>. The directory is pinned
    /// at build time via an [AssemblyMetadata("LccTestVectorsDir", ...)] attribute (see the .csproj),
    /// with a relative-path fallback so the tests run from any working directory.
    /// </summary>
    internal static class GoldenVectors
    {
        public static string VectorsDir { get; } = ResolveVectorsDir();

        public static string OnlineDir => Path.Combine(VectorsDir, "online_assertion");
        public static string ConfigDir => Path.Combine(VectorsDir, "config_attestation");

        public static string ReadText(string path) => File.ReadAllText(path);

        public static string ReadTrimmed(string path) => File.ReadAllText(path).Trim();

        /// <summary>Read raw bytes exactly (no trimming) — used for golden.payload byte-equality.</summary>
        public static byte[] ReadBytes(string path) => File.ReadAllBytes(path);

        private static string ResolveVectorsDir()
        {
            string? fromMetadata = typeof(GoldenVectors).Assembly
                .GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(a => a.Key == "LccTestVectorsDir")?.Value;

            if (!string.IsNullOrEmpty(fromMetadata) && Directory.Exists(fromMetadata))
            {
                return fromMetadata!;
            }

            // Fallback: walk up from the test bin dir to find <repo>/test/vectors.
            string dir = AppContext.BaseDirectory;
            for (int i = 0; i < 12 && dir != null; i++)
            {
                string candidate = Path.Combine(dir, "test", "vectors");
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }

                DirectoryInfo? parent = Directory.GetParent(dir);
                dir = parent?.FullName!;
            }

            throw new DirectoryNotFoundException(
                "Could not locate test/vectors. Metadata path: " + (fromMetadata ?? "<none>"));
        }
    }
}
